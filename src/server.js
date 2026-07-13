import express from 'express';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { env, loadSettings, saveSettings } from './config.js';
import { parseFeed, parseCombinedFeed } from './feed.js';
import { articleToChapter } from './article.js';
import { bdArticleToChapter } from './bd-article.js';
import { buildSingle, buildBundle } from './epub.js';
import { probe, upload } from './device.js';
import { get as getMedia } from './media.js';
import { slugFromInput, resolveCorrespondent, resolveAll } from './correspondents.js';
import { listDigests, digestFilePath } from './digests.js';
import { listPublished, publishedFilePath, savePublished, deletePublished } from './published.js';
import { rootCatalog, digestsFeed, publishedFeed } from './opds.js';
import { startScheduler } from './scheduler.js';
import { isConfigured as pocketbookConfigured, sendToPocketbook } from './pocketbook.js';

// A "bundle" of one article is just that article with extra ceremony (author-led
// filename, selection-style cover). Treat a single URL as 'single' regardless of
// what the client's mode toggle says, so the UI can never produce that.
function isSingle(mode, urls) {
  return mode === 'single' || urls.length === 1;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

const mediaBase = `http://127.0.0.1:${env.port}`;

// --- Media route (must stay before auth so the EPUB builder can fetch it) ---
app.get('/media/:id', (req, res) => {
  const m = getMedia(req.params.id);
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m.contentType);
  res.end(m.buffer);
});

// --- Optional basic auth for everything else ---
if (env.basicUser) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [, b64] = hdr.split(' ');
    const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (u === env.basicUser && p === env.basicPass) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Leesmap"');
    res.status(401).end('Authenticatie vereist');
  });
}

// --- Admin gate ---
// Narrower than BASIC_AUTH_*: only guards settings changes and the
// send/publish actions (see requireAdmin below), via a password typed once
// into a prompt() and resent as a header. Unset ADMIN_PASSWORD disables the
// gate entirely, same convention as basicUser above.
function checkAdmin(req) {
  return !env.adminPassword || req.headers['x-admin-password'] === env.adminPassword;
}
function requireAdmin(req, res, next) {
  if (checkAdmin(req)) return next();
  res.status(401).json({ error: 'Onjuist beheerderswachtwoord.' });
}
app.post('/api/admin/verify', (req, res) => {
  const password = req.body?.password || '';
  res.json({ ok: !env.adminPassword || password === env.adminPassword });
});

// --- Config & settings ---
app.get('/api/config', (req, res) => {
  const s = loadSettings();
  res.json({
    deviceIp: s.deviceIp,
    feeds: s.feeds,
    primaryFeedConfigured: Boolean(env.primaryFeedUrl),
    // Authenticated either via the manual cookie or automatic email login.
    cookieConfigured: Boolean(env.cookie || (env.email && env.password)),
    digestEnabled: s.digestEnabled,
    digestHour: s.digestHour,
    lastDigestRun: s.lastDigestRun,
    adminRequired: Boolean(env.adminPassword),
    pocketbookConfigured: pocketbookConfigured(),
    pocketbookNightlyEnabled: s.pocketbookNightlyEnabled,
  });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const { deviceIp, feeds, digestEnabled, digestHour, pocketbookNightlyEnabled } = req.body || {};
  const next = {};
  if (typeof deviceIp === 'string') next.deviceIp = deviceIp.trim();
  if (Array.isArray(feeds)) next.feeds = feeds;
  if (typeof digestEnabled === 'boolean') next.digestEnabled = digestEnabled;
  if (Number.isInteger(digestHour) && digestHour >= 0 && digestHour <= 23) next.digestHour = digestHour;
  if (typeof pocketbookNightlyEnabled === 'boolean') next.pocketbookNightlyEnabled = pocketbookNightlyEnabled;
  res.json(saveSettings(next));
});

