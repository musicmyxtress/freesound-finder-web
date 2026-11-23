// The one piece of Freesound Finder for the web that can't live on GitHub
// Pages: Freesound's login needs the app's secret, and anything on a page is
// public. This Worker adds the secret to the two login calls, and passes
// downloads through, because Freesound's file server won't serve a web page.

const ROOT = 'https://freesound.org/apiv2/';
const ORIGINS = ['https://musicmyxtress.github.io', 'http://localhost:8765'];
const UA = { 'User-Agent': 'FreesoundFinderWeb/1' };

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
    let body;
    try { body = await req.json(); } catch { return reply({ error: 'Bad request.' }, 400); }
    const path = new URL(req.url).pathname;

    if (path === '/token' || path === '/refresh') {
      const form = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET });
      if (path === '/token') {
        if (typeof body.code !== 'string' || !body.code) return reply({ error: 'No login code.' }, 400);
        form.set('grant_type', 'authorization_code');
        form.set('code', body.code);
        // PKCE: Freesound requires it for new apps. The verifier was made on
        // the phone; Freesound checks it against the fingerprint it was sent.
        if (typeof body.code_verifier === 'string' && body.code_verifier) form.set('code_verifier', body.code_verifier);
      } else {
        if (typeof body.refresh_token !== 'string' || !body.refresh_token) return reply({ error: 'Log in again.', expired: true }, 401);
        form.set('grant_type', 'refresh_token');
        form.set('refresh_token', body.refresh_token);
      }
      let r;
      try { r = await fetch(ROOT + 'oauth2/access_token/', { method: 'POST', body: form, headers: UA }); }
      catch { return reply({ error: "Couldn't reach Freesound. Try again." }, 502); }
      if (r.ok) return new Response(await r.text(), { headers: { ...cors, 'Content-Type': 'application/json' } });
      if (r.status === 400 || r.status === 401) {
        return path === '/token'
          ? reply({ error: "Freesound didn't accept that login. Try logging in again." }, 401)
          : reply({ error: 'Your Freesound login ran out. Log in again.', expired: true }, 401);
      }
      return reply({ error: `Freesound answered with error ${r.status}.` }, 502);
    }

    if (path === '/download') {
      // Freesound answers with a redirect to a signed address on its file
      // server, which won't serve web pages directly, so the file passes
      // through here.
      if (!Number.isInteger(body.id) || typeof body.access_token !== 'string') return reply({ error: 'Bad request.' }, 400);
      let r;
      try {
        r = await fetch(`${ROOT}sounds/${body.id}/download/`, {
          headers: { ...UA, Authorization: 'Bearer ' + body.access_token }, redirect: 'manual',
        });
      } catch { return reply({ error: "Couldn't reach Freesound. Try again." }, 502); }
      const location = r.headers.get('Location');
      if (r.status === 401) return reply({ error: 'Your Freesound login ran out. Log in again.', expired: true }, 401);
      if (r.status === 429) return reply({ error: 'Freesound says slow down. Wait a few minutes, then try again.' }, 429);
      if (r.status === 404) return reply({ error: "Freesound doesn't have that sound any more." }, 404);
      if (!(r.status >= 300 && r.status < 400 && location)) return reply({ error: `Freesound answered with error ${r.status}.` }, 502);
      const fileUrl = new URL(location, ROOT);
      let file;
      try { file = await fetch(fileUrl, { headers: UA }); } catch { return reply({ error: "Couldn't reach Freesound's file server. Try again." }, 502); }
      if (!file.ok) return reply({ error: `Freesound's file server answered with error ${file.status}.` }, 502);
      return new Response(file.body, {
        headers: {
          ...cors,
          'Content-Type': file.headers.get('Content-Type') || 'application/octet-stream',
          'X-Filename': encodeURIComponent(fileUrl.searchParams.get('filename') || `${body.id}`),
          'Access-Control-Expose-Headers': 'X-Filename',
        },
      });
    }

    return reply({ error: 'Not found.' }, 404);
  },
};
