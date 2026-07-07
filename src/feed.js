// Reads a De Correspondent RSS feed (personal all-articles feed, or a
// per-correspondent / per-collection feed) and normalises the items into a
// small shape the UI can render. The feed only carries excerpts — the full
// body is fetched later, per article, in article.js.

import Parser from 'rss-parser';
import { env } from './config.js';
import { fetchWithSession } from './session.js';
import { articleToFeedItem } from './article.js';

// A De Correspondent article URL looks like /<id>/<slug> (e.g. /17097/albanie-…),
// whereas a feed URL lives under /rss. If someone pastes an article link into
// the feed box, list just that one article instead of feeding HTML to the XML
// parser (which fails with "Unexpected close tag").
function isArticleUrl(url) {
  try {
    return /^\/\d+\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// We fetch the feed ourselves (through session.js, so the cookie stays valid)
// and hand the XML to rss-parser, instead of letting it fetch with a cookie
// baked in at startup.
const parser = new Parser({
  customFields: {
    item: [['dc:creator', 'creator'], ['author', 'author']],
  },
});

function cleanSnippet(item) {
  const s = item.contentSnippet || item.summary || '';
  return s.replace(/\s+/g, ' ').trim().slice(0, 320);
}

// Normalise one rss-parser item into the small shape the UI renders.
function mapItem(item) {
  return {
    title: (item.title || 'Zonder titel').trim(),
    author: (item.creator || item.author || '').trim(),
    link: item.link || item.guid || '',
    date: item.isoDate || item.pubDate || '',
    snippet: cleanSnippet(item),
    id: item.guid || item.link || item.title,
  };
}

// Fetch a feed through the session (keeping the cookie valid) and parse the XML.
async function fetchFeed(feedUrl) {
  const res = await fetchWithSession(feedUrl, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': env.userAgent,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!res.ok) {
    const e = new Error(`Kon feed niet ophalen (HTTP ${res.status}).`);
    e.status = 502;
    throw e;
  }
  return parser.parseString(await res.text());
}

export async function parseFeed(url) {
  const feedUrl = url || env.primaryFeedUrl;
  if (!feedUrl) {
    const e = new Error('No feed URL configured. Set DC_RSS_URL or pass ?url=');
    e.status = 400;
    throw e;
  }

  if (isArticleUrl(feedUrl)) {
    const item = await articleToFeedItem(feedUrl);
    return { title: item.title, url: feedUrl, items: [item] };
  }

  const feed = await fetchFeed(feedUrl);
  return {
    title: feed.title || 'De Correspondent',
    url: feedUrl,
    items: (feed.items || []).map(mapItem).filter((i) => i.link),
  };
}

// Combine several per-correspondent feeds into one chronological list. A single
// correspondent feed carries a fixed window (~20 items), so we cap the merged
// result to the longest of the individual feeds: selecting three 20-item feeds
// yields the latest 20 across all three, not 60. Articles that appear in more
// than one feed (co-authored) are deduplicated by link.
export async function parseCombinedFeed(urls) {
  const list = (urls || []).filter(Boolean);
  if (list.length === 0) return parseFeed('');
  if (list.length === 1) return parseFeed(list[0]);

  const feeds = await Promise.all(list.map((u) => fetchFeed(u)));
  let cap = 0;
  const seen = new Set();
  const items = [];
  for (const feed of feeds) {
    const mapped = (feed.items || []).map(mapItem).filter((i) => i.link);
    cap = Math.max(cap, mapped.length);
    for (const it of mapped) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      items.push(it);
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return {
    title: 'Gecombineerd',
    url: list.join(','),
    items: items.slice(0, cap),
  };
}
