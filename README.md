# Leesmap

Pick articles from your **De Correspondent** membership feed, bind them into
**EPUB**s, and send them straight to a pocket **Xteink X4** running the
**CrossPoint** firmware — over WiFi, from a small self-hosted web UI.

It's a personal format-shifter: you're a paying member, and this turns the
verhalen you already have access to into a format your reader understands. Keep
the EPUBs for yourself; don't redistribute them.

---

## How it works

```
  RSS feed ──▶ pick articles ──▶ fetch each page (your session)
                                        │
                                   Readability
                                   (clean text)
                                        │
                                  build EPUB 2  ──▶  send to X4  (/upload)
                                        └────────▶  or download
```

- **Listing** uses your De Correspondent RSS feed (all-articles, or a
  correspondent/collection feed). The feed only carries excerpts.
- **Full text** is fetched per article from the article page using your
  logged-in session (managed in `session.js`), then cleaned with Mozilla
  Readability.
- **Binding** produces an EPUB 2 (the format CrossPoint renders most reliably)
  with plain, e-ink-friendly CSS. Either one EPUB per article, or a bundle with
  one chapter per article and a table of contents.
- **Sending** POSTs the EPUB to CrossPoint's upload endpoint
  (`POST http://<reader-ip>/upload?path=/`) over your network.

---

## Setup

### 1. Get your two secrets

- **Personal RSS feed URL** — log in at <https://decorrespondent.nl/rss> and copy
  the "alle publicaties" feed link.
- **Login** — your De Correspondent **email + password** (`DC_EMAIL` /
  `DC_PASSWORD`). The app logs in for you, caches the session on the `/data`
  volume, and re-logs-in automatically when it expires — no more pasting cookies.
  (A manual `DC_COOKIE` still works as a fallback if you'd rather; see
  `.env.example`.)

Copy `.env.example` to `.env` and fill both in, plus your reader's IP.

```bash
cp .env.example .env
```

### 2. Run

```bash
docker compose up -d --build
```

Open <http://your-host:8080>.

Prefer running it directly?

```bash
npm install
DC_RSS_URL=... DC_EMAIL=... DC_PASSWORD=... X4_IP=192.168.4.1 npm start
```

---

## Using it

1. Choose a feed (your personal feed, a saved feed, or paste any feed URL) and
   **Laad**.
2. Tick the verhalen you want.
3. In the galei (right): pick **Bundel** or **Per artikel**, **Alleen tekst** or
   **Met beeld**, then **Verstuur naar X4**. The galei-log streams
   `ophalen ▸ uitpakken ▸ binden ▸ versturen` per article.
4. No reader on the network right now? Use **Download .epub** and copy it to the
   SD card (or hand it to Calibre / CrossPoint Sync).
5. **Gisteren (hoofdfeed)** is a one-click shortcut: it re-fetches your primary
   feed, bundles every article published yesterday (your browser's local
   calendar day), and downloads it — ignoring whatever's currently ticked or
   loaded in the feed list above.

Reader IP and saved feeds live under **instellingen** and persist to `./data`.

### Auto-send and your network

The container needs a route to the reader's IP. On your home WiFi (reader joined
as a normal client) a standard bridge network reaches it fine. If the reader is
on its **own hotspot** (`192.168.4.1`), the Docker host itself must be joined to
that hotspot — otherwise use **Download** and sideload, or set
`network_mode: host` in `docker-compose.yml`.

### Images

Default is **text-only**: tiny files that render perfectly on the X4's greyscale
panel. **Met beeld** downloads each image with your session (so hotlink-protected
images work), embeds it with a correct media type, and caps width at 100%. Note
image-heavy books get much larger — fine on the 32 GB card, slower to open.

---

## Troubleshooting

- **`HTTP 401/403` when fetching an article** — with `DC_EMAIL`/`DC_PASSWORD` set
  the app re-logs-in and retries automatically; a persistent 401/403 means login
  itself failed (check the galei-log / container logs for the reason — wrong
  credentials, a changed login form, or a 2FA prompt). On the `DC_COOKIE`
  fallback it just means the cookie expired — grab a fresh one.
