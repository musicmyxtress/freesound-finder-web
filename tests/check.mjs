// Drives the real page against the real freesound.org in headless Chromium.
// Uses Blake's saved access token (~/.freesound/token.json) and NEVER renews
// it: renewing would retire the desktop app's refresh token. Run the Worker
// first (npm run dev in worker/) and serve the folder on port 8765.
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const token = JSON.parse(readFileSync(homedir() + '/.freesound/token.json', 'utf8')).access_token;
const launch = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (process.platform === 'win32') launch.channel = 'msedge';
const browser = await chromium.launch(launch);
const page = await browser.newPage({ acceptDownloads: true });
// Worker calls go to the local copy (wrangler dev) instead of the live one.
await page.route('https://freesound-finder.report-inbox-worker.workers.dev/**', async route => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' } });
  const r = await fetch('http://localhost:8799' + new URL(req.url()).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8765' }, body: req.postData() });
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Filename', 'Content-Type': r.headers.get('Content-Type') || 'application/json' };
  if (r.headers.get('X-Filename')) headers['X-Filename'] = r.headers.get('X-Filename');
  route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
});
let failures = 0;
const ok = (cond, what) => { console.log((cond ? 'PASS ' : 'FAIL ') + what); if (!cond) failures++; };
const vt = () => page.getAttribute('#picker', 'aria-valuetext');
const said = async () => { await page.waitForTimeout(900); return page.textContent('#live'); };
const adjust = v => page.evaluate(v => { const p = document.getElementById('picker'); p.value = v; p.dispatchEvent(new Event('input', { bubbles: true })); }, v);

// Logged out
await page.goto('http://localhost:8765/');
ok(await page.isVisible('#login'), 'logged out shows the login button');
await page.click('#login');
ok((await said()).includes('isn\'t set up yet'), 'login without an app ID says so');
await page.goto('http://localhost:8765/?code=abc&state=wrong');
ok((await said()).includes("didn't start on this page"), 'a login with the wrong state is refused');
ok(!page.url().includes('code='), 'the code is cleared from the address');

// Logged in
await page.evaluate(t => localStorage.setItem('ff.login', JSON.stringify({ access: t, refresh: 'never-used', expires: Date.now() + 864e5 })), token);
await page.goto('http://localhost:8765/');
ok(await page.isVisible('#query'), 'logged in shows search');
await page.fill('#query', 'rain');
await page.click('button[type=submit]');
await page.waitForFunction(() => document.getElementById('picker').getAttribute('aria-valuetext').startsWith('1 of'), null, { timeout: 15000 });
console.log('     picker: ' + await vt());
ok(await page.evaluate(() => document.activeElement.id) === 'picker', 'focus lands on the picker');
await page.waitForTimeout(500);
ok((await page.evaluate(() => document.getElementById('player').src)).includes('-hq.mp3'), 'first preview loads');
await adjust(2);
ok((await vt()).startsWith('2 of'), 'picker up moves to sound 2');
ok(await page.inputValue('#picker') === '1', 'picker snaps back to the middle');
await adjust(0); await adjust(0);
ok((await vt()).startsWith('First sound.'), 'picker down at the top says First sound');
for (let i = 0; i < 30; i++) await page.click('#next');
await page.waitForFunction(() => document.getElementById('picker').getAttribute('aria-valuetext').startsWith('31 of'), null, { timeout: 15000 });
ok(true, 'Next past the first page loads more (sound 31)');
ok((await said()).startsWith('31 of'), 'Next speaks the sound');
ok((await page.textContent('#details')).includes('Open on Freesound'), 'details show');

// Tag button
const tag = await page.textContent('#tags button');
await page.click('#tags button');
await page.waitForFunction(() => document.getElementById('picker').getAttribute('aria-valuetext').startsWith('1 of'), null, { timeout: 15000 });
ok(await page.inputValue('#query') === '#' + tag, `tag button searches #${tag}`);

// License filter
await page.selectOption('#license', 'Creative Commons 0');
await page.fill('#query', 'door creak');
await page.click('button[type=submit]');
await page.waitForTimeout(3000);
const lines = [];
for (let i = 0; i < 5; i++) { lines.push(await vt()); await adjust(2); }
ok(lines.every(l => l.includes(', CC0, by')), 'CC0 filter gives only CC0 sounds');

// Latest
await page.click('#latest');
await page.waitForTimeout(3000);
ok((await vt()).startsWith('1 of'), 'Latest sounds lists sounds');

// Download (shortest CC0 sound, so the file is small)
await page.selectOption('#sort', 'duration_asc');
await page.fill('#query', 'click');
await page.click('button[type=submit]');
await page.waitForTimeout(3000);
page.on('console', m => console.log('     console: ' + m.text()));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#download')]).catch(async e => { console.log('     live: ' + await page.textContent('#live')); throw e; });
const path = await dl.path();
const size = readFileSync(path).length;
ok(size > 100, `download saved ${dl.suggestedFilename()} (${size} bytes)`);
await page.waitForTimeout(300);
ok((await page.textContent('#downloads')).startsWith('1 sound'), 'download is counted for credits');

// Log out
await page.click('#logout');
ok(await page.isVisible('#login'), 'log out returns to the login button');

await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
