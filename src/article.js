// Turns a De Correspondent article URL into clean, EPUB-ready HTML.
//
//   fetch page (with your cookie) -> Readability -> handle images
//
// Images are either stripped (default, tiny + perfect on e-ink) or embedded.
// When embedding we download each image ourselves with the right headers and
// re-point it at our own /media route so the EPUB builder can pull it locally.

import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { env } from './config.js';
import { fetchWithSession } from './session.js';
import { put as putMedia } from './media.js';
import { avatarUrlForAuthor } from './correspondents.js';

const MIN_CHARS = 250; // below this, extraction almost certainly failed

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

async function fetchPage(url) {
  // fetchWithSession injects the session cookie and, if it has expired,
  // re-logs-in once and retries before this returns.
  const res = await fetchWithSession(url, {
    headers: {
      'User-Agent': env.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'nl,en;q=0.8',
    },
  });
  if (!res.ok) {
    const e = new Error(`Kon artikel niet ophalen (HTTP ${res.status}). ` +
      (res.status === 401 || res.status === 403
        ? 'Inloggen bij De Correspondent lukte niet — controleer DC_EMAIL/DC_PASSWORD.'
        : ''));
    e.status = 502;
    throw e;
  }
  // A silently-followed redirect to /inloggen returns 200 with the login page —
  // without this check we'd bind the login page as if it were the article.
  if (landedOnLogin(res)) {
    const e = new Error(
      'Geen toegang tot dit artikel — De Correspondent stuurde de loginpagina ' +
        'terug. Sessie ongeldig: controleer DC_EMAIL/DC_PASSWORD (of DC_COOKIE).'
    );
    e.status = 502;
    throw e;
  }
  return res.text();
}

// Did we end up on the login page after following redirects?
function landedOnLogin(res) {
  try {
    return new URL(res.url).pathname.startsWith('/inloggen');
  } catch {
    return false;
  }
}

function extract(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const article = new Readability(doc).parse();
  if (!article || (article.textContent || '').trim().length < MIN_CHARS) {
    const e = new Error(
      'Kon de hoofdtekst niet uit deze pagina halen. Mogelijk vereist de ' +
        'pagina JavaScript, of de cookie geeft geen toegang tot dit artikel.'
    );
    e.status = 422;
    throw e;
  }
  const cleanTitle = (article.title || 'Zonder titel')
    .replace(/\s*[-–|]\s*De Correspondent\s*$/i, '')
    .trim();
  return {
    title: cleanTitle || 'Zonder titel',
    byline: (article.byline || '').trim(),
    html: article.content, // sanitized HTML from Readability
    excerpt: (article.excerpt || '').trim(),
  };
}

// Absolute-ise a possibly relative image URL against the article URL.
function absolutize(src, base) {
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

async function downloadImage(src, articleUrl) {
  const res = await fetchWithSession(src, {
    headers: {
      'User-Agent': env.userAgent,
      Referer: articleUrl,
      Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || 'image/jpeg')
    .split(';')[0]
    .trim();
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

// Process the Readability HTML according to the image mode.
// mediaBase is the localhost origin the EPUB builder will fetch from.
async function handleImages(htmlContent, { mode, articleUrl, mediaBase }) {
  const dom = new JSDOM(`<body>${htmlContent}</body>`);
  const doc = dom.window.document;

  if (mode !== 'embed') {
    // strip: remove figures/images entirely for a clean text-only read
    doc.querySelectorAll('figure, img, picture, source, svg').forEach((n) =>
      n.remove()
    );
    return doc.body.innerHTML;
  }

  const imgs = [...doc.querySelectorAll('img')];
  for (const img of imgs) {
    const raw =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      (img.getAttribute('srcset') || '').split(' ')[0];
    const abs = raw ? absolutize(raw, articleUrl) : null;
    if (!abs || abs.startsWith('data:')) {
      img.remove();
      continue;
    }
    try {
      const { buffer, contentType } = await downloadImage(abs, articleUrl);
      const ext = EXT_BY_TYPE[contentType] || 'jpg';
      const id = `${randomUUID()}.${ext}`;
      putMedia(id, buffer, contentType);
      img.setAttribute('src', `${mediaBase}/media/${id}`);
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
    } catch {
      // Drop images we can't fetch rather than fail the whole article.
      const fig = img.closest('figure');
      if (fig) fig.remove();
      else img.remove();
    }
  }
  return doc.body.innerHTML;
}

// Lightweight metadata for a single article URL, shaped like a feed item so
// the UI can list a pasted article link without RSS. No image handling — we
// only need title/author/excerpt for the list.
export async function articleToFeedItem(url) {
  const page = await fetchPage(url);
  const art = extract(page, url);
  return {
    title: art.title,
    author: art.byline,
    link: url,
    date: '',
    snippet: (art.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 320),
    id: url,
  };
}

// Best-effort: the correspondent portrait for this byline, as image bytes for
// the EPUB cover. Never throws — a missing/failed avatar just yields null and
// the cover falls back to a monogram.
async function authorAvatar(byline, articleUrl) {
  try {
    const url = await avatarUrlForAuthor(byline);
    if (!url) return null;
    const { buffer } = await downloadImage(url, articleUrl);
    return buffer;
  } catch {
    return null;
  }
}

// Full pipeline for one URL. Returns a chapter-ready object.
// `withAvatar` fetches the correspondent portrait for the cover; only the
// single-article path needs it (a bundle cover shows no single portrait).
export async function articleToChapter(url, { images, mediaBase, withAvatar }) {
  const page = await fetchPage(url);
  const art = extract(page, url);
  const html = await handleImages(art.html, {
    mode: images === 'embed' ? 'embed' : 'strip',
    articleUrl: url,
    mediaBase,
  });
  return {
    title: art.title,
    author: art.byline,
    excerpt: art.excerpt,
    content: html,
    sourceUrl: url,
    avatar: withAvatar ? await authorAvatar(art.byline, url) : null,
  };
}
