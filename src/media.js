// A tiny in-memory store for images that were fetched (with your session
// cookie) while building an EPUB. The EPUB builder can't send auth headers or
// a referer when it downloads images, and De Correspondent's image CDN may
// reject hotlinks — so we fetch each image ourselves, park the bytes here, and
// hand the builder a plain localhost URL it *can* fetch. Entries self-expire.

const store = new Map(); // id -> { buffer, contentType, expires }
const TTL_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, v] of store) if (v.expires < now) store.delete(id);
}

export function put(id, buffer, contentType) {
  sweep();
  store.set(id, { buffer, contentType, expires: Date.now() + TTL_MS });
}

export function get(id) {
  const v = store.get(id);
  if (!v) return null;
  if (v.expires < Date.now()) {
    store.delete(id);
    return null;
  }
  return v;
}
