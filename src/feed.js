// Reads a De Correspondent RSS feed (personal all-articles feed, or a
// per-correspondent / per-collection feed) and normalises the items into a
// small shape the UI can render. The feed only carries excerpts — the full
// body is fetched later, per article, in article.js.

import Parser from 'rss-parser';
import { env } from './config.js';
import { fetchWithSession } from './session.js';

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

export async function parseFeed(url) {
  const feedUrl = url || env.primaryFeedUrl;
  if (!feedUrl) {
    const e = new Error('No feed URL configured. Set DC_RSS_URL or pass ?url=');
    e.status = 400;
    throw e;
  }

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
  const feed = await parser.parseString(await res.text());

  const items = (feed.items || []).map((item) => ({
    title: (item.title || 'Zonder titel').trim(),
    author: (item.creator || item.author || '').trim(),
    link: item.link || item.guid || '',
    date: item.isoDate || item.pubDate || '',
    snippet: cleanSnippet(item),
    id: item.guid || item.link || item.title,
  }));

  return {
    title: feed.title || 'De Correspondent',
    url: feedUrl,
    items: items.filter((i) => i.link),
  };
}
