import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { env, loadSettings, saveSettings } from './config.js';
import { parseFeed } from './feed.js';
import { articleToChapter } from './article.js';
import { buildSingle, buildBundle } from './epub.js';
import { probe, upload } from './device.js';
import { get as getMedia } from './media.js';

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

// --- Config & settings ---
app.get('/api/config', (req, res) => {
  const s = loadSettings();
  res.json({
    deviceIp: s.deviceIp,
    feeds: s.feeds,
    primaryFeedConfigured: Boolean(env.primaryFeedUrl),
    cookieConfigured: Boolean(env.cookie),
  });
});

app.post('/api/settings', (req, res) => {
  const { deviceIp, feeds } = req.body || {};
  const next = {};
  if (typeof deviceIp === 'string') next.deviceIp = deviceIp.trim();
  if (Array.isArray(feeds)) next.feeds = feeds;
  res.json(saveSettings(next));
});

// --- Feed ---
app.get('/api/feed', async (req, res) => {
  try {
    const feed = await parseFeed(req.query.url);
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
    if (mode === 'single') {
      const chapter = await articleToChapter(urls[0], { images, mediaBase });
      out = await buildSingle(chapter);
    } else {
      const chapters = [];
      for (const url of urls) chapters.push(await articleToChapter(url, { images, mediaBase }));
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

// --- Build + send to the reader, streaming progress as NDJSON ---
// body: { urls, mode, images, deviceIp, title }
app.post('/api/send', async (req, res) => {
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
      const chapter = await articleToChapter(url, { images, mediaBase });
      emit({ type: 'step', url, phase: 'extract', title: chapter.title });
      return chapter;
    };

    if (mode === 'single') {
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

app.use(express.static(join(__dirname, 'public')));

app.listen(env.port, () => {
  console.log(`Leesmap running on http://0.0.0.0:${env.port}`);
  if (!env.primaryFeedUrl) console.warn('  ! DC_RSS_URL not set');
  if (!env.cookie) console.warn('  ! DC_COOKIE not set (full text will 401/403)');
});
