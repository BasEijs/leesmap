// Builds EPUB files from prepared chapters. We target EPUB 2, which the X4 /
// CrossPoint renders most reliably, and ship deliberately plain CSS so it
// reads well on a small greyscale panel without fighting the reader's own
// typography settings.

import epubPkg from 'epub-gen-memory';
import { coverFile } from './cover.js';
const epub = epubPkg.default ?? epubPkg; // CJS/ESM interop

// "6 juli 2026" — a human date for the cover footer.
function dutchDate(d = new Date()) {
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

const EINK_CSS = `
  body { font-family: serif; line-height: 1.5; margin: 0; }
  h1 { font-size: 1.4em; line-height: 1.25; margin: 0 0 0.6em; }
  h2 { font-size: 1.15em; margin: 1.2em 0 0.4em; }
  h3 { font-size: 1.05em; margin: 1em 0 0.3em; }
  p { margin: 0 0 0.8em; text-align: left; }
  a { color: inherit; text-decoration: underline; }
  blockquote { margin: 0.8em 1em; font-style: italic; }
  figure { margin: 1em 0; }
  img { max-width: 100%; height: auto; }
  figcaption { font-size: 0.85em; font-style: italic; margin-top: 0.3em; }
  .dc-byline { font-style: italic; margin: 0 0 1em; }
  .dc-source { font-size: 0.8em; margin-top: 1.5em; }
`;

function slug(s) {
  return (s || 'artikel')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'artikel';
}

function chapterHtml(ch) {
  const byline = ch.author ? `<p class="dc-byline">${ch.author}</p>` : '';
  const source = ch.sourceUrl
    ? `<p class="dc-source">Bron: <a href="${ch.sourceUrl}">De Correspondent</a></p>`
    : '';
  return `${byline}${ch.content}${source}`;
}

async function render(options, chapters) {
  return epub(
    {
      lang: 'nl',
      tocTitle: 'Inhoud',
      publisher: 'De Correspondent',
      css: EINK_CSS,
      ignoreFailedDownloads: true,
      ...options,
    },
    chapters.map((ch) => ({
      title: ch.title,
      author: ch.author || undefined,
      content: chapterHtml(ch),
    })),
    2 // EPUB version 2
  );
}

// One article -> one EPUB.
export async function buildSingle(chapter) {
  const buffer = await render(
    {
      title: chapter.title,
      author: chapter.author || 'De Correspondent',
      description: chapter.excerpt,
      cover: await coverFile({
        title: chapter.title,
        subtitle: chapter.author || undefined,
        footer: dutchDate(),
        // Single-article covers get the correspondent's round portrait (photo
        // when we matched one, otherwise an initials monogram).
        portrait: true,
        avatar: chapter.avatar || undefined,
      }),
      // Single article: the chapter title would just repeat the book title.
      prependChapterTitles: false,
    },
    [chapter]
  );
  const authorSlug = chapter.author ? slug(chapter.author) : '';
  const filename = authorSlug
    ? `dc-${authorSlug}-${slug(chapter.title)}.epub`
    : `dc-${slug(chapter.title)}.epub`;
  return { buffer, filename };
}

// "Sanne Blauw", "Sanne Blauw & Rutger Bregman", or "Sanne Blauw e.a." for
// three or more — a readable stand-in for "Leesmap" when nobody typed a title.
function authorsLabel(names) {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} e.a.`;
}

// Several articles -> one EPUB, one chapter each, with a table of contents.
export async function buildBundle(chapters, { title } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const count = chapters.length;

  // The distinct authors in the selection, in first-appearance order, each with
  // their portrait (when we matched one). The cover draws these as a row of
  // small circles under "N artikelen".
  const seen = new Set();
  const portraits = [];
  for (const ch of chapters) {
    const author = (ch.author || '').trim();
    if (!author) continue;
    const key = author.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    portraits.push({ author, avatar: ch.avatar || undefined });
  }

  const autoTitle = authorsLabel(portraits.map((p) => p.author));
  const coverTitle = title || autoTitle || 'Leesmap';
  const bookTitle = title || (autoTitle ? `De Correspondent — ${autoTitle}` : `De Correspondent — selectie ${today}`);

  const buffer = await render(
    {
      title: bookTitle,
      author: 'De Correspondent',
      description: `Selectie van ${count} artikelen.`,
      cover: await coverFile({
        title: coverTitle,
        subtitle: `${count} ${count === 1 ? 'artikel' : 'artikelen'}`,
        footer: dutchDate(),
        portraits,
      }),
    },
    chapters
  );
  // Filename carries the correspondent names too (same list as the cover),
  // so a downloaded bundle is identifiable without opening it.
  const authorsSlug = autoTitle ? slug(autoTitle) : '';
  const filename = authorsSlug
    ? `dc-selectie-${authorsSlug}-${today}.epub`
    : `dc-selectie-${today}.epub`;
  return { buffer, filename };
}
