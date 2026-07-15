// Talks to a Calibre-Web instance's OPDS feed so leesmap can browse the
// library and copy a chosen book's EPUB onto its own "Gepubliceerd —
// Calibre-Web" OPDS shelf (see published.js / opds.js). Calibre-Web already
// *is* an OPDS server; this is just the curated-push half — we read its feed,
// let the user pick, then pull that one EPUB through and re-publish it.
//
// Verified against a live Calibre-Web feed: the root nav lives at /opds, full
// text search at /opds/search/{term}, recently-added at /opds/new (paged with
// ?offset=), and each book <entry> carries a cover link
// (rel="http://opds-spec.org/image") plus an acquisition link
// (rel="http://opds-spec.org/acquisition", type="application/epub+zip",
// href="/opds/download/<id>/epub/").

import { JSDOM } from 'jsdom';
import { env } from './config.js';

const IMAGE_REL = 'http://opds-spec.org/image';
const ACQ_REL = 'http://opds-spec.org/acquisition';

export function isConfigured() {
  return Boolean(env.calibreWebUrl);
}

function requireConfigured() {
  if (!isConfigured()) {
    const e = new Error('Calibre-Web niet geconfigureerd (CALIBRE_WEB_URL ontbreekt).');
    e.status = 400;
    throw e;
  }
}

function authHeaders() {
  if (!env.calibreWebUser && !env.calibreWebPass) return {};
  const token = Buffer.from(`${env.calibreWebUser}:${env.calibreWebPass}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

// Resolve a possibly-relative OPDS href against the configured Calibre-Web
// root, and refuse anything that would leave that origin — the download/cover
// hrefs come back to us from the browser, so this is the SSRF guard.
function resolveInternal(href) {
  const base = new URL(env.calibreWebUrl + '/');
  const url = new URL(href, base);
  if (url.origin !== base.origin) {
    const e = new Error('Ongeldige Calibre-Web-URL.');
    e.status = 400;
    throw e;
  }
  return url;
}

async function fetchCalibre(url, accept) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': env.userAgent,
      Accept: accept,
      ...authHeaders(),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error(
      'Calibre-Web weigerde toegang (401/403). Zet CALIBRE_WEB_USER/PASS, of schakel anoniem bladeren in.'
    );
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Kon Calibre-Web niet bereiken (HTTP ${res.status}).`);
    e.status = 502;
    throw e;
  }
  return res;
}

// First <link> on `entry` whose rel matches (rel can carry several values).
function linkByRel(entry, rel) {
  for (const link of entry.getElementsByTagName('link')) {
    const rels = (link.getAttribute('rel') || '').split(/\s+/);
    if (rels.includes(rel)) return link;
  }
  return null;
}

function text(entry, tag) {
  const el = entry.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

// Normalise one OPDS book <entry> into the small shape the UI renders. Returns
// null for nav entries (no epub acquisition link) so feed-level entries and
// non-epub formats are silently skipped.
function mapEntry(entry) {
  const acq = linkByRel(entry, ACQ_REL);
  const href = acq && acq.getAttribute('href');
  if (!href || !/epub/i.test(acq.getAttribute('type') || '')) return null;

  const authorEl = entry.getElementsByTagName('author')[0];
  const author = authorEl ? (authorEl.getElementsByTagName('name')[0]?.textContent || '').trim() : '';
  const cover = linkByRel(entry, IMAGE_REL);

  return {
    id: text(entry, 'id'),
    title: text(entry, 'title') || 'Zonder titel',
    author,
    epubHref: href,
    coverHref: cover ? cover.getAttribute('href') : '',
  };
}

// Search the library (empty query -> most recently added). Returns up to the
// one OPDS page Calibre-Web hands back (~60 books).
export async function searchBooks(query) {
  requireConfigured();
  const q = (query || '').trim();
  const path = q ? `/opds/search/${encodeURIComponent(q)}` : '/opds/new';
  const res = await fetchCalibre(
    resolveInternal(path),
    'application/atom+xml, application/xml, text/xml, */*'
  );
  const dom = new JSDOM(await res.text(), { contentType: 'application/xml' });
  const entries = dom.window.document.getElementsByTagName('entry');
  return Array.from(entries).map(mapEntry).filter(Boolean);
}

// Pull a book's EPUB through Calibre-Web (with our stored credentials, if any)
// and hand back the raw bytes for savePublished(). `epubHref` is whatever the
// entry's acquisition link carried; resolveInternal() keeps it on-origin.
export async function fetchEpub(epubHref) {
  requireConfigured();
  const res = await fetchCalibre(resolveInternal(epubHref), 'application/epub+zip, */*');
  return Buffer.from(await res.arrayBuffer());
}

// Proxy a cover image through leesmap so the UI can show it regardless of
// mixed-content / auth (covers may sit behind the same Basic Auth).
export async function fetchCover(coverHref) {
  requireConfigured();
  const res = await fetchCalibre(resolveInternal(coverHref), 'image/*');
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'image/jpeg',
  };
}
