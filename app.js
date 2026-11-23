'use strict';
// Freesound Finder for the web: the phone version of Blake's desktop app,
// made for Daniel (iPhone, VoiceOver, braille display). Talks straight to
// Freesound's API with Daniel's own login. The only server is a small
// Cloudflare Worker that holds the app secret (worker/).

const CFG = window.FINDER_CONFIG;
const API = 'https://freesound.org/apiv2/';
const FIELDS = 'id,name,username,duration,license,tags,description,type,samplerate,channels,bitdepth,filesize,num_downloads,avg_rating,num_ratings,created,previews';
const $ = id => document.getElementById(id);
const picker = $('picker'), player = $('player'), live = $('live');

class FinderError extends Error {
  constructor(message, expired = false) { super(message); this.expired = expired; }
}

// ---------- Speaking ----------
// Polite and about 700 ms late, so VoiceOver finishes what it was saying
// (the button name, the picker's value) before this is read.
let sayTimer;
function say(text) {
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => {
    // The same sentence twice in a row isn't re-read unless the text changes.
    live.textContent = live.textContent === text ? text + ' ' : text;
  }, 700);
}

// ---------- Words (the same sentences as the desktop app) ----------
function licenseName(url) {
  if (url.includes('publicdomain/zero')) return 'CC0';
  if (url.includes('sampling+')) return 'Sampling Plus';
  if (url.includes('/by-nc')) return 'Noncommercial';
  if (url.includes('/by/')) return 'Attribution';
  return 'Other license';
}
function readable(name) {
  name = name.replace(/\.(wav|mp3|flac|ogg|aif|aiff|m4a)$/i, '').replace(/_/g, ' ').trim();
  return name || 'untitled';
}
const count = (n, thing) => n === 1 ? `1 ${thing}` : `${n.toLocaleString('en-US')} ${thing}s`;
function length(sec) {
  return sec < 60 ? `${sec.toFixed(1)} seconds`
    : `${count(Math.floor(sec / 60), 'minute')} ${count(Math.floor(sec % 60), 'second')}`;
}
const line = s => `${readable(s.name)}, ${length(s.duration)}, ${licenseName(s.license)}, by ${s.username}`;
function about(s) {
  const ch = s.channels === 1 ? 'mono' : s.channels === 2 ? 'stereo' : `${s.channels} channels`;
  const bits = s.bitdepth > 0 ? ` ${s.bitdepth} bit` : '';
  const size = s.filesize < 1048576 ? `${Math.round(s.filesize / 1024)} KB` : `${(s.filesize / 1048576).toFixed(1)} MB`;
  const rating = s.num_ratings > 0
    ? `, rated ${s.avg_rating.toFixed(1)} by ${count(s.num_ratings, 'person').replace('persons', 'people')}` : ', no ratings';
  return `${(s.type || '').toUpperCase()}${bits}, ${+(s.samplerate / 1000).toFixed(1)} kilohertz ${ch}, ${size}, ${count(s.num_downloads, 'download')}${rating}.`;
}
function credit(s) {
  switch (licenseName(s.license)) {
    case 'CC0': return 'CC0: free for anything, no credit needed.';
    case 'Attribution': return `Attribution: free for anything, but you must credit ${s.username}.`;
    case 'Noncommercial': return `Noncommercial: credit ${s.username}, and never in anything sold.`;
    case 'Sampling Plus': return `Sampling Plus: credit ${s.username}; check the license before using.`;
    default: return "Check this license on the sound's page before using it.";
  }
}
const pageUrl = s => `https://freesound.org/s/${s.id}/`;
// Descriptions arrive as HTML. Parsed into an inert document and read back as
// plain text, so nothing from Freesound is ever put into the page as HTML.
const plain = html => (new DOMParser().parseFromString(html || '', 'text/html').body.textContent || '').replace(/[ \t]+/g, ' ').trim();

// ---------- Login ----------
let login = null;
function loadLogin() {
  try { return JSON.parse(localStorage.getItem('ff.login')); } catch { return null; }
}
function saveLogin(t) {
  login = { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in || 86400) * 1000 };
  localStorage.setItem('ff.login', JSON.stringify(login));
}
function dropLogin() {
  login = null;
  localStorage.removeItem('ff.login');
  player.pause();
  showScreen();
}

