'use strict';

const $ = (s) => document.querySelector(s);
const state = {
  feeds: [], deviceIp: '', items: [], selected: new Set(),
  // activeCorrs = set of selected correspondent slugs. Selecting more than one
  // combines their feeds chronologically (latest N across all of them).
  // generalActive = true when the general "alle verhalen" tile is selected.
  correspondents: [], activeCorrs: new Set(), generalActive: false,
  lastDigestRun: null,
  pocketbookConfigured: false,
  calibreConfigured: false,
  // Admin gate: adminRequired comes from the server (ADMIN_PASSWORD set or
  // not); adminPw is cached in sessionStorage once verified, so it survives
  // page reloads within a tab but not across browser restarts.
  adminRequired: false,
  adminPw: sessionStorage.getItem('leesmap-admin-pw') || '',
};

// The general/main-feed tile: a De Correspondent monogram that loads the
// primary RSS feed (server falls back to DC_RSS_URL when no url is passed).
const DC_LOGO = '<span class="corr-av corr-logo" aria-hidden="true">dC</span>';

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
  renderFeedSelect();
  renderSavedFeeds();
  probeDevice();
  loadCorrespondents();
  loadPublished();
  $('#digest-enabled').checked = Boolean(c.digestEnabled);
  $('#digest-hour').value = String(Number.isInteger(c.digestHour) ? c.digestHour : 3);
  state.lastDigestRun = c.lastDigestRun;
  renderDigestDetail();
  state.adminRequired = Boolean(c.adminRequired);
  state.pocketbookConfigured = Boolean(c.pocketbookConfigured);
  $('#btn-pocketbook').title = state.pocketbookConfigured
    ? ''
    : 'Niet geconfigureerd: zet POCKETBOOK_EMAIL/SMTP_* in .env.';
  $('#pocketbook-nightly-enabled').checked = Boolean(c.pocketbookNightlyEnabled);
  $('#pocketbook-nightly-enabled').disabled = !state.pocketbookConfigured;
  $('#pocketbook-nightly-detail').textContent = state.pocketbookConfigured
    ? 'Mailt dezelfde nachtelijke digest ook naar het Send-to-PocketBook-adres.'
    : 'Niet geconfigureerd: zet POCKETBOOK_EMAIL/SMTP_* in .env.';
  state.calibreConfigured = Boolean(c.calibreConfigured);
  $('#btn-calibre').hidden = !state.calibreConfigured;
  updateCount();
}

// ---------- Admin gate ----------
// Guards instellingen + Extra opties (Verstuur naar X4 / Publiceer naar OPDS /
// Verstuur naar Pocketbook) so the app can be shared without letting someone
// reconfigure it or trigger a send/publish by accident. A cached-but-stale
// password (server restarted with a new one) is handled by clearing the cache
// and re-prompting on 401.
async function ensureAdmin() {
  if (!state.adminRequired) return true;
  if (state.adminPw) return true;
  const password = window.prompt('Beheerderswachtwoord:');
  if (password == null) return false;
  try {
    const r = await (await fetch('api/admin/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })).json();
    if (!r.ok) {
      toast('Onjuist wachtwoord.');
      return false;
    }
  } catch {
    toast('Kon wachtwoord niet controleren.');
    return false;
  }
  state.adminPw = password;
  sessionStorage.setItem('leesmap-admin-pw', password);
  return true;
}

function adminHeaders() {
  return state.adminPw ? { 'x-admin-password': state.adminPw } : {};
}

// Wraps a gated fetch: on 401 (stale/cleared password server-side) drops the
// cached password so the next attempt re-prompts, instead of failing silently
// forever.
async function adminFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...adminHeaders() },
  });
  if (res.status === 401) {
    state.adminPw = '';
    sessionStorage.removeItem('leesmap-admin-pw');
    toast('Onjuist wachtwoord — probeer opnieuw.');
  }
  return res;
}

