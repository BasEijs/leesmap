// Nightly digest generator. Started once from server.js; runs in-process on
// node-cron, isolated from the Express routes — just another consumer of the
// same library functions the manual /api/send route uses.
//
// Pipeline mirrors /api/send up to the EPUB, then stops: it writes the digest
// to disk instead of calling device.js's upload(), because the X4's WiFi is
// off while it sleeps (see leesmap-plan.md). The OPDS routes in server.js
// serve whatever lands in the digest store.

import cron from 'node-cron';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env, loadSettings, saveSettings } from './config.js';
import { parseFeed } from './feed.js';
import { articleToChapter } from './article.js';
import { buildBundle } from './epub.js';
import { digestsDir, pruneOldDigests } from './digests.js';
import { isConfigured as pocketbookConfigured, sendToPocketbook } from './pocketbook.js';
import { localDateStr } from './dateutil.js';

const mediaBase = `http://127.0.0.1:${env.port}`;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function dutchDate(d) {
  return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }).format(d);
}

// Exported for manual/test invocation; startScheduler() below is what cron calls.
export async function runDigest() {
  const settings = loadSettings();
  if (!settings.digestEnabled) return;
  if (!env.primaryFeedUrl) {
    console.warn('[scheduler] DC_RSS_URL not set, skipping digest');
    return;
  }

  const now = new Date();
  // No prior run: look back one day (the digest's normal window) rather than
  // either shipping the feed's entire backlog or nothing.
  const since = settings.lastDigestRun ? new Date(settings.lastDigestRun) : new Date(now - ONE_DAY_MS);

  let feed;
  try {
    feed = await parseFeed(env.primaryFeedUrl);
  } catch (err) {
    console.error('[scheduler] Could not fetch feed, will retry next run:', err.message);
    return; // leave lastDigestRun untouched
  }

  const items = feed.items.filter((it) => {
    const d = new Date(it.date);
    return !Number.isNaN(d.getTime()) && d > since;
  });

  if (items.length === 0) {
    console.log('[scheduler] No new articles since', since.toISOString());
    saveSettings({ lastDigestRun: now.toISOString() });
    return;
  }

  const chapters = [];
  const includedDates = [];
  for (const item of items) {
    try {
      chapters.push(await articleToChapter(item.link, { images: 'strip', mediaBase, withAvatar: true }));
      includedDates.push(new Date(item.date));
    } catch (err) {
      console.error(`[scheduler] Skipping "${item.title}":`, err.message);
    }
  }

  if (chapters.length === 0) {
    console.warn('[scheduler] All articles failed to fetch; not advancing lastDigestRun, will retry next run');
    return;
  }

  // Name the digest after the articles it contains (most recent one), not the
  // 03:00 run time — articles are typically published the day before the run.
  const digestDate = new Date(Math.max(...includedDates.map((d) => d.getTime())));

  const title = `De Correspondent — ${dutchDate(digestDate)}`;
  const { buffer } = await buildBundle(chapters, { title });

  const dir = digestsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = `${localDateStr(digestDate)}.epub`;
  writeFileSync(join(dir, filename), buffer);
  console.log(`[scheduler] Wrote ${filename} with ${chapters.length}/${items.length} article(s)`);

  // Second delivery channel, same EPUB: OPDS (above) already has it, this is
  // additive and never blocks lastDigestRun from advancing.
  if (settings.pocketbookNightlyEnabled && pocketbookConfigured()) {
    try {
      await sendToPocketbook(buffer, filename, title);
      console.log(`[scheduler] Emailed ${filename} to Pocketbook`);
    } catch (err) {
      console.error('[scheduler] Pocketbook send failed:', err.message);
    }
  }

  saveSettings({ lastDigestRun: now.toISOString() });
}

// Fires every hour and checks the *current* digestHour setting, rather than
// baking a fixed hour into the cron pattern at startup — so changing the hour
// (or enabling/disabling) in settings takes effect without a restart.
export function startScheduler() {
  cron.schedule('0 * * * *', () => {
    pruneOldDigests()
      .then((removed) => {
        if (removed.length) console.log(`[scheduler] Pruned ${removed.length} old digest(s):`, removed.join(', '));
      })
      .catch((err) => console.error('[scheduler] Prune failed:', err.message));

    const { digestHour } = loadSettings();
    const hour = Number.isInteger(digestHour) ? digestHour : 3;
    if (new Date().getHours() !== hour) return;
    runDigest().catch((err) => console.error('[scheduler] Unexpected error:', err));
  });
  console.log('[scheduler] Hourly check armed (runs when the clock hits digestHour, if digestEnabled)');
}
