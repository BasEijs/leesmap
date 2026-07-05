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
  public/     the web UI
```

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

MIT.