// "'s nachts om 03:00 · laatste run: 10 jul 2026" (or "nog niet gedraaid").
function renderDigestDetail() {
  const hour = $('#digest-hour').value.padStart(2, '0');
  const last = state.lastDigestRun ? fmtDate(state.lastDigestRun) : 'nog niet gedraaid';
  $('#digest-detail').textContent =
    `'s nachts om ${hour}:00 · laatste run: ${last}. Publiceert op de "Dagelijkse digest" OPDS-feed.`;
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
  const grid = $('#corr-grid');
  grid.innerHTML = '';

  // The general tile always comes first and loads the full De Correspondent feed.
  const gen = document.createElement('li');
  const genBtn = document.createElement('button');
  genBtn.className = 'corr-tile' + (state.generalActive ? ' active' : '');
  genBtn.title = 'Alle verhalen';
  genBtn.setAttribute('aria-pressed', String(state.generalActive));
  genBtn.innerHTML = `${DC_LOGO}<span class="corr-name">Alle verhalen</span>`;
  genBtn.onclick = selectGeneral;
  gen.append(genBtn);
  grid.append(gen);

  // Skip tiles that failed to resolve (a wrong/removed slug) so the grid never
  // shows a broken placeholder; they stay removable in the settings drawer.
  for (const c of state.correspondents) {
    if (c.error) continue;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const active = state.activeCorrs.has(c.slug);
    btn.className = 'corr-tile' + (active ? ' active' : '');
    btn.title = c.beat ? `${c.name} · ${c.beat}` : c.name;
    btn.setAttribute('aria-pressed', String(active));
    const avatar = c.avatar
      ? `<img class="corr-av" src="${c.avatar}" alt="" loading="lazy" />`
      : `<span class="corr-av corr-av-ph">${(c.name[0] || '?').toUpperCase()}</span>`;
    btn.innerHTML = `${avatar}<span class="corr-name">${c.name}</span>`;
    btn.onclick = () => selectCorrespondent(c);
    li.append(btn);
    grid.append(li);
  }
}

// Correspondent tiles toggle: clicking adds/removes the slug from the active
// set. With one selected we load that feed; with several we combine them
// (server merges chronologically and caps to a single feed's length). Removing
// the last one falls back to the general feed.
function selectCorrespondent(c) {
  if (state.activeCorrs.has(c.slug)) state.activeCorrs.delete(c.slug);
  else state.activeCorrs.add(c.slug);
  state.generalActive = false;
  $('#feed-url').value = '';
  renderCorrespondents();
  loadSelectedCorrespondents();
}

// Build the (possibly comma-joined) feed URL for the active correspondents and
// load it. No selection → back to the general feed.
function loadSelectedCorrespondents() {
  const urls = [...state.activeCorrs]
    .map((slug) => state.correspondents.find((c) => c.slug === slug)?.feedUrl)
    .filter(Boolean);
  if (!urls.length) return selectGeneral();
  loadFeed(urls.join(','));
}

// Load the full feed via the general tile (empty url → server uses DC_RSS_URL).
function selectGeneral() {
  state.activeCorrs.clear();
  state.generalActive = true;
  $('#feed-url').value = '';
  renderCorrespondents();
  loadFeed('');
}

function renderSavedCorr() {
  const ul = $('#saved-corr');
  ul.innerHTML = '';
  const last = state.correspondents.length - 1;
  state.correspondents.forEach((c, i) => {
    const li = document.createElement('li');
    const av = c.avatar
      ? `<img class="corr-av-sm" src="${c.avatar}" alt="" />`
      : `<span class="corr-av-sm corr-av-ph">${(c.name[0] || '?').toUpperCase()}</span>`;
    li.innerHTML = `<span class="sc-id">${av}<span>${c.name}</span></span>`;

    const controls = document.createElement('span');
    controls.className = 'sc-controls';

    const up = document.createElement('button');
    up.className = 'sc-move'; up.textContent = '↑';
    up.title = 'Naar boven'; up.setAttribute('aria-label', `${c.name} naar boven`);
    up.disabled = i === 0;
    up.onclick = () => reorderCorr(i, i - 1);

    const down = document.createElement('button');
    down.className = 'sc-move'; down.textContent = '↓';
    down.title = 'Naar beneden'; down.setAttribute('aria-label', `${c.name} naar beneden`);
    down.disabled = i === last;
    down.onclick = () => reorderCorr(i, i + 1);

    const del = document.createElement('button');
    del.className = 'sc-del'; del.textContent = 'verwijder';
    del.onclick = async () => {
      const r = await (await adminFetch('api/correspondents/' + encodeURIComponent(c.slug), { method: 'DELETE' })).json();
      state.correspondents = r.correspondents || [];
      state.activeCorrs.delete(c.slug);
      renderCorrespondents();
      renderSavedCorr();
    };

    controls.append(up, down, del);
    li.append(controls);
    ul.append(li);
  });
}

// Move the correspondent at index `from` to index `to`, persist the new order,
// and re-render. The grid follows the saved order, so it updates too.
async function reorderCorr(from, to) {
  const slugs = state.correspondents.map((c) => c.slug);
  const [moved] = slugs.splice(from, 1);
  slugs.splice(to, 0, moved);
  try {
    const r = await (await adminFetch('api/correspondents', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slugs }),
    })).json();
    state.correspondents = r.correspondents || state.correspondents;
  } catch {
    return toast('Volgorde opslaan mislukt.');
  }
  renderCorrespondents();
  renderSavedCorr();
}

