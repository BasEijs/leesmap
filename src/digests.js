// Disk store for generated digest EPUBs, shared between the (future) nightly
// generator and the OPDS publisher routes in server.js.

import { readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config.js';

// One file per calendar day: 2026-07-09.epub
const DIGEST_FILENAME_RE = /^\d{4}-\d{2}-\d{2}\.epub$/;

export function digestsDir() {
  return join(env.dataDir, 'digests');
}

async function ensureDigestsDir() {
  const dir = digestsDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

// List digest EPUBs, newest first.
export async function listDigests() {
  const dir = await ensureDigestsDir();
  const names = (await readdir(dir)).filter((n) => DIGEST_FILENAME_RE.test(n));
  const withStats = await Promise.all(
    names.map(async (filename) => {
      const s = await stat(join(dir, filename));
      return { filename, date: filename.slice(0, 10), size: s.size, mtime: s.mtime };
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
