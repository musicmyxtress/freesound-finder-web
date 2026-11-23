# Freesound Finder for the web

Daniel's phone version of Blake's desktop Freesound Finder
(`projects/FreesoundFinder`): search freesound.org, hear each sound as you
land on it, read details, download with credits. Daniel uses an iPhone with
VoiceOver and a braille display. He logs in with **his own** Freesound
account. Served from GitHub Pages at
https://musicmyxtress.github.io/freesound-finder-web/.

## Layout
- `index.html`, `style.css`, `app.js`: the whole page, no build step.
  `config.js` holds the two public settings: the Freesound client ID and the
  Worker address.
- `worker/`: Cloudflare Worker `freesound-finder` (Blake's account, the same
  as Report Inbox; `npm run deploy` there). Freesound's login needs the app
  secret, which can't live on a public page, so the Worker adds it to
  `/token` (login code to tokens) and `/refresh`. `/download` passes the
  original file through, because Freesound's file server (cdn.freesound.org
  `/sounds/`) sends no CORS header. The API itself and the preview mp3s do,
  so search and previews go straight from the page to Freesound.
- Secrets: `CLIENT_ID` and `CLIENT_SECRET` (`wrangler secret put`), from the
  "Freesound Finder web" credential under Blake's Freesound account. Its
  callback URL must be exactly the Pages address above.

## Design decisions
- **The picker is the main control.** It's the colony game's braille-tested
  stepper (sound-lab `colony/`): a range with three positions that snaps
  back to the middle after each move, so every swipe up or down, or the
  display's adjust command, is exactly one sound. Its aria-valuetext is the
  sound's line ("3 of 1,204: rain on roof, 12.4 seconds, CC0, by X") and
  VoiceOver reads it itself, so nothing extra is spoken for picker moves.
  Blake chose this from colony experience; Next and Previous are the
  fallback and speak the line through the live region.
- Previews: one shared `<audio>`. The first tap anywhere plays a silent clip
  on it, which lets it change previews later without a tap (iOS rule). 250 ms
  wait before a preview starts, so flicking quickly doesn't load every one.
  Leaving Safari pauses it.
- Login: OAuth code flow with a random `state` and **PKCE (S256)** in localStorage. Freesound requires PKCE for credentials made since it was added (2026; Blake's older Tonic credential doesn't need it). The verifier goes to the Worker's `/token` with the code. Freesound's allow page lists **Deny access before Authorize!** and Enter submits Deny, so the logged-out screen warns about that. Tokens live in
  localStorage on his phone. Refresh tokens rotate, so all renewals share one
  promise. A failed renewal logs him out with a sentence saying so.
- Words match the desktop app (`Words` in FreesoundApi.cs): same line,
  details, license sentences. `#word` in the search box is a tag filter.
- Downloads save through a blob link (Safari asks, then saves to Downloads in
  Files). Each is recorded for "Copy credits".
- Announcements: polite, ~700 ms late. Nothing from Freesound is put into the
  page as HTML (descriptions are parsed to plain text).

## Test
`npm install`, then serve this folder on port 8765 (`python -m http.server
8765`), run the Worker locally (`npm run dev` in `worker/`, port 8799), and
`npm run check`. It drives the real page against the real freesound.org with
Blake's saved access token from `~/.freesound/token.json` and **never renews
it**: renewing would retire the desktop app's refresh token. If that token
has expired, renew it the way the desktop app does and save the file at once.
On Windows it launches Edge (playwright-core, channel msedge).

## Not checked by the test
The real login round trip, VoiceOver and the braille display, iOS audio
unlock, and Safari's download prompt. Those need Daniel's phone.
