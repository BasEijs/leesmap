// Grabs the current tab's full page HTML and sends it to leesmap's
// /api/bd/import route, which runs the same Readability -> EPUB pipeline the
// rest of the app uses and publishes straight to the "Gepubliceerd —
// Brabants Dagblad" OPDS shelf. No login/session logic here at all — this
// tab is already authenticated with bd.nl the normal way.

const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('send');

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

async function getSettings() {
  const { serverUrl = '', adminPassword = '', basicUser = '', basicPass = '' } =
    await chrome.storage.local.get(['serverUrl', 'adminPassword', 'basicUser', 'basicPass']);
  return { serverUrl: serverUrl.replace(/\/+$/, ''), adminPassword, basicUser, basicPass };
}

sendBtn.addEventListener('click', async () => {
  sendBtn.disabled = true;
  setStatus('Bezig…');
  try {
    const { serverUrl, adminPassword, basicUser, basicPass } = await getSettings();
    if (!serverUrl) {
      setStatus('Stel eerst je Leesmap-serveradres in via Instellingen.', 'err');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('Geen actief tabblad gevonden.');

    const [{ result: html } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    if (!html) throw new Error('Kon de paginainhoud niet lezen.');

    const headers = { 'Content-Type': 'application/json' };
    if (adminPassword) headers['x-admin-password'] = adminPassword;
    if (basicUser) headers.Authorization = `Basic ${btoa(`${basicUser}:${basicPass}`)}`;

    const res = await fetch(`${serverUrl}/api/bd/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: tab.url, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setStatus(`Verstuurd: "${data.title}"`, 'ok');
  } catch (err) {
    setStatus(err.message || 'Onbekende fout', 'err');
  } finally {
    sendBtn.disabled = false;
  }
});