async function worker(path, body) {
  let r;
  try {
    r = await fetch(CFG.worker + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new FinderError("Couldn't reach the login helper. Check the internet connection.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new FinderError(j.error || `The login helper answered with error ${r.status}.`, !!j.expired);
  return j;
}

// Each renewal retires the old refresh token, so two at once would make the
// second fail. Everyone waits on the same one.
let refreshing = null;
function refresh() {
  if (!refreshing) {
    refreshing = worker('/refresh', { refresh_token: login.refresh })
      .then(saveLogin)
      .catch(e => { if (e.expired) dropLogin(); throw e; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}
async function fresh() {
  if (!login) throw new FinderError('Log in first.');
  if (Date.now() > login.expires - 60000) await refresh();
}

async function api(url) {
  await fresh();
  const get = () => fetch(url, { headers: { Authorization: 'Bearer ' + login.access } })
    .catch(() => { throw new FinderError("Couldn't reach Freesound. Check the internet connection."); });
  let r = await get();
  if (r.status === 401) { await refresh(); r = await get(); }
  if (!r.ok) throw failure(r.status);
  return r.json();
}
function failure(status) {
  if (status === 429) return new FinderError('Freesound says slow down. Wait a few minutes, then try again.');
  if (status === 401 || status === 403) return new FinderError('Freesound refused the login. Log out and log in again.');
  if (status === 404) return new FinderError("Freesound doesn't have that sound any more.");
  return new FinderError(`Freesound answered with error ${status}.`);
}

function startLogin() {
  if (!CFG.clientId || CFG.clientId === 'SET_ME') {
    loginProblem("This page isn't set up yet: it still needs its Freesound app ID.");
    return;
  }
  const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
  localStorage.setItem('ff.state', state);
  location.href = `${API}oauth2/authorize/?client_id=${encodeURIComponent(CFG.clientId)}&response_type=code&state=${state}`;
}

// Freesound sends him back here with ?code=...&state=... after he logs in.
async function finishLogin() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', location.pathname); // a code works once; don't leave it in the address
  const expected = localStorage.getItem('ff.state');
  localStorage.removeItem('ff.state');
  if (p.has('error')) {
    const code = p.get('error');
    loginProblem(code === 'access_denied'
      ? "Login not finished: Freesound says access was denied. That is what the first button, Deny access, does. Try again, and on Freesound's page choose the second button, Authorize!"
      : `Login not finished. Freesound said: ${code}${p.get('error_description') ? ', ' + p.get('error_description') : ''}. Tell Blake these exact words.`);
    return;
  }
  if (!expected || p.get('state') !== expected) { loginProblem("Login not finished: that login didn't start on this page. Try logging in again."); return; }
  try {
    saveLogin(await worker('/token', { code: p.get('code') }));
    return true;
  } catch (e) { loginProblem('Login not finished. ' + e.message); }
}
// Kept on the page as well as spoken, so it can be read on the braille
// display at his own pace after the page loads.
function loginProblem(text) {
  const el = $('loginStatus');
  el.textContent = text;
  el.hidden = false;
  say(text);
}

function showScreen() {
  $('loggedOut').hidden = !!login;
  $('app').hidden = !login;
}

// ---------- Preview player ----------
// iPhone Safari plays sound only after a tap. The first tap anywhere plays a
// silent clip on the one shared player; after that the same player may
// switch to a new preview without a tap, which is what lets the picker play
// each sound as it lands.
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  if (!player.src) { player.src = SILENT; player.play().catch(() => { unlocked = false; }); }
}
document.addEventListener('click', unlock, true);
document.addEventListener('touchend', unlock, true);
document.addEventListener('keydown', unlock, true);

let playTimer;
function playSound(s, wait = 250) {
  // Short wait so flicking quickly past sounds doesn't start every download.
  clearTimeout(playTimer);
  playTimer = setTimeout(() => {
    const url = s.previews['preview-hq-mp3'] || Object.values(s.previews)[0];
    if (!url) { say('This sound has no preview.'); return; }
    player.src = url;
    player.play().catch(e => {
      if (e.name === 'NotAllowedError') say('Tap Play again to start the sound.');
    });
  }, wait);
}
player.addEventListener('error', () => {
  if (player.src && !player.src.startsWith('data:')) say("That preview wouldn't play.");
});
// Leaving Safari stops the sound, as the desktop app stops when its window loses focus.
document.addEventListener('visibilitychange', () => { if (document.hidden) player.pause(); });

// ---------- Results ----------
const S = { results: [], index: -1, count: 0, next: null, loading: null, gen: 0, label: '' };
const current = () => S.results[S.index];

function setPicker(text) {
  picker.setAttribute('aria-valuetext', text);
  picker.value = 1;
}
function show(i, { speak = false, prefix = '' } = {}) {
  S.index = i;
  const s = current();
  const text = `${prefix}${i + 1} of ${S.count.toLocaleString('en-US')}: ${line(s)}`;
  setPicker(text);
  if (speak) say(text);
  showDetails(s);
  playSound(s);
  if (i >= S.results.length - 3) loadMore(); // fetch the next page before he reaches the end
}

function loadMore() {
  if (!S.next) return Promise.resolve();
  if (!S.loading) {
    const gen = S.gen;
    S.loading = api(S.next).then(page => {
      if (gen !== S.gen) return;
      S.results.push(...page.results);
      S.next = page.next;
    }).catch(e => say(e.message)).finally(() => { S.loading = null; });
  }
  return S.loading;
}

async function step(d, speak) {
  if (!S.results.length) { say('Search first.'); return; }
  const i = S.index + d;
  if (i < 0) {
    const text = `First sound. 1 of ${S.count.toLocaleString('en-US')}: ${line(S.results[0])}`;
    setPicker(text); if (speak) say(text);
    return;
  }
  if (i >= S.results.length) {
    if (S.next || S.loading) {
      setPicker('Loading more sounds.');
      if (speak) say('Loading more sounds.');
      const gen = S.gen;
      await (S.loading || loadMore());
      if (gen === S.gen && i < S.results.length) show(i, { speak: true });
      return;
    }
    const text = `Last sound. ${S.index + 1} of ${S.count.toLocaleString('en-US')}: ${line(current())}`;
    setPicker(text); if (speak) say(text);
    return;
  }
  show(i, { speak });
}

// The picker is the colony game's braille-tested stepper: three positions,
// snapping back to the middle after every move, so each swipe up or down (or
// the display's adjust command) is exactly one sound. VoiceOver reads the
// new value itself, so nothing extra is spoken.
picker.addEventListener('input', () => {
  const v = +picker.value;
  picker.value = 1;
  if (v === 2) step(1, false);
  else if (v === 0) step(-1, false);
});
$('next').addEventListener('click', () => step(1, true));
$('prev').addEventListener('click', () => step(-1, true));
$('play').addEventListener('click', () => {
  const s = current();
  if (!s) { say('Search first.'); return; }
  playSound(s, 0);
});
$('stop').addEventListener('click', () => { clearTimeout(playTimer); player.pause(); say('Stopped.'); });

async function search(text, sort) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const query = words.filter(w => !w.startsWith('#')).join(' ');
  const filters = words.filter(w => w.length > 1 && w.startsWith('#')).map(w => `tag:"${w.slice(1)}"`);
  const lic = $('license').value;
  if (lic) filters.push(`license:"${lic}"`);
  // An empty filter= is refused ("Invalid filter"), so it's only sent when there is one.
  let url = `${API}search/text/?query=${encodeURIComponent(query)}`;
  if (filters.length) url += `&filter=${encodeURIComponent(filters.join(' '))}`;
  url += `&sort=${sort || $('sort').value}&page_size=30&fields=${FIELDS}`;

  const gen = ++S.gen;
  S.loading = null;
  say('Searching.');
  try {
    const page = await api(url);
    if (gen !== S.gen) return;
    Object.assign(S, { results: page.results, count: page.count, next: page.next, index: -1 });
    if (!S.results.length) {
      setPicker('No sounds found. Try other words.');
      $('details').replaceChildren(para('No sound chosen.'));
      $('tags').replaceChildren();
      say('No sounds found.');
      return;
    }
    show(0);
    // Landing on the picker reads its value: the first sound and the total.
    picker.focus();
  } catch (e) {
    if (gen === S.gen) say(e.message);
  }
}

$('searchForm').addEventListener('submit', e => {
  e.preventDefault();
  $('query').blur(); // closes the keyboard
  search($('query').value);
});
$('latest').addEventListener('click', () => { $('query').value = ''; search('', 'created_desc'); });

// ---------- Details ----------
function para(text) { const p = document.createElement('p'); p.textContent = text; return p; }
function showDetails(s) {
  const made = new Date(s.created);
  const uploaded = isNaN(made) ? s.created : made.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const link = document.createElement('a');
  link.href = pageUrl(s); link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'Open on Freesound';
  const desc = plain(s.description);
  $('details').replaceChildren(
    para(readable(s.name)),
    para(`By ${s.username}, uploaded ${uploaded}.`),
    para(`${length(s.duration)}. ${about(s)}`),
    para(credit(s)),
    para(desc || 'No description.'),
    link,
  );
  const tags = s.tags.map(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.setAttribute('aria-label', `Search tag ${t}`);
    b.addEventListener('click', () => { $('query').value = '#' + t; search('#' + t); });
    return b;
  });
  $('tags').replaceChildren(para(tags.length ? 'Tags:' : 'No tags.'), ...tags);
}

// ---------- Downloads ----------
function credits() {
  try { return JSON.parse(localStorage.getItem('ff.credits')) || []; } catch { return []; }
}
function showDownloads() {
  const n = credits().length;
  $('downloads').textContent = n ? `${count(n, 'sound')} downloaded on this phone.` : 'No downloads yet.';
}
let downloading = false;
async function download() {
  const s = current();
  if (!s) { say('Choose a sound first.'); return; }
  if (downloading) { say('Still downloading the last one.'); return; }
  downloading = true;
  say(`Downloading ${readable(s.name)}.`);
  try {
    await fresh();
    // The Worker fetches the file: Freesound's file server won't serve it
    // to a web page directly.
    const get = () => fetch(CFG.worker + '/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, access_token: login.access }),
    }).catch(() => { throw new FinderError("Couldn't reach the login helper. Check the internet connection."); });
    let r = await get();
    if (r.status === 401) { await refresh(); r = await get(); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new FinderError(j.error || `Download failed with error ${r.status}.`);
    }
    const blob = await r.blob();
    const name = decodeURIComponent(r.headers.get('X-Filename') || '') || `${s.id}__${s.username}__${s.name}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    const list = credits();
    if (!list.some(c => c.id === s.id)) {
      list.push({ id: s.id, name: readable(s.name), user: s.username, license: licenseName(s.license), url: pageUrl(s) });
      localStorage.setItem('ff.credits', JSON.stringify(list));
    }
    showDownloads();
    say(`Downloaded ${readable(s.name)}. If Safari asks, choose Download.`);
  } catch (e) {
    say(e.message);
  } finally {
    downloading = false;
  }
}
$('download').addEventListener('click', download);
$('copyCredits').addEventListener('click', async () => {
  const list = credits();
  if (!list.length) { say('No downloads yet, so no credits.'); return; }
  const text = list.map(c => `${c.name} by ${c.user} (${c.license}) ${c.url}`).join('\n');
  try { await navigator.clipboard.writeText(text); say(`Copied credits for ${count(list.length, 'sound')}.`); }
  catch { say("Couldn't copy the credits."); }
});

$('login').addEventListener('click', startLogin);
$('logout').addEventListener('click', () => { dropLogin(); say('Logged out.'); });

// ---------- Start ----------
(async () => {
  login = loadLogin();
  const justLoggedIn = await finishLogin();
  showScreen();
  showDownloads();
  if (justLoggedIn) { $('query').focus(); say('Logged in. Type what to search for.'); }
})();