// --- Correspondents (avatar grid) ---
// Resolve the saved slugs to {slug, name, beat, avatar, feedUrl}.
app.get('/api/correspondents', async (req, res) => {
  try {
    res.json({ correspondents: await resolveAll(loadSettings().correspondents) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Add a correspondent by slug, profile URL, or feed URL. We resolve it first
// (which also validates it exists) before persisting the slug.
app.post('/api/correspondents', requireAdmin, async (req, res) => {
  const slug = slugFromInput(req.body?.input);
  if (!slug) return res.status(400).json({ error: 'Geef een slug of profiel-URL.' });
  try {
    const resolved = await resolveCorrespondent(slug);
    const s = loadSettings();
    const list = s.correspondents.includes(slug)
      ? s.correspondents
      : [...s.correspondents, slug];
    saveSettings({ correspondents: list });
    res.json({ correspondent: resolved, correspondents: await resolveAll(list) });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Reorder the saved correspondents. The body carries the full slug list in the
// desired order; we intersect with what's already saved so this can only
// reorder (or drop) existing entries, never add an unresolved slug.
app.put('/api/correspondents', requireAdmin, async (req, res) => {
  const incoming = Array.isArray(req.body?.slugs) ? req.body.slugs : null;
  if (!incoming) return res.status(400).json({ error: 'Verwachtte { slugs: [...] }.' });
  const current = new Set(loadSettings().correspondents);
  const list = incoming.filter((s) => current.has(s));
  saveSettings({ correspondents: list });
  res.json({ correspondents: await resolveAll(list) });
});

app.delete('/api/correspondents/:slug', requireAdmin, async (req, res) => {
  const list = loadSettings().correspondents.filter((s) => s !== req.params.slug);
  saveSettings({ correspondents: list });
  res.json({ correspondents: await resolveAll(list) });
});

// --- Feed ---
// `url` may name a single feed, or several (comma-separated, or repeated) to
// combine per-correspondent feeds into one chronological list.
app.get('/api/feed', async (req, res) => {
  try {
    const raw = req.query.url;
    const urls = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
      .map((u) => u.trim())
      .filter(Boolean);
    const feed = urls.length > 1 ? await parseCombinedFeed(urls) : await parseFeed(urls[0]);
    res.json(feed);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// --- Device status ---
app.get('/api/device', async (req, res) => {
  const ip = req.query.ip || loadSettings().deviceIp;
  res.json({ ip, ...(await probe(ip)) });
});

// --- Build one EPUB for download in the browser ---
// body: { urls: [...], mode: 'single'|'bundle', images: 'strip'|'embed', title? }
// For 'single' we expect exactly one URL (the UI downloads them one by one).
app.post('/api/build', async (req, res) => {
  const { urls = [], mode = 'bundle', images = 'strip', title } = req.body || {};
  if (!urls.length) return res.status(400).json({ error: 'Geen artikelen geselecteerd.' });
  try {
    let out;
    if (isSingle(mode, urls)) {
      const chapter = await articleToChapter(urls[0], { images, mediaBase, withAvatar: true });
      out = await buildSingle(chapter);
    } else {
      const chapters = [];
      for (const url of urls)
        chapters.push(await articleToChapter(url, { images, mediaBase, withAvatar: true }));
      out = await buildBundle(chapters, { title });
    }
    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${out.filename}"`
    );
    res.end(out.buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Publish a hand-picked selection to the OPDS "Gepubliceerd" feed ---
// Same build as /api/build, but the result is written to the published store
// instead of streamed back, so the ereader can pull it over OPDS later.
app.get('/api/published', async (req, res) => {
  res.json({ items: await listPublished('decorrespondent') });
});

app.post('/api/published', requireAdmin, async (req, res) => {
  const { urls = [], mode = 'bundle', images = 'strip', title } = req.body || {};
  if (!urls.length) return res.status(400).json({ error: 'Geen artikelen geselecteerd.' });
  try {
    let out;
    if (isSingle(mode, urls)) {
      const chapter = await articleToChapter(urls[0], { images, mediaBase, withAvatar: true });
      out = await buildSingle(chapter);
    } else {
      const chapters = [];
      for (const url of urls)
        chapters.push(await articleToChapter(url, { images, mediaBase, withAvatar: true }));
      out = await buildBundle(chapters, { title });
    }
    const record = await savePublished(out.buffer, title || out.title, 'decorrespondent');
    res.json({ ok: true, items: await listPublished('decorrespondent'), published: record });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/published/:filename', requireAdmin, async (req, res) => {
  await deletePublished(req.params.filename, 'decorrespondent');
  res.json({ ok: true, items: await listPublished('decorrespondent') });
});

// --- Brabants Dagblad: receive one already-extracted article from the
// browser extension (see extension/), bind it, and publish it straight to
// its own OPDS "Gepubliceerd — Brabants Dagblad" shelf. No fetching/session
// here — the extension's tab was already logged into bd.nl normally, so the
// paywalled body text is already in the HTML it sends.
app.post('/api/bd/import', requireAdmin, async (req, res) => {
  const { url, html } = req.body || {};
  if (!url || !html) return res.status(400).json({ error: 'Verwachtte { url, html }.' });
  try {
    const chapter = bdArticleToChapter(html, url);
    const out = await buildSingle(chapter);
    const record = await savePublished(out.buffer, out.title, 'bd');
    res.json({ ok: true, title: out.title, published: record });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Email a hand-picked selection to the Send-to-PocketBook address ---
// Same build as /api/build and /api/published, but the result is mailed
// (see pocketbook.js) instead of streamed back or written to the OPDS store.
app.post('/api/pocketbook', requireAdmin, async (req, res) => {
  if (!pocketbookConfigured()) {
    return res.status(400).json({ error: 'Pocketbook niet geconfigureerd (POCKETBOOK_EMAIL/SMTP_* ontbreken).' });
  }
  const { urls = [], mode = 'bundle', images = 'strip', title } = req.body || {};
  if (!urls.length) return res.status(400).json({ error: 'Geen artikelen geselecteerd.' });
  try {
    let out;
    if (isSingle(mode, urls)) {
      const chapter = await articleToChapter(urls[0], { images, mediaBase, withAvatar: true });
      out = await buildSingle(chapter);
    } else {
      const chapters = [];
      for (const url of urls)
        chapters.push(await articleToChapter(url, { images, mediaBase, withAvatar: true }));
      out = await buildBundle(chapters, { title });
    }
    await sendToPocketbook(out.buffer, out.filename, title || out.title);
    res.json({ ok: true, filename: out.filename });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Build + send to the reader, streaming progress as NDJSON ---
// body: { urls, mode, images, deviceIp, title }
app.post('/api/send', requireAdmin, async (req, res) => {
  const {
    urls = [],
    mode = 'bundle',
    images = 'strip',
    deviceIp,
    title,
  } = req.body || {};
  const ip = (deviceIp || loadSettings().deviceIp || '').trim();

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  const emit = (o) => res.write(JSON.stringify(o) + '\n');

  if (!urls.length) {
    emit({ type: 'error', message: 'Geen artikelen geselecteerd.' });
    return res.end();
  }
  if (!ip) {
    emit({ type: 'error', message: 'Geen reader-IP ingesteld.' });
    return res.end();
  }

  try {
    const prepare = async (url) => {
      emit({ type: 'step', url, phase: 'fetch' });
      // Both single and bundle covers show portraits (one big, or a row), so
      // both fetch the correspondent avatar.
      const chapter = await articleToChapter(url, {
        images,
        mediaBase,
        withAvatar: true,
      });
      emit({ type: 'step', url, phase: 'extract', title: chapter.title });
      return chapter;
    };

    if (isSingle(mode, urls)) {
      for (const url of urls) {
        try {
          const chapter = await prepare(url);
          emit({ type: 'step', url, phase: 'bind', title: chapter.title });
          const { buffer, filename } = await buildSingle(chapter);
          emit({ type: 'step', url, phase: 'send', filename, bytes: buffer.length });
          await upload(ip, filename, buffer);
          emit({ type: 'result', url, ok: true, filename, bytes: buffer.length });
        } catch (err) {
          emit({ type: 'result', url, ok: false, message: err.message });
        }
      }
    } else {
      const chapters = [];
      for (const url of urls) {
        try {
          chapters.push(await prepare(url));
        } catch (err) {
          emit({ type: 'result', url, ok: false, message: err.message });
        }
      }
      if (chapters.length) {
        emit({ type: 'step', phase: 'bind', count: chapters.length });
        const { buffer, filename } = await buildBundle(chapters, { title });
        emit({ type: 'step', phase: 'send', filename, bytes: buffer.length });
        await upload(ip, filename, buffer);
        emit({ type: 'result', ok: true, filename, bytes: buffer.length, bundled: chapters.length });
      }
    }
    emit({ type: 'done' });
  } catch (err) {
    emit({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// --- OPDS (read-only; CrossPoint's OPDS client pulls the digest from here) ---
// See opds.js for the feed shapes and why they're built this way. Additive
// only — doesn't touch /api/send or the manual web UI.
const OPDS_CONTENT_TYPE = 'application/atom+xml;profile=opds-catalog;charset=utf-8';

app.get('/opds', (req, res) => {
  res.setHeader('Content-Type', OPDS_CONTENT_TYPE);
  res.end(rootCatalog());
});

app.get('/opds/digests', async (req, res) => {
  const digests = await listDigests();
  res.setHeader('Content-Type', OPDS_CONTENT_TYPE);
  res.end(digestsFeed(digests));
});

app.get('/opds/digests/:filename', (req, res) => {
  const filePath = digestFilePath(req.params.filename);
  if (!filePath || !existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  createReadStream(filePath).pipe(res);
});

// `:source` is validated against a known list inside published.js (anything
// else quietly falls back to 'decorrespondent'), so this can't be used to
// read arbitrary directories.
app.get('/opds/published/:source', async (req, res) => {
  const items = await listPublished(req.params.source);
  res.setHeader('Content-Type', OPDS_CONTENT_TYPE);
  res.end(publishedFeed(items, req.params.source));
});

app.get('/opds/published/:source/:filename', (req, res) => {
  const filePath = publishedFilePath(req.params.filename, req.params.source);
  if (!filePath || !existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/epub+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  createReadStream(filePath).pipe(res);
});

// --- Static files with cache-busting ---
// A stale app.js/style.css served by Cloudflare or a caching proxy is why a new
// build sometimes doesn't reach a client. Fix: version the asset URLs with a
// short content hash. index.html is served with `no-cache` (always revalidated,
// so a new hash lands immediately), while the hashed JS/CSS can cache forever.
// The hash only changes when the files change, so unchanged deploys keep their
// cache. Read once at startup; the container restarts on deploy (and `node
// --watch` restarts in dev), so this stays in sync.
const publicDir = join(__dirname, 'public');
const assetVer = createHash('sha1')
  .update(readFileSync(join(publicDir, 'app.js')))
  .update(readFileSync(join(publicDir, 'style.css')))
  .digest('hex')
  .slice(0, 8);
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8')
  .replace('href="style.css"', `href="style.css?v=${assetVer}"`)
  .replace('src="app.js"', `src="app.js?v=${assetVer}"`);

app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(indexHtml);
});
app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    // JS/CSS are always requested with a ?v= hash, so they're safe to pin.
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

app.listen(env.port, () => {
  console.log(`Leesmap running on http://0.0.0.0:${env.port}`);
  if (!env.primaryFeedUrl) console.warn('  ! DC_RSS_URL not set');
  if (!env.cookie && !(env.email && env.password))
    console.warn('  ! No DC auth: set DC_EMAIL + DC_PASSWORD (or DC_COOKIE) — full text will fail');
});

startScheduler();
