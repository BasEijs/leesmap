// Shared date formatting for anything that ends up in a filename. Every
// digest/bundle EPUB on disk is named DD-MM-YYYY so they sort and read the
// same way regardless of which code path produced them.

// DD-MM-YYYY in Europe/Amsterdam, not UTC — a straight toISOString() slice
// would shift dates near midnight local time.
export function localDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('day')}-${get('month')}-${get('year')}`;
}
