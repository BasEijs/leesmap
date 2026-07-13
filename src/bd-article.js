// Turns raw article-page HTML captured by the browser extension into
// EPUB-ready chapter content. Unlike article.js there's no fetching or
// session handling here at all — the browser tab was already logged into
// bd.nl normally, so by the time this runs the paywalled body text is just
// sitting in the HTML the extension sent. This only runs the same Readability
// step article.js uses for De Correspondent, then strips images (text-only,
// same e-ink-friendly default as the rest of the app).

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const MIN_CHARS = 250; // below this, extraction almost certainly failed

function extract(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const article = new Readability(doc).parse();
  if (!article || (article.textContent || '').trim().length < MIN_CHARS) {
    const e = new Error(
      'Kon de hoofdtekst niet uit deze pagina halen — is dit een artikelpagina, ' +
        'en was je ingelogd toen je hem opende?'
    );
    e.status = 422;
    throw e;
  }
  const cleanTitle = (article.title || 'Zonder titel')
    .replace(/\s*[-–|]\s*(Brabants Dagblad|BD\.nl|BD)\s*$/i, '')
    .trim();
  return {
    title: cleanTitle || 'Zonder titel',
    byline: (article.byline || '').trim(),
    html: article.content, // sanitized HTML from Readability
    excerpt: (article.excerpt || '').trim(),
  };
}

// Text-only: drop figures/images entirely, same default as article.js's
// 'strip' image mode (tiny files, perfect on the e-ink panel).
function stripImages(htmlContent) {
  const dom = new JSDOM(`<body>${htmlContent}</body>`);
  const doc = dom.window.document;
  doc.querySelectorAll('figure, img, picture, source, svg').forEach((n) => n.remove());
  return doc.body.innerHTML;
}

// html: the full page HTML the extension captured. url: the article's own
// URL (for Readability's base-URL resolution and the "Bron" link).
export function bdArticleToChapter(html, url) {
  const art = extract(html, url);
  return {
    title: art.title,
    author: art.byline,
    excerpt: art.excerpt,
    content: stripImages(art.html),
    sourceUrl: url,
    avatar: null,
    publisher: 'Brabants Dagblad',
    source: 'bd',
  };
}