// The primary feed is loaded from the general tile, so this select only carries
// user-saved feeds and is hidden entirely when there are none.
function renderFeedSelect() {
  const sel = $('#feed-select');
  sel.innerHTML = '';
  sel.hidden = state.feeds.length === 0;
  if (!state.feeds.length) return;
  sel.append(new Option('Opgeslagen feed…', ''));
  for (const f of state.feeds) sel.append(new Option(f.name, f.url));
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
      renderFeedSelect();
    };
    li.append(b);
    ul.append(li);
  });
}

async function saveSettings(patch) {
  const r = await (await adminFetch('api/settings', {
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
  const url = explicitUrl != null ? explicitUrl : $('#feed-url').value.trim();
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
  $('#btn-publish').disabled = n === 0;
  $('#btn-pocketbook').disabled = n === 0 || !state.pocketbookConfigured;

  // A bundle needs at least two articles. With exactly one selected, force
  // "Per artikel" so the UI matches what the server actually builds; restore
  // "Bundel" once a second article is selected again (but only if we're the
  // ones who switched it off — leave an explicit "Per artikel" choice alone).
  const modeBundle = document.querySelector('input[name=mode][value=bundle]');
  const modeSingle = document.querySelector('input[name=mode][value=single]');
  if (n === 1) {
    if (modeBundle.checked) {
      state.restoreBundle = true;
      modeSingle.checked = true;
    }
    modeBundle.disabled = true;
  } else {
    modeBundle.disabled = false;
    if (state.restoreBundle) {
      modeBundle.checked = true;
      state.restoreBundle = false;
    }
  }
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
    const res = await adminFetch('api/send', {
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

// ---------- Publish to OPDS ----------
// Builds the current selection (same options as Verstuur/Download) and drops
// it in the "Gepubliceerd" OPDS feed instead of sending or downloading it, so
// an ereader can pull it in on its own next sync.
async function loadPublished() {
  try {
    const r = await (await fetch('api/published')).json();
    renderPublished(r.items || []);
  } catch {
    renderPublished([]);
  }
}

function renderPublished(items) {
  const ul = $('#published-list');
  ul.innerHTML = '';
  $('#published-empty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${it.title}<br><small class="muted">${fmtDate(it.publishedAt)}</small></span>`;
    const b = document.createElement('button');
    b.textContent = 'verwijder';
    b.onclick = async () => {
      const r = await (await adminFetch('api/published/' + encodeURIComponent(it.filename), { method: 'DELETE' })).json();
      renderPublished(r.items || []);
    };
    li.append(b);
    ul.append(li);
  }
}

async function publish() {
  const body = collect();
  $('#btn-publish').disabled = true;
  try {
    const res = await adminFetch('api/published', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Publiceren mislukt');
    renderPublished(r.items || []);
    toast('Gepubliceerd naar OPDS.');
  } catch (err) {
    toast('Publiceren mislukt: ' + err.message);
  } finally {
    $('#btn-publish').disabled = state.selected.size === 0;
  }
}

// ---------- Send to Pocketbook ----------
// Builds the current selection (same options as Verstuur/Download/Publiceer)
// and emails it to the configured Send-to-PocketBook address (pocketbook.js)
// instead of sending, downloading, or writing it to the OPDS store.
async function sendPocketbook() {
  const body = collect();
  $('#btn-pocketbook').disabled = true;
  try {
    const res = await adminFetch('api/pocketbook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Versturen mislukt');
    toast('Verstuurd naar Pocketbook.');
  } catch (err) {
    toast('Versturen naar Pocketbook mislukt: ' + err.message);
  } finally {
    $('#btn-pocketbook').disabled = state.selected.size === 0 || !state.pocketbookConfigured;
  }
}

// ---------- Calibre-Web boekenkast ----------
// Browse the Calibre-Web library over its OPDS feed and publish a chosen book
// straight onto leesmap's own "Gepubliceerd — Calibre-Web" OPDS shelf, so the
// reader/phone pulls it in wirelessly — no download-and-cable step. The whole
// view is admin-gated (the /api/calibre/* routes are), matching the other
// send/publish actions.
function openCalibre(open) {
  $('#calibre-drawer').hidden = !open;
  $('#scrim').hidden = !open;
  if (open) {
    loadCalibrePublished();
    if (!$('#cal-results').childElementCount) searchCalibre();
  }
}

async function searchCalibre() {
  const q = $('#cal-q').value.trim();
  const empty = $('#cal-empty');
  empty.hidden = false;
  empty.textContent = 'Zoeken…';
  $('#cal-results').innerHTML = '';
  try {
    const res = await adminFetch('api/calibre/books?q=' + encodeURIComponent(q));
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Zoeken mislukt');
    renderCalibreResults(r.books || []);
  } catch (err) {
    empty.hidden = false;
    empty.textContent = 'Kon Calibre-Web niet bereiken: ' + err.message;
  }
}

function renderCalibreResults(books) {
  const ul = $('#cal-results');
  ul.innerHTML = '';
  const empty = $('#cal-empty');
  empty.hidden = books.length > 0;
  if (!books.length) { empty.textContent = 'Geen boeken gevonden.'; return; }
  for (const b of books) {
    const li = document.createElement('li');
    li.className = 'cal-card';
    const cover = b.coverHref
      ? `<img class="cal-cover" src="api/calibre/cover?u=${encodeURIComponent(b.coverHref)}" alt="" loading="lazy" />`
      : `<span class="cal-cover"></span>`;
    const meta = document.createElement('div');
    meta.className = 'cal-meta';
    meta.innerHTML = `<div class="cal-title">${b.title}</div>` +
      (b.author ? `<div class="cal-author">${b.author}</div>` : '');
    const actions = document.createElement('div');
    actions.className = 'cal-actions';
    const btn = document.createElement('button');
    btn.className = 'secondary cal-pub';
    btn.textContent = 'Publiceer';
    btn.onclick = () => publishCalibre(b, btn);
    actions.append(btn);
    // Secondary actions (currently just Pocketbook) live behind a ⋯ overflow
    // so the row stays a single primary button. Only shown when there's
    // something to put in it.
    if (state.pocketbookConfigured) {
      const more = document.createElement('div');
      more.className = 'cal-more';
      const moreBtn = document.createElement('button');
      moreBtn.className = 'secondary cal-more-btn';
      moreBtn.textContent = '⋯';
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-label', 'Meer acties');
      const menu = document.createElement('div');
      menu.className = 'cal-menu';
      menu.hidden = true;
      const pb = document.createElement('button');
      pb.className = 'cal-menu-item';
      pb.textContent = 'Send to Pocketbook';
      pb.onclick = (e) => { e.stopPropagation(); pocketbookCalibre(b, pb); };
      menu.append(pb);
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        closeAllCalMenus();
        if (wasHidden) {
          menu.hidden = false;
          moreBtn.setAttribute('aria-expanded', 'true');
        }
      };
      more.append(moreBtn, menu);
      actions.append(more);
    }
    li.innerHTML = cover;
    li.append(meta, actions);
    ul.append(li);
  }
}

async function publishCalibre(book, btn) {
  btn.disabled = true;
  btn.textContent = 'Bezig…';
  try {
    const res = await adminFetch('api/calibre/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ epubHref: book.epubHref, title: book.title }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Publiceren mislukt');
    btn.textContent = 'Gepubliceerd';
    btn.dataset.done = '1';
    renderCalibrePublished(r.items || []);
    toast(`"${book.title}" op de OPDS-plank.`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Publiceer';
    toast('Publiceren mislukt: ' + err.message);
  }
}

// Close any open per-book overflow menu (one at a time). Wired to a document
// click below so tapping elsewhere dismisses it.
function closeAllCalMenus() {
  document.querySelectorAll('.cal-menu').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('.cal-more-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

async function pocketbookCalibre(book, btn) {
  btn.disabled = true;
  btn.textContent = 'Bezig…';
  try {
    const res = await adminFetch('api/calibre/pocketbook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ epubHref: book.epubHref, title: book.title }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Versturen mislukt');
    btn.textContent = 'Verstuurd';
    btn.dataset.done = '1';
    toast(`"${book.title}" naar Pocketbook.`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Send to Pocketbook';
    toast('Versturen naar Pocketbook mislukt: ' + err.message);
  }
}

async function loadCalibrePublished() {
  try {
    const r = await (await fetch('api/calibre/published')).json();
    renderCalibrePublished(r.items || []);
  } catch {
    renderCalibrePublished([]);
  }
}

function renderCalibrePublished(items) {
  const ul = $('#cal-published-list');
  ul.innerHTML = '';
  $('#cal-published-empty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${it.title}<br><small class="muted">${fmtDate(it.publishedAt)}</small></span>`;
    const b = document.createElement('button');
    b.textContent = 'verwijder';
    b.onclick = async () => {
      const r = await (await adminFetch('api/calibre/published/' + encodeURIComponent(it.filename), { method: 'DELETE' })).json();
      renderCalibrePublished(r.items || []);
    };
    li.append(b);
    ul.append(li);
  }
}

// ---------- Quick bundle: yesterday's main-feed articles ----------
// Independent of whatever feed/selection is currently on screen: always pulls
// the primary feed fresh and filters to the calendar day before today (in the
// browser's local timezone), so "yesterday" means what the user actually saw
// on their clock, not the server's.
function isYesterday(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return false;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.getFullYear() === y.getFullYear() &&
    d.getMonth() === y.getMonth() &&
    d.getDate() === y.getDate();
}

async function downloadYesterday() {
  const btn = $('#btn-download-yesterday');
  btn.disabled = true;
  try {
    const res = await fetch('api/feed');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Feed-fout');
    const feed = await res.json();
    const picks = (feed.items || []).filter((it) => isYesterday(it.date));
    if (!picks.length) return toast('Geen verhalen van gisteren in de hoofdfeed.');
    const images = document.querySelector('input[name=images]:checked').value;
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const label = y.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    await downloadOne(picks.map((i) => i.link), 'bundle', images, `Leesmap – ${label}`);
    toast(`Gisteren gebundeld (${picks.length}).`);
  } catch (err) {
    toast('Mislukt: ' + err.message);
  } finally {
    btn.disabled = false;
  }
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
// Loading via the URL box or a saved feed means we're no longer on a
// correspondent or the general feed. An empty URL box falls back to the
// primary feed (same as the general tile).
function manualLoad() {
  state.activeCorrs.clear();
  state.generalActive = false;
  renderCorrespondents();
  loadFeed($('#feed-url').value.trim());
}
$('#btn-load').onclick = manualLoad;
$('#feed-select').onchange = (e) => {
  const url = e.target.value;
  $('#feed-url').value = '';
  state.activeCorrs.clear();
  state.generalActive = false;
  renderCorrespondents();
  loadFeed(url);
};
$('#nc-add').onclick = async () => {
  const input = $('#nc-input').value.trim();
  if (!input) return toast('Slug of profiel-URL nodig.');
  $('#nc-add').disabled = true;
  try {
    const res = await adminFetch('api/correspondents', {
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
$('#btn-publish').onclick = publish;
$('#btn-pocketbook').onclick = sendPocketbook;

for (let h = 0; h < 24; h++) $('#digest-hour').append(new Option(String(h).padStart(2, '0') + ':00', String(h)));
$('#digest-enabled').onchange = async () => {
  const enabled = $('#digest-enabled').checked;
  await saveSettings({ digestEnabled: enabled });
  toast(enabled ? 'Dagelijkse digest aan.' : 'Dagelijkse digest uit.');
};
$('#digest-hour').onchange = async () => {
  await saveSettings({ digestHour: Number($('#digest-hour').value) });
  renderDigestDetail();
};
$('#pocketbook-nightly-enabled').onchange = async () => {
  const enabled = $('#pocketbook-nightly-enabled').checked;
  await saveSettings({ pocketbookNightlyEnabled: enabled });
  toast(enabled ? 'Nachtelijk versturen naar Pocketbook aan.' : 'Nachtelijk versturen naar Pocketbook uit.');
};
$('#btn-download-yesterday').onclick = downloadYesterday;
$('#btn-settings').onclick = async () => {
  if (!(await ensureAdmin())) return;
  openDrawer(true);
};
$('#btn-close').onclick = () => openDrawer(false);
$('#btn-calibre').onclick = async () => {
  if (!(await ensureAdmin())) return;
  openCalibre(true);
};
$('#cal-close').onclick = () => openCalibre(false);
$('#cal-search').onclick = searchCalibre;
$('#cal-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchCalibre(); });
document.addEventListener('click', closeAllCalMenus);
// "Extra opties" (Verstuur naar X4 / Publiceer naar OPDS) is gated the same
// way: intercept the click that would open it and only let it through once
// ensureAdmin() resolves. Collapsing is always allowed.
$('#extra-summary').addEventListener('click', (e) => {
  const details = $('#extra-opties');
  if (details.open) return;
  e.preventDefault();
  ensureAdmin().then((ok) => { if (ok) details.open = true; });
});
$('#scrim').onclick = () => { openDrawer(false); openCalibre(false); };
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
  renderFeedSelect();
};

loadConfig();
