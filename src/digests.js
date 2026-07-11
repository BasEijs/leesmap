// Disk store for generated digest EPUBs, shared between the (future) nightly
// generator and the OPDS publisher routes in server.js.

import { readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config.js';

// One file per calendar day, Dutch date order: 10-07-2026.epub
const DIGEST_FILENAME_RE = /^(\d{2})-(\d{2})-(\d{4})\.epub$/;

// Keep the OPDS feed from growing forever: drop digest EPUBs past this age.
const MAX_DIGEST_AGE_DAYS = 7;

export function digestsDir() {
  return join(env.dataDir, 'digests');
}

async function ensureDigestsDir() {
  const dir = digestsDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

// DD-MM-YYYY.epub -> YYYY-MM-DD, so dates compare/sort correctly regardless
// of the filename's display order.
function isoDate(filename) {
  const m = filename.match(DIGEST_FILENAME_RE);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// List digest EPUBs, newest first.
export async function listDigests() {
  const dir = await ensureDigestsDir();
  const names = (await readdir(dir)).filter((n) => DIGEST_FILENAME_RE.test(n));
  const withStats = await Promise.all(
    names.map(async (filename) => {
      const s = await stat(join(dir, filename));
      return { filename, date: isoDate(filename), size: s.size, mtime: s.mtime };
    })
  );
  return withStats.sort((a, b) => b.date.localeCompare(a.date));
}

// Resolve a requested filename to a safe path inside the digest store, or null
// if it doesn't match the expected shape (guards against path traversal).
export function digestFilePath(filename) {
  if (!DIGEST_FILENAME_RE.test(filename)) return null;
  return join(digestsDir(), filename);
}

// Delete digest EPUBs older than MAX_DIGEST_AGE_DAYS (by filename date, not
// mtime). Returns the filenames removed. Runs independently of digestEnabled
// so the OPDS feed stays clean even if nightly generation gets turned off.
export async function pruneOldDigests() {
  const dir = await ensureDigestsDir();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DIGEST_AGE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const names = (await readdir(dir)).filter((n) => DIGEST_FILENAME_RE.test(n));
  const removed = names.filter((n) => isoDate(n) < cutoffStr);
  await Promise.all(removed.map((n) => unlink(join(dir, n)).catch(() => {})));
  return removed;
}
