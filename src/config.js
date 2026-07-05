// Central configuration. Secrets come from the environment only.
// Mutable, non-secret preferences (device IP, saved feeds) live in a small
// JSON file inside DATA_DIR so they survive container restarts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const env = {
  port: Number(process.env.PORT) || 8080,
  // Your personal De Correspondent RSS feed (all publications).
  primaryFeedUrl: process.env.DC_RSS_URL || '',
  // The full `Cookie:` header value copied from a logged-in browser session.
  cookie: process.env.DC_COOKIE || '',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Leesmap/1.0',
  // Optional HTTP basic auth for the web UI itself.
  basicUser: process.env.BASIC_AUTH_USER || '',
  basicPass: process.env.BASIC_AUTH_PASS || '',
  dataDir: process.env.DATA_DIR || '/data',
};

const SETTINGS_PATH = join(env.dataDir, 'settings.json');

const defaults = {
  // Where CrossPoint listens. Own hotspot: 192.168.4.1 / crosspoint.local.
  // On your home WiFi it's whatever DHCP handed the reader.
  deviceIp: process.env.X4_IP || '192.168.4.1',
  // Extra named feeds you save from the UI (correspondents, collections…).
  feeds: [],
};

function ensureDir() {
  try {
    if (!existsSync(env.dataDir)) mkdirSync(env.dataDir, { recursive: true });
  } catch {
    /* read-only /data is fine; we just won't persist */
  }
}

export function loadSettings() {
  ensureDir();
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(next) {
  ensureDir();
  const merged = { ...loadSettings(), ...next };
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  } catch (err) {
    // Non-fatal: settings just won't persist if /data isn't writable.
    console.warn('Could not persist settings:', err.message);
  }
  return merged;
}