- **`422 kon de hoofdtekst niet uit deze pagina halen`** — Readability found too
  little text. Usually a cookie/access issue; occasionally a page that renders
  its body with JavaScript. If it turns out De Correspondent needs JS to render
  article bodies, the fix is a headless-browser fetch step (see roadmap) — the
  fetch layer in `src/article.js` is isolated for exactly this swap.
- **Upload fails / reader offline** — confirm the reader is awake, on WiFi, and
  that the IP in **instellingen** is right. The status chip probes
  `GET /api/files?path=/`.
- **cookie dot is red** — no De Correspondent auth configured: set
  `DC_EMAIL` + `DC_PASSWORD` (or `DC_COOKIE`) in the environment.

---

## Notes on the X4 / CrossPoint

- CrossPoint renders EPUB 2/3; this tool emits EPUB 2 with minimal CSS so it
  cooperates with the reader's own typography settings.
- Confirmed device API: `POST /upload?path=/` (multipart, field `file`) and
  `GET /api/files?path=/`. CrossPoint answers at `192.168.4.1` /
  `crosspoint.local` on its hotspot, or its DHCP address on your WiFi. (Stock
  firmware is different and lives at `192.168.3.3`.)

## Project layout

```
src/
  server.js   HTTP API + static UI + /media route
  config.js   env + persisted settings (/data)
  session.js  De Correspondent login + session cookie (auto-refresh, /data)
  feed.js     RSS parsing
  article.js  authenticated fetch + Readability + image handling
  epub.js     EPUB 2 building (single + bundle)
  device.js   probe + upload to the reader
  media.js    ephemeral image store used during a build
  scheduler.js nightly digest generator (node-cron)
  digests.js  disk store for generated digest EPUBs
  published.js disk store for hand-published EPUBs (Publiceer naar OPDS)
  opds.js     OPDS (Atom) catalog feeds for CrossPoint's OPDS client
  pocketbook.js emails the digest to a Send-to-PocketBook address
  public/     the web UI
```

## Send-to-PocketBook (e.g. a PocketBook Verse Pro)

Optional second delivery channel for the same nightly digest EPUB that's
published to OPDS. Where the X4 needs a manual "Home → OPDS Browser" pull,
PocketBook Cloud downloads mail sent to the device's own address
automatically once it has WiFi.

1. On the device: **Settings → Accounts and Synchronization →
   Send-to-PocketBook**, register with a contact email, follow the
   activation link it emails you, then copy the resulting
   `username@pbsync.com` address.
2. Fill in `POCKETBOOK_EMAIL` and `SMTP_*` in `.env` (see `.env.example`) —
   any SMTP account/relay works.
3. Set `SMTP_FROM` to the **same contact email** you registered with in step
   1. PocketBook only delivers mail from a white-listed sender; anything else
   triggers a one-time confirmation email instead of delivering the file —
   approve that once if you'd rather send from a different address.

Leave `POCKETBOOK_EMAIL` blank to skip this channel entirely — OPDS keeps
working either way, and a failed/misconfigured Pocketbook send never blocks
the OPDS digest or `lastDigestRun`. It fires automatically as part of the
nightly digest run, and there's also a manual **Verstuur naar Pocketbook**
button under **Extra opties**, next to **Publiceer naar OPDS**, for sending a
hand-picked selection on demand.

## Roadmap / easy extensions

- **Headless-browser fetch** fallback for any JS-rendered pages.
- **Image downscaling** to greyscale (add `sharp`) for smaller, e-ink-tuned files.
- **KOReader-style** progress isn't needed here, but bundles could gain a cover.

## Security

The server holds your De Correspondent credentials (or cookie) and can read your
articles. The session cookie is cached under `./data` (git-ignored). Keep it on
your LAN or Tailscale, or set `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`. The
`/media` route only holds transient article images during a build and expires
them after ten minutes.

If you share the app (e.g. with a family member) but don't want them
reconfiguring it or triggering a send/publish by accident, set
`ADMIN_PASSWORD`. It's narrower than basic auth: it only gates the
**instellingen** drawer and the **Extra opties** actions (Verstuur naar X4 /
Publiceer naar OPDS / Verstuur naar Pocketbook); browsing feeds and Download
.epub stay open. The password is typed once into a prompt and cached in the
browser tab's session storage — it's convenience, not a real access-control
boundary, so still put
`BASIC_AUTH_USER`/`PASS` (or Tailscale) in front if the app is reachable by
anyone untrusted.

MIT.
