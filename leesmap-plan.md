# Leesmap — Plan: Automatic Nightly Daily Digest via OPDS Pull

> Consolidated plan as of 2026-07-10. Merges the earlier nightly-digest roadmap with new findings about how CrossPoint delivers content. The open push-vs-pull risk from the roadmap is now **resolved in favour of pull (OPDS)** — see "Decision" below.

## Goal

Automatically assemble a **daily digest** of the past day's new de Correspondent (DC) articles and get it onto the user's **Xteink X4** (CrossPoint firmware) with no manual steps — including when the reader is asleep at the time the digest is generated.

- Look **backward** at the past day's articles (DC has no fixed publish schedule), not forward.
- Must **NOT** disrupt the existing manual web UI — other users rely on it.

## Scope decision (unchanged)

Digest = the **whole personal feed** (`DC_RSS_URL`, all publications) from the past day. **Not** correspondents-only.

## Decision: pull via OPDS, not push

The earlier roadmap left one risk open: a nightly `upload()` **push** needs the X4 awake and on WiFi at push time, and it was unknown whether CrossPoint keeps an HTTP server alive in standby.

That is now settled. On an e-ink device like the X4, WiFi powers down during sleep, so there is no listening socket to push to while it's asleep. A scheduled nightly push would therefore silently fail whenever the reader happens to be in standby — which at 3am is essentially always.

**The fix is to invert the model.** CrossPoint ships a **native OPDS client** (Settings → OPDS Servers), which lets the reader browse and download EPUBs from a server feed. Instead of Leesmap pushing to the device, Leesmap **publishes an OPDS feed**, and the X4 **pulls** the digest whenever it next wakes on WiFi. This removes the device-online-state problem entirely: no retry queue, no need to know if the reader is awake, no timing coupling between digest generation and delivery.

### Correction: the pull is user-initiated, not automatic

Re-reading `src/activities/home/HomeActivity.cpp`/`.h` in the firmware source: **"OPDS Browser" is a manual menu item on the home screen**, shown only when a server is configured (`hasOpdsServers`). There is no code in boot/wake/sleep handling that polls an OPDS server automatically in the background.

So "the X4 pulls whenever it wakes on WiFi" overclaims — waking on WiFi by itself does nothing. In practice: **you still open Home → OPDS Browser → the digest feed → select the entry → press confirm to download**, each time you want the latest digest on-device. That's a real manual step, just a much lighter one than the old flow (no laptop, no upload — a few button presses on the reader itself, no risk of the upload failing because the device was asleep at 3am).

This doesn't invalidate the OPDS approach — it's still strictly better than push for a device that sleeps with WiFi off — but the goal's "no manual steps" framing only holds for **generation and hosting**, not for the final pull onto the device. Worth knowing before judging build-order step 4 "done": the generator/publisher working correctly is necessary but not sufficient for a hands-off experience.

OPDS is an Atom-based catalog format (think RSS for ebook libraries).

### Confirmed: CrossPoint OPDS client expectations

