// Disk store for hand-published EPUBs — the "Publiceer naar OPDS" button in
// the UI drops a one-off selection here, separate from the nightly digest
// store (digests.js) so a manual publish never collides with or gets
// overwritten by that night's automatic run.
//
// Split by source into its own subfolder (published/<source>/...) — enough
// separation to keep De Correspondent and Brabants Dagblad shelves apart on
// the OPDS side without needing source-prefixed filenames.

import { readdir, stat, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config.js';

// <timestamp>-<slug>.epub, e.g. 20260710T181234-mijn-selectie.epub
const PUBLISHED_FILENAME_RE = /^[0-9]{8}T[0-9]{6}-[a-z0-9-]+\.epub$/;

// Only these may appear as a path segment — guards against path traversal via
// the `source` value the same way PUBLISHED_FILENAME_RE guards `filename`.
const SOURCES = ['decorrespondent', 'bd', 'calibre'];
function safeSource(source) {
  return SOURCES.includes(source) ? source : 'decorrespondent';
}

export function publishedDir(source = 'decorrespondent') {
  return join(env.dataDir, 'published', safeSource(source));
}

async function ensurePublishedDir(source) {
  const dir = publishedDir(source);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

function sidecarPath(dir, filename) {
  return join(dir, filename.replace(/\.epub$/, '.json'));
}

function slug(s) {
  return (s || 'publicatie')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'publicatie';
}

// Save a built EPUB buffer under a fresh, collision-free filename, alongside a
// small JSON sidecar carrying the human title (filenames are slugged/truncated
// and can't round-trip that on their own).
export async function savePublished(buffer, title, source = 'decorrespondent') {
  const dir = await ensurePublishedDir(source);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const filename = `${stamp}-${slug(title)}.epub`;
  const publishedAt = new Date().toISOString();
  await writeFile(join(dir, filename), buffer);
  await writeFile(sidecarPath(dir, filename), JSON.stringify({ title: title || 'Publicatie', publishedAt }));
  return { filename, title: title || 'Publicatie', publishedAt };
}

// List published EPUBs, newest first.
export async function listPublished(source = 'decorrespondent') {
  const dir = await ensurePublishedDir(source);
  const names = (await readdir(dir)).filter((n) => PUBLISHED_FILENAME_RE.test(n));
  const withMeta = await Promise.all(
    names.map(async (filename) => {
      const s = await stat(join(dir, filename));
      let meta = {};
      try {
        meta = JSON.parse(await readFile(sidecarPath(dir, filename), 'utf8'));
      } catch {
        /* missing/corrupt sidecar: fall back to filename + mtime below */
      }
      return {
        filename,
        title: meta.title || filename.replace(/\.epub$/, ''),
        publishedAt: meta.publishedAt || s.mtime.toISOString(),
        mtime: s.mtime,
      };
    })
  );
  return withMeta.sort((a, b) => b.mtime - a.mtime);
}

// Resolve a requested filename to a safe path inside the published store, or
// null if it doesn't match the expected shape (guards against path traversal).
export function publishedFilePath(filename, source = 'decorrespondent') {
  if (!PUBLISHED_FILENAME_RE.test(filename)) return null;
  return join(publishedDir(source), filename);
}

export async function deletePublished(filename, source = 'decorrespondent') {
  if (!PUBLISHED_FILENAME_RE.test(filename)) return false;
  const dir = publishedDir(source);
  await unlink(join(dir, filename)).catch(() => {});
  await unlink(sidecarPath(dir, filename)).catch(() => {});
  return true;
}

// Wipe every published EPUB (+ sidecar) for one source — used by the nightly
// BD-clear job (scheduler.js): bd.nl articles are daily news, so unlike De
// Correspondent's shelf they shouldn't accumulate indefinitely. Returns the
// .epub filenames removed.
export async function clearPublished(source) {
  const dir = await ensurePublishedDir(source);
  const names = await readdir(dir);
  await Promise.all(names.map((n) => unlink(join(dir, n)).catch(() => {})));
  return names.filter((n) => PUBLISHED_FILENAME_RE.test(n));
}
