// Disk store for hand-published EPUBs — the "Publiceer naar OPDS" button in
// the UI drops a one-off selection here, separate from the nightly digest
// store (digests.js) so a manual publish never collides with or gets
// overwritten by that night's automatic run.

import { readdir, stat, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config.js';

// <timestamp>-<slug>.epub, e.g. 20260710T181234-mijn-selectie.epub
const PUBLISHED_FILENAME_RE = /^[0-9]{8}T[0-9]{6}-[a-z0-9-]+\.epub$/;

export function publishedDir() {
  return join(env.dataDir, 'published');
}

async function ensurePublishedDir() {
  const dir = publishedDir();
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
export async function savePublished(buffer, title) {
  const dir = await ensurePublishedDir();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const filename = `${stamp}-${slug(title)}.epub`;
  const publishedAt = new Date().toISOString();
  await writeFile(join(dir, filename), buffer);
  await writeFile(sidecarPath(dir, filename), JSON.stringify({ title: title || 'Publicatie', publishedAt }));
  return { filename, title: title || 'Publicatie', publishedAt };
}

// List published EPUBs, newest first.
export async function listPublished() {
  const dir = await ensurePublishedDir();
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
export function publishedFilePath(filename) {
  if (!PUBLISHED_FILENAME_RE.test(filename)) return null;
  return join(publishedDir(), filename);
}

export async function deletePublished(filename) {
  if (!PUBLISHED_FILENAME_RE.test(filename)) return false;
  const dir = publishedDir();
  await unlink(join(dir, filename)).catch(() => {});
  await unlink(sidecarPath(dir, filename)).catch(() => {});
  return true;
}
