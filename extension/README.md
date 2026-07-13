# Leesmap — Brabants Dagblad extension

Sends the article you're currently reading on bd.nl to your own leesmap
server. No login/session code lives here or in leesmap itself for BD — your
browser is already authenticated with bd.nl the normal way, so the extension
just hands over the page you're already looking at.

## Install (unpacked, for personal use)

1. Chrome/Edge: go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` folder.
4. Click the new toolbar icon → **Instellingen** → fill in:
   - **Server-URL**: your leesmap server's address, e.g. `http://192.168.1.50:8088`
     (whatever you use to reach the web UI).
   - **Admin-wachtwoord**: only if you set `ADMIN_PASSWORD` in leesmap's `.env`.
   - **Basic-auth gebruikersnaam/wachtwoord**: only if you set
     `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`.
5. Save.

## Use

Open any bd.nl article (logged in, as normal), click the toolbar icon, click
**Verstuur artikel naar Leesmap**. On success it shows the extracted title;
the EPUB is now on the **Gepubliceerd — Brabants Dagblad** OPDS shelf, same
as anything published from the main web UI.

## How it works

- The popup grabs the current tab's full HTML (`document.documentElement.outerHTML`)
  via `chrome.scripting.executeScript` — no content script injected ahead of
  time, only on click.
- POSTs `{ url, html }` to `POST /api/bd/import` on your leesmap server.
- The server runs Readability on that HTML (`src/bd-article.js`), builds a
  single-article EPUB (`src/epub.js`), and publishes it to
  `published/bd/` (`src/published.js`) — served at `/opds/published/bd`.
