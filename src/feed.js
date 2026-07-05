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
