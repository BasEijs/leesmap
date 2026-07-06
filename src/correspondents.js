// A correspondent is just a De Correspondent profile slug (e.g. "lynnberger").
// Their per-correspondent feed lives at /feed/v1/profile/<slug>, and that feed's
// channel <image> + <title> already carry the avatar, display name and beat —
// so we resolve everything the grid needs straight from the feed, no scraping.

import Parser from 'rss-parser';
import { env } from './config.js';
import { fetchWithSession } from './session.js';

const parser = new Parser();

// Resolved {slug, name, beat, avatar, feedUrl} cached in memory so a page load
// with a dozen correspondents doesn't hammer De Correspondent every time.
const cache = new Map(); // slug -> { data, ts }
const TTL = 6 * 60 * 60 * 1000; // 6h

export function feedUrlFor(slug) {
  return `https://decorrespondent.nl/feed/v1/profile/${slug}`;
}

// Accepts a bare slug, a profile URL (/lynnberger), or a feed URL
// (/feed/v1/profile/lynnberger) and returns the slug.
export function slugFromInput(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  // Normalise to a full URL: a real URL is used as-is; a scheme-less host
  // ("decorrespondent.nl/…") gets https://; a bare slug/path hangs off the DC
  // host. Distinguishing a host from a slug is what the dotted-domain test does.
  let urlStr;
  if (/:\/\//.test(raw)) urlStr = raw;
  else if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw)) urlStr = 'https://' + raw;
  else urlStr = 'https://decorrespondent.nl/' + raw.replace(/^\/+/, '');
  try {
    const u = new URL(urlStr);
    const feed = u.pathname.match(/\/feed\/v1\/profile\/([^/?#]+)/);
    if (feed) return decodeURIComponent(feed[1]);
    const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
    return decodeURIComponent(seg || '');
  } catch {
    return raw.replace(/^\/+|\/+$/g, '').split('/')[0];
  }
}

// Split "Lynn Berger - Correspondent Zorg" into name + beat.
function splitTitle(title) {
  const t = (title || '').trim();
  const dash = t.indexOf(' - ');
  if (dash === -1) return { name: t, beat: '' };
  return { name: t.slice(0, dash).trim(), beat: t.slice(dash + 3).trim() };
}

export async function resolveCorrespondent(slug) {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  const feedUrl = feedUrlFor(slug);
  const res = await fetchWithSession(feedUrl, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': env.userAgent,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!res.ok) {
    const e = new Error(`Kon correspondent niet vinden (HTTP ${res.status}).`);
    e.status = res.status === 404 ? 404 : 502;
    throw e;
  }
  const feed = await parser.parseString(await res.text());
  const { name, beat } = splitTitle(feed.title);
  const data = {
    slug,
    name: name || slug,
    beat,
    // The channel <image><url> is the correspondent's avatar (a signed CDN URL).
    avatar: feed.image?.url || '',
    feedUrl,
  };
  cache.set(slug, { data, ts: Date.now() });
  return data;
}

// Resolve a list of slugs, keeping order and dropping ones that fail to load
// (a renamed/removed correspondent shouldn't break the whole grid).
export async function resolveAll(slugs) {
  const out = await Promise.all(
    (slugs || []).map((slug) =>
      resolveCorrespondent(slug).catch(() => ({
        slug,
        name: slug,
        beat: '',
        avatar: '',
        feedUrl: feedUrlFor(slug),
        error: true,
      }))
    )
  );
  return out;
}
