// Builds the OPDS (Atom) catalog feeds CrossPoint's OPDS client pulls from.
//
// Verified against the CrossPoint firmware source (lib/OpdsParser,
// src/activities/browser/OpdsBookBrowserActivity.cpp): it doesn't check the
// response Content-Type, and classifies an <entry> as a downloadable book only
// if it has a <link rel="...opds-spec.org/acquisition..." type="application/
// epub+zip"> — so that's the one link shape that actually matters here.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function feedHeader({ id, title, updated, href }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${esc(id)}</id>
  <title>${esc(title)}</title>
  <updated>${esc(updated)}</updated>
  <link rel="self" href="${esc(href)}" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="start" href="/opds" type="application/atom+xml;profile=opds-catalog"/>`;
}

// Root catalog: one navigation entry pointing at the digests acquisition feed.
export function rootCatalog() {
  const now = new Date().toISOString();
  return `${feedHeader({ id: 'urn:leesmap:root', title: 'Leesmap', updated: now, href: '/opds' })}
  <entry>
    <title>Dagelijkse digest</title>
    <id>urn:leesmap:digests</id>
    <updated>${esc(now)}</updated>
    <content type="text">De laatste dagelijkse selecties van De Correspondent.</content>
    <link rel="subsection" href="/opds/digests" type="application/atom+xml;profile=opds-catalog"/>
  </entry>
</feed>
`;
}

// "2026-07-09" -> "9 juli 2026"
function dutchTitle(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const formatted = new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
  return `De Correspondent — ${formatted}`;
}

// Acquisition feed listing digest EPUBs, newest first.
export function digestsFeed(digests) {
  const now = new Date().toISOString();
  const entries = digests
    .map(
      (d) => `
  <entry>
    <title>${esc(dutchTitle(d.date))}</title>
    <id>urn:leesmap:digest:${esc(d.date)}</id>
    <updated>${esc(d.mtime.toISOString())}</updated>
    <link rel="http://opds-spec.org/acquisition" href="${esc(`/opds/digests/${d.filename}`)}" type="application/epub+zip"/>
  </entry>`
    )
    .join('');
  return `${feedHeader({ id: 'urn:leesmap:digests', title: 'Dagelijkse digest', updated: now, href: '/opds/digests' })}${entries}
</feed>
`;
}
