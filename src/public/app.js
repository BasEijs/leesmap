'use strict';

const $ = (s) => document.querySelector(s);
const state = {
  feeds: [], deviceIp: '', items: [], selected: new Set(),
  correspondents: [], activeCorr: null,
};

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Config ----------
async function loadConfig() {
  const c = await (await fetch('api/config')).json();
  state.feeds = c.feeds || [];
  state.deviceIp = c.deviceIp || '';
  $('#device-ip').value = state.deviceIp;
  $('#dot-cookie').className = 'dot ' + (c.cookieConfigured ? 'on' : 'off');
  renderFeedSelect(c.primaryFeedConfigured);
  renderSavedFeeds();
  probeDevice();
  loadCorrespondents();
}

// ---------- Correspondents ----------
async function loadCorrespondents() {
  try {
    const r = await (await fetch('api/correspondents')).json();
    state.correspondents = r.correspondents || [];
  } catch {
    state.correspondents = [];
  }
  renderCorrespondents();
  renderSavedCorr();
}

function renderCorrespondents() {
  const wrap = $('#correspondents-wrap');
  const grid = $('#corr-grid');
  grid.innerHTML = '';
  wrap.hidden = state.correspondents.length === 0;
  for (const c of state.correspondents) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'corr-tile' + (state.activeCorr === c.slug ? ' active' : '');
    btn.title = c.beat ? `${c.name} · ${c.beat}` : c.name;
    btn.setAttribute('aria-pressed', String(state.activeCorr === c.slug));
    const avatar = c.avatar
      ? `<img class="corr-av" src="${c.avatar}" alt="" loading="lazy" />`
      : `<span class="corr-av corr-av-ph">${(c.name[0] || '?').toUpperCase()}</span>`;
    btn.innerHTML = `${avatar}<span class="corr-name">${c.name}</span>`;
    btn.onclick = () => selectCorrespondent(c);
    li.append(btn);
    grid.append(li);
  }
}

function selectCorrespondent(c) {
  state.activeCorr = c.slug;
  $('#feed-url').value = '';
  $('#corr-clear').hidden = false;
  renderCorrespondents();
  loadFeed(c.feedUrl);
}

function clearCorrespondent() {
  state.activeCorr = null;
  $('#corr-clear').hidden = true;
  renderCorrespondents();
  loadFeed();
}

function renderSavedCorr() {
  const ul = $('#saved-corr');
  ul.innerHTML = '';
  state.correspondents.forEach((c) => {
    const li = document.createElement('li');
    const av = c.avatar
      ? `<img class="corr-av-sm" src="${c.avatar}" alt="" />`
      : `<span class="corr-av-sm corr-av-ph">${(c.name[0] || '?').toUpperCase()}</span>`;
    li.innerHTML = `<span class="sc-id">${av}<span>${c.name}</span></span>`;
    const b = document.createElement('button');
    b.textContent = 'verwijder';
    b.onclick = async () => {
      const r = await (await fetch('api/correspondents/' + encodeURIComponent(c.slug), { method: 'DELETE' })).json();
      state.correspondents = r.correspondents || [];
      if (state.activeCorr === c.slug) clearCorrespondent();
      renderCorrespondents();
      renderSavedCorr();
    };
    li.append(b);
    ul.append(li);
  });
}

function renderFeedSelect(hasPrimary) {
  const sel = $('#feed-select');
  sel.innerHTML = '';
  if (hasPrimary) sel.append(new Option('Mijn feed (alle verhalen)', ''));
  for (const f of state.feeds) sel.append(new Option(f.name, f.url));
  if (!hasPrimary && !state.feeds.length) sel.append(new Option('— geen feed ingesteld —', ''));
}