Verified directly against the CrossPoint firmware source (`lib/OpdsParser/OpdsParser.cpp`, `src/activities/browser/OpdsBookBrowserActivity.cpp`, `src/network/HttpDownloader.cpp` in [crosspoint-reader/crosspoint-reader](https://github.com/crosspoint-reader/crosspoint-reader)), not just docs:

- **Content-Type is not validated at all.** The client (expat-based) parses whatever XML it gets back; `application/atom+xml;profile=opds-catalog` is good spec hygiene to set anyway, but isn't required for this client to work.
- **Acquisition links must match exactly**, or the entry is silently dropped: a `<link>` needs `rel` containing `opds-spec.org/acquisition` **and** `type="application/epub+zip"` (exact string match, not "contains"). Any other type value → entry not classified as a book at all (and if it instead has a `type="application/atom+xml"` link, it becomes a navigation/sub-catalog entry).
- **Format preference**: if an entry has multiple qualifying acquisition links, it prefers the one whose `href` contains `.epub` or `/epub/` over a generic converter/download URL. So the acquisition `href` should point at the real `.epub` file path.
- **Entries need both `title` and a resolved `href`** or they're discarded (no error, just invisible).
- **Pagination** is feed-level `<link rel="next">` / `<link rel="previous">` (note: "previous", not "prev") — not per-entry.
- **Search** (optional, not needed for our case): `<link rel="search" href="...{searchTerms}...">` OpenSearch-style template.
- **Auth**: HTTP Basic only, sent preemptively (no 401 challenge/response dance) — irrelevant for us since the digest feed will be unauthenticated on the LAN, but worth knowing if that changes.
- **Download has no content-type validation either.** Follows up to 5 redirects, requires HTTP 200, then saves the raw response body as `<title>.epub` regardless of what it actually is. If the acquisition endpoint 404s or returns HTML, the device will save that as a corrupt EPUB. So the publisher route must serve exactly the EPUB bytes with a 200, nothing cleverer needed but nothing sloppier allowed either.

Net effect for the publisher (§2 below): each `<entry>` in `/opds/digests` needs one `<link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href=".../digests/YYYY-MM-DD.epub"/>`, and that href must 200 with the actual EPUB bytes.

## Architecture

Reuses existing building blocks. Two independent pieces: a **generator** (nightly, cron) and a **publisher** (OPDS endpoints). They share generated EPUB files via disk — the generator writes, the publisher serves.

### 1. Digest generator — `scheduler.js` — done, verified

- New `scheduler.js` module, started once from `server.js` (`startScheduler()`), using in-process `node-cron`. Isolated from the Express routes; just another consumer of the same library functions.
- Pipeline mirrors the manual `/api/send` flow **up to the EPUB**, then stops (no `upload()`):
  `parseFeed()` → filter items by date → `articleToChapter()` each (text-only, `images: 'strip'`) → `buildBundle()` → **write EPUB to the digest store** (`digests/YYYY-MM-DD.epub`, via `digests.js`).
- Filter on `date > lastDigestRun` (not a naive 24h window) so each article ships exactly once and a missed night is caught up. First-ever run (no `lastDigestRun` yet) falls back to a 24h lookback rather than either dumping the whole feed backlog or shipping nothing.
- Skip cleanly on nights with zero new articles (no empty digest written, `lastDigestRun` still advances so the window doesn't grow unbounded).
- If the feed fetch fails, or every article in the window fails to fetch, `lastDigestRun` is **not** advanced — same window gets retried next run rather than silently losing articles.
- Runs on an hourly cron tick that checks the *current* `digestHour`/`digestEnabled` settings live each time, rather than baking the hour into the cron pattern at startup — so toggling either in settings takes effect without a container restart.
- Verified end-to-end against a local fixture RSS feed + fixture article pages (not the real DC feed): confirmed exactly-once delivery across three runs (new article picked up once, older ones never repeated, zero-new runs advance `lastDigestRun` without error), and inspected the resulting EPUB's chapter content to confirm it matched.

### 2. OPDS publisher — new read-only routes — done, verified

- Added to the existing Express app (`opds.js` builds the feeds, `digests.js` owns the store, routes wired in `server.js`):
  - `GET /opds` — root catalog, one navigation entry pointing at `/opds/digests`
  - `GET /opds/digests` — acquisition feed listing digest EPUBs newest first, each entry's `<link rel="http://opds-spec.org/acquisition" type="application/epub+zip">` pointing at its `.epub`
  - `GET /opds/digests/:filename` — serves the actual EPUB bytes (filename validated against `YYYY-MM-DD.epub` to block path traversal)
- These are **additive, read-only routes** behind the same optional basic-auth middleware as the rest of the app — they don't touch the existing manual web UI or `/api/send`. Existing users are unaffected.
- Verified with a real running server: both feeds are well-formed XML with the exact acquisition-link shape CrossPoint's parser requires, the downloaded EPUB is byte-identical to the source file and passes `unzip -t`, and a missing file / traversal attempt / wrong-extension request all correctly 404.
- Point the X4's OPDS Servers setting at `/opds` (plus Basic auth credentials if `BASIC_AUTH_USER`/`PASS` are set); the reader pulls new digests on wake.

### 3. Settings — via existing `loadSettings` / `saveSettings` — done

New `settings.json` fields, also exposed via `GET /api/config` and `POST /api/settings`:
- `digestEnabled` (default `false` — opt in explicitly)
- `digestHour` (default `3`)
- `lastDigestRun` (timestamp, managed internally by the scheduler — not settable via the API)

## Optional / later

- Keep the existing direct `upload()` path available for **on-demand manual sends** (still works fine when the device is awake); it's just no longer the mechanism for the unattended nightly digest.
- ~~Retention/pruning of old digest EPUBs in the OPDS feed~~ — done: `pruneOldDigests()` in `digests.js`, run every hourly cron tick in `scheduler.js`, deletes digest EPUBs older than 7 days (by filename date). Runs independently of `digestEnabled` so the feed stays clean even if nightly generation is off.
- Feed-level metadata (covers, per-digest titles like "De Correspondent — 9 juli") for nicer browsing on the reader.

## Build order (suggested)

1. ~~Confirm CrossPoint's OPDS client expectations~~ — done, see "Confirmed: CrossPoint OPDS client expectations" above.
2. ~~Build the OPDS publisher against manually-placed EPUBs~~ — done and verified against a real running server (see §2 above). Still can't confirm the X4 itself sees/downloads them — reader hasn't arrived yet.
3. ~~Build `scheduler.js` + settings fields~~ — done and verified against a local fixture feed (see §1 above).
4. End-to-end: let it run a night with the real DC feed and the real X4, confirm the reader pulls the new digest on next wake. **Blocked on the X4 arriving.**

## When the X4 arrives — continuation checklist

Everything on the server side (§1–§3 above) is built and verified in isolation. What's left only needs the physical device.

1. **Firmware.** Confirm what it shipped with. CrossPoint answers at `192.168.4.1` / `crosspoint.local` on its own hotspot; stock firmware is different and lives at `192.168.3.3` (see `device.js`'s header comment). If it's still on stock firmware, flash CrossPoint via the browser-based flasher at xteink.dve.al before anything else here works.
2. **Network.** Join the X4 to the same WiFi as wherever leesmap runs (or make sure the leesmap host can reach the X4's own hotspot — see the README's "Auto-send and your network" section, unchanged by this feature). Set the reader's IP under **instellingen** in the web UI, same as today.
3. **Baseline sanity check.** Before touching anything OPDS-related, confirm the *existing* manual flow still works end to end: pick an article in the web UI, **Verstuur naar X4**, confirm it lands. This isolates "is the device/network fine" from "is the new feature fine" if something doesn't work later.
4. **Deploy the real build.** `docker compose up -d --build` on the actual host (not a laptop) with real `DC_RSS_URL`/`DC_EMAIL`/`DC_PASSWORD` already in `.env`. This branch adds `node-cron` as a new dependency — nothing else changes about how the container is run.
5. **Add the OPDS server on-device.** Settings → System → OPDS Servers → Add Server:
   - URL: `http://<leesmap-host>:<port>/opds` (LAN IP/hostname + whatever port compose maps, default `8088`)
   - Username/Password: only needed if `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` are set — use **Basic**, not Digest (CrossPoint only supports Basic).
6. **First manual pull — de-risk delivery before enabling the schedule.** Drop one or two EPUBs straight into the digest store (`docker exec` into the container, or `docker cp` a file to `/data/digests/YYYY-MM-DD.epub`), then on the device: **Home → OPDS Browser → your server → Dagelijkse digest**. Confirm the entries show sensible Dutch titles and the download actually opens and renders correctly on the e-ink screen (this also validates the cover/bundle look on real hardware, not just that the zip is valid).
7. **Enable the nightly digest.** No UI toggle exists for this yet (only the API), so:
   ```bash
   curl -X POST http://<leesmap-host>:<port>/api/settings \
     -H 'Content-Type: application/json' \
     -d '{"digestEnabled": true, "digestHour": 3}'
   # add -u user:pass if BASIC_AUTH_USER/PASS are set
   ```
8. **Force a near-term test run** rather than waiting for 3am: temporarily set `digestHour` to the current hour (the scheduler checks it live, every hour, no restart needed — see §1 above), then watch `docker compose logs -f leesmap` for the `[scheduler]` log lines confirming it fetched the real feed and wrote a real digest from real articles.
9. **Confirm the full loop.** On the device: open OPDS Browser again — remember this step doesn't happen by itself (see "Correction" above) — and confirm the newly-generated digest appears and downloads.
10. **Settle `digestHour` back** to the real desired nightly hour once confirmed, and adopt the ongoing habit this feature actually delivers: open **Home → OPDS Browser → Dagelijkse digest** on the reader whenever convenient (morning coffee, etc.) rather than needing a laptop — the generation is unattended, the pull is a few button presses.
11. Once the core loop is solid, revisit "Optional / later" (retention/pruning of old digest EPUBs, nicer per-digest covers).

### Troubleshooting

- **Device can't reach the feed at all** (error browsing the OPDS server) — check the leesmap host/port is actually reachable from the X4's network, same as any other reachability issue with `/upload`.
- **"Dagelijkse digest" is empty** — check `digestEnabled` is `true` and at least one successful run has happened: `GET /api/config` includes `lastDigestRun`; `null` means it hasn't run yet (or every run so far failed before writing — check logs).
- **Downloaded EPUB won't open / looks corrupt** — CrossPoint saves whatever bytes come back from the acquisition link with zero content-type validation (confirmed from firmware source), so `curl` the exact acquisition href yourself and confirm it 200s with real EPUB bytes before suspecting the device.

## Send-to-PocketBook — second delivery channel (2026-07-10)

Added alongside OPDS, for a PocketBook Verse Pro. Motivation: OPDS on the X4
requires opening Home → OPDS Browser by hand every time (see "Correction"
above) — fine for the X4, but the Verse Pro has a genuinely automatic
alternative worth using instead of forcing it through the same OPDS-browse
habit.

**Mechanism (confirmed from PocketBook's own Send-to-PocketBook PDF, not
guessed):** every PocketBook device can register its own `username@pbsync.com`
address under Settings → Accounts and Synchronization → Send-to-PocketBook.
Anything emailed there as an attachment downloads to the device's library
automatically once it has an internet connection — no on-device browsing step,
unlike OPDS. The one catch: PocketBook only accepts mail from a white-listed
sender (the registration contact address is trusted by default); anything else
gets a one-time confirmation email instead of silently delivering the file.

**Implementation:** `pocketbook.js` — a thin nodemailer wrapper, gated by
`POCKETBOOK_EMAIL` + `SMTP_*` env vars (unset = feature off entirely). Wired
into `scheduler.js`'s `runDigest()` right after the EPUB is written to the
digest store: the exact same buffer already destined for OPDS gets mailed as
a second, independent channel. A failed/misconfigured send is caught and
logged but never blocks the OPDS write or `lastDigestRun` advancing — OPDS
stays the source of truth, Pocketbook is additive.

Initially shipped automatic-only; a manual **Verstuur naar Pocketbook** button
was added afterward under "Extra opties" (next to "Publiceer naar OPDS"),
wired to a new `POST /api/pocketbook` route that builds the current selection
the same way `/api/published` does and mails it via the same `pocketbook.js`
module instead of writing it to the OPDS store. `/api/config` now also
exposes `pocketbookConfigured` so the button disables itself with an
explanatory title when `POCKETBOOK_EMAIL`/`SMTP_*` aren't set, rather than
failing silently or always being clickable.

A settings-drawer toggle (`pocketbookNightlyEnabled`, new persisted setting,
default `true`) was added next so the *automatic nightly* send can be turned
off independently of `digestEnabled` and of the manual button — e.g. if you
want OPDS to keep running nightly but temporarily stop the Pocketbook emails
without touching env vars. Checkbox disables itself (with an explanatory
label) whenever `pocketbookConfigured()` is false, same pattern as the manual
button.

**Not yet verified against the real device** — built from PocketBook's
official documentation, same as the OPDS publisher was before the X4 arrived.
Needs: SMTP credentials, `POCKETBOOK_EMAIL` from a real Verse Pro
registration, and a confirmation that `SMTP_FROM` lands in the white list
(or that the one-time confirmation email gets approved).

## Related

See the leesmap architecture reference (current app: Node/Express, `feed → article → epub → X4` pipeline, persisted settings) for the building blocks this feature reuses.
