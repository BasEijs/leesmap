// Talks to the Xteink X4 running CrossPoint firmware over the local network.
// Confirmed API (CrossPoint): POST http://<ip>/upload?path=/  (multipart, field
// "file"); GET http://<ip>/api/files?path=/ lists storage. CrossPoint answers
// on its own hotspot at 192.168.4.1 / crosspoint.local, or on whatever IP your
// WiFi gave it. (Stock firmware differs and lives at 192.168.3.3.)

function base(ip) {
  const host = (ip || '').trim();
  return host.startsWith('http') ? host.replace(/\/$/, '') : `http://${host}`;
}

async function withTimeout(promise, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label}: geen reactie (timeout)`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Is the reader reachable? Returns { ok, detail }.
export async function probe(ip) {
  try {
    const res = await withTimeout(
      (signal) => fetch(`${base(ip)}/api/files?path=/`, { signal }),
      4000,
      'probe'
    );
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// Upload one EPUB. Returns { ok, status }.
export async function upload(ip, filename, buffer) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: 'application/epub+zip' }),
    filename
  );
  const res = await withTimeout(
    (signal) =>
      fetch(`${base(ip)}/upload?path=/`, {
        method: 'POST',
        body: form,
        signal,
      }),
    60000,
    'upload'
  );
  if (!res.ok) {
    throw new Error(`Upload mislukt (HTTP ${res.status}). Staat de reader aan en op WiFi?`);
  }
  return { ok: true, status: res.status };
}