function renderSavedFeeds() {
  const ul = $('#saved-feeds');
  ul.innerHTML = '';
  state.feeds.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${f.name}</span>`;
    const b = document.createElement('button');
    b.textContent = 'verwijder';
    b.onclick = async () => {
      state.feeds.splice(i, 1);
      await saveSettings({ feeds: state.feeds });
      renderSavedFeeds();
      renderFeedSelect($('#feed-select').options[0]?.value === '');
    };
    li.append(b);
    ul.append(li);
  });
}

async function saveSettings(patch) {
  const r = await (await fetch('api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })).json();
  state.feeds = r.feeds || state.feeds;
  state.deviceIp = r.deviceIp || state.deviceIp;
  return r;
}

// ---------- Device ----------
async function probeDevice(ip) {
  const target = ip || state.deviceIp;
  $('#lbl-device').textContent = 'reader …';
  try {
    const r = await (await fetch('api/device?ip=' + encodeURIComponent(target))).json();
    $('#dot-device').className = 'dot ' + (r.ok ? 'on' : 'off');
    $('#lbl-device').textContent = r.ok ? 'reader online' : 'reader offline';
    return r.ok;
  } catch {
    $('#dot-device').className = 'dot off';
    $('#lbl-device').textContent = 'reader offline';
    return false;
  }
}

// ---------- Feed ----------
async function loadFeed(explicitUrl) {
  const url = explicitUrl != null
    ? explicitUrl
    : ($('#feed-url').value.trim() || $('#feed-select').value);
  $('#feed-empty').textContent = 'Feed laden…';
  $('#feed-empty').hidden = false;
  $('#feed-meta').textContent = '';
  $('#articles').innerHTML = '';
  try {
    const q = url ? '?url=' + encodeURIComponent(url) : '';
    const res = await fetch('api/feed' + q);
    if (!res.ok) throw new Error((await res.json()).error || 'Feed-fout');
    const feed = await res.json();
    state.items = feed.items;
    state.selected.clear();
    renderArticles();
    $('#feed-meta').textContent = `${feed.items.length} verhalen`;
    $('#feed-empty').hidden = feed.items.length > 0;
    if (!feed.items.length) $('#feed-empty').textContent = 'Geen verhalen in deze feed.';
  } catch (err) {
    $('#feed-empty').hidden = false;
    $('#feed-empty').textContent = 'Kon feed niet laden: ' + err.message;
  }
  updateCount();
}

function renderArticles() {
  const ol = $('#articles');
  ol.innerHTML = '';
  state.items.forEach((it, i) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'a' + i;
    cb.checked = state.selected.has(it.link);
    cb.onchange = () => {
      cb.checked ? state.selected.add(it.link) : state.selected.delete(it.link);
      updateCount();
    };
    const meta = [it.author, fmtDate(it.date)].filter(Boolean).join(' · ');
    const div = document.createElement('div');
    div.innerHTML =
      `<label class="art-title" for="a${i}">${it.title}</label>` +
      (meta ? `<p class="art-meta">${meta}</p>` : '') +
      (it.snippet ? `<p class="art-snip">${it.snippet}</p>` : '');
    li.append(cb, div);
    ol.append(li);
  });
}

function updateCount() {
  const n = state.selected.size;
  $('#sel-count').textContent = n;
  $('#btn-send').disabled = n === 0;
  $('#btn-download').disabled = n === 0;
}

// ---------- Console ----------
const con = $('#console');
function conLine(html) {
  if (con.querySelector('.console-idle')) con.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'line';
  p.innerHTML = html;
  con.append(p);
  con.scrollTop = con.scrollHeight;
}
const PH = { fetch: 'ophalen', extract: 'uitpakken', bind: 'binden', send: 'versturen' };

// ---------- Send (streaming) ----------
async function send() {
  const body = collect();
  $('#btn-send').disabled = true;
  con.innerHTML = '';
  conLine(`<span class="rule">── ${body.mode === 'bundle' ? 'bundel' : 'per artikel'} · ${body.images === 'embed' ? 'met beeld' : 'tekst'} · → ${body.deviceIp} ──</span>`);
  try {
    const res = await fetch('api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    conLine(`<span class="bad">✗ ${err.message}</span>`);
  } finally {
    $('#btn-send').disabled = state.selected.size === 0;
  }
}

function handleEvent(o) {
  if (o.type === 'step') {
    const label = PH[o.phase] || o.phase;
    const extra = o.title ? `<span class="t"> ${o.title}</span>`
      : o.bytes ? `<span class="b"> ${fmtBytes(o.bytes)}</span>`
      : o.count ? `<span class="b"> ${o.count} hoofdstukken</span>` : '';
    conLine(`<span class="ph">▸ ${label}</span>${extra}`);
  } else if (o.type === 'result') {
    if (o.ok) {
      const what = o.bundled ? `bundel (${o.bundled})` : (o.filename || '');
      conLine(`<span class="ok">✓ verstuurd</span> <span class="b">${what} · ${fmtBytes(o.bytes)}</span>`);
    } else {
      conLine(`<span class="bad">✗ ${o.message}</span>`);
    }
  } else if (o.type === 'done') {
    conLine(`<span class="rule">── klaar ──</span>`);
    probeDevice();
  } else if (o.type === 'error') {
    conLine(`<span class="bad">✗ ${o.message}</span>`);
  }
}

// ---------- Download ----------
async function download() {
  const body = collect();
  $('#btn-download').disabled = true;
  try {
    if (body.mode === 'bundle') {
      await downloadOne(body.urls, 'bundle', body.images, body.title);
    } else {
      for (const url of body.urls) await downloadOne([url], 'single', body.images);
    }
    toast('Download gereed.');
  } catch (err) {
    toast('Download mislukt: ' + err.message);
  } finally {
    $('#btn-download').disabled = state.selected.size === 0;
  }
}

async function downloadOne(urls, mode, images, title) {
  const res = await fetch('api/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ urls, mode, images, title }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'bouwfout');
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'artikel.epub';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function collect() {
  return {
    urls: [...state.selected],
    mode: document.querySelector('input[name=mode]:checked').value,
    images: document.querySelector('input[name=images]:checked').value,
    deviceIp: state.deviceIp,
    title: $('#bundle-title').value.trim() || undefined,
  };
}

// ---------- Drawer ----------
function openDrawer(open) {
  $('#drawer').hidden = !open;
  $('#scrim').hidden = !open;
}

// ---------- Wire up ----------
// Loading via the select or URL box means we're no longer on a correspondent.
function manualLoad() {
  state.activeCorr = null;
  $('#corr-clear').hidden = true;
  renderCorrespondents();
  loadFeed();
}
$('#btn-load').onclick = manualLoad;
$('#feed-select').onchange = () => { $('#feed-url').value = ''; manualLoad(); };
$('#corr-clear').onclick = clearCorrespondent;
$('#nc-add').onclick = async () => {
  const input = $('#nc-input').value.trim();
  if (!input) return toast('Slug of profiel-URL nodig.');
  $('#nc-add').disabled = true;
  try {
    const res = await fetch('api/correspondents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Kon niet toevoegen.');
    state.correspondents = r.correspondents || [];
    $('#nc-input').value = '';
    renderCorrespondents();
    renderSavedCorr();
    toast(`${r.correspondent?.name || 'Correspondent'} toegevoegd.`);
  } catch (err) {
    toast(err.message);
  } finally {
    $('#nc-add').disabled = false;
  }
};
$('#sel-all').onclick = () => { state.items.forEach((i) => state.selected.add(i.link)); renderArticles(); updateCount(); };
$('#sel-none').onclick = () => { state.selected.clear(); renderArticles(); updateCount(); };
$('#btn-send').onclick = send;
$('#btn-download').onclick = download;
$('#btn-settings').onclick = () => openDrawer(true);
$('#btn-close').onclick = () => openDrawer(false);
$('#scrim').onclick = () => openDrawer(false);
$('#chip-device').onclick = () => probeDevice();
$('#btn-test').onclick = async () => {
  const ip = $('#device-ip').value.trim();
  await saveSettings({ deviceIp: ip });
  const ok = await probeDevice(ip);
  toast(ok ? 'Reader gevonden.' : 'Geen reactie van reader.');
};
$('#nf-add').onclick = async () => {
  const name = $('#nf-name').value.trim();
  const url = $('#nf-url').value.trim();
  if (!name || !url) return toast('Naam en URL nodig.');
  state.feeds.push({ name, url });
  await saveSettings({ feeds: state.feeds });
  $('#nf-name').value = $('#nf-url').value = '';
  renderSavedFeeds();
  renderFeedSelect($('#feed-select').options[0]?.value === '');
};

loadConfig();
