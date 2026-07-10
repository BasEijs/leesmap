// Central configuration. Secrets come from the environment only.
// Mutable, non-secret preferences (device IP, saved feeds) live in a small
// JSON file inside DATA_DIR so they survive container restarts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const env = {
  port: Number(process.env.PORT) || 8080,
  // Your personal De Correspondent RSS feed (all publications).
  primaryFeedUrl: process.env.DC_RSS_URL || '',
  // Manual fallback: the full `Cookie:` header value copied from a logged-in
  // browser session. If set, it wins over automatic login (see session.js).
  cookie: process.env.DC_COOKIE || '',
  // Preferred: log in automatically with these. Never commit them.
  email: process.env.DC_EMAIL || '',
  password: process.env.DC_PASSWORD || '',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Leesmap/1.0',
  // Optional HTTP basic auth for the web UI itself.
  basicUser: process.env.BASIC_AUTH_USER || '',
  basicPass: process.env.BASIC_AUTH_PASS || '',
  // Optional second gate, narrower than BASIC_AUTH_*: guards settings and the
  // send/publish actions specifically, so the app can be shared (e.g. with a
  // less technical family member) without letting them reconfigure or trigger
  // sends by accident, while everything else (browsing, download) stays open.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  dataDir: process.env.DATA_DIR || '/data',
  // Send-to-PocketBook: mailing the nightly digest to the device's own
  // username@pbsync.com address (see scheduler.js). Unlike the X4's OPDS
  // pull, PocketBook Cloud downloads to the device automatically once WiFi is
  // on — no on-device browsing needed. Unset POCKETBOOK_EMAIL to skip this
  // channel entirely; OPDS keeps working either way.
  pocketbookEmail: process.env.POCKETBOOK_EMAIL || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  // Must match (or already be on) the pbsync.com trusted-sender white list —
  // PocketBook silently drops mail from senders it doesn't recognise, though
  // the first one prompts an email confirmation to add them. Defaults to
  // SMTP_USER since that's what most providers require as the envelope sender.
  smtpFrom: process.env.SMTP_FROM || process.env.SMTP_USER || '',
};

const SETTINGS_PATH = join(env.dataDir, 'settings.json');

const defaults = {
  // Where CrossPoint listens. Own hotspot: 192.168.4.1 / crosspoint.local.
  // On your home WiFi it's whatever DHCP handed the reader.
  deviceIp: process.env.X4_IP || '192.168.4.1',
  // Extra named feeds you save from the UI (collections, custom URLs…).
  feeds: [],
  // Nightly digest (see scheduler.js): off by default, opt in from settings.
  digestEnabled: false,
  // Local hour (0-23, server time) the nightly digest cron fires.
  digestHour: 3,
  // ISO timestamp of the last successful digest run. Articles are filtered on
  // `date > lastDigestRun` (not a fixed 24h window) so a missed night is caught
  // up and nothing ships twice. Null until the digest has run at least once.
  lastDigestRun: null,
  // Whether the nightly digest also gets emailed to POCKETBOOK_EMAIL (see
  // scheduler.js). Independent of digestEnabled and of the manual "Verstuur
  // naar Pocketbook" button. Defaults to on (matches the original behaviour,
  // before this toggle existed, of always sending whenever SMTP/POCKETBOOK_EMAIL
  // were configured) — has no effect unless pocketbook.js's isConfigured() is true.
  pocketbookNightlyEnabled: true,
  // Correspondent profile slugs shown as an avatar grid; clicking one loads
  // that correspondent's feed. Resolved to name/avatar at runtime.
  // Slugs come from decorrespondent.nl/correspondenten (the last path segment
  // of each profile link). Manage the list in the settings drawer.
  correspondents: [
    'lynnberger',
    'michieldehoog',
    'robwijnberg',
    'rutgerbregman',
    'jessefrederik',
    'maitevermeulen',
    'jelmermommers',
    'mauritsmartijn',
    'thomasoudman',
    'sanneblauw',
    'lexbohlmeijer',
    'rinkeverkerk',
    'marjolijnvanheemstra',
    'tamarstelling',
    'johannesvisser',
  ],
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
