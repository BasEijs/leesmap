// Reads a De Correspondent RSS feed (personal all-articles feed, or a
// per-correspondent / per-collection feed) and normalises the items into a
// small shape the UI can render. The feed only carries excerpts — the full
// body is fetched later, per article, in article.js.

import Parser from 'rss-parser';
import { env } from './config.js';

const parser = new Parser({
  timeout: 20000,
  headers: {
    Cookie: env.cookie,
    'User-Agent': env.userAgent,
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
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

  const feed = await parser.parseURL(feedUrl);

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
