const FIELDS = ['serverUrl', 'adminPassword', 'basicUser', 'basicPass'];

async function load() {
  const values = await chrome.storage.local.get(FIELDS);
  for (const f of FIELDS) {
    const el = document.getElementById(f);
    if (values[f]) el.value = values[f];
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  for (const f of FIELDS) values[f] = document.getElementById(f).value.trim();
  await chrome.storage.local.set(values);
  const saved = document.getElementById('saved');
  saved.textContent = 'Opgeslagen ✓';
  setTimeout(() => (saved.textContent = ''), 2000);
});

load();
