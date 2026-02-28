const statusText    = document.getElementById('statusText');
const countText     = document.getElementById('countText');
const esportsText   = document.getElementById('esportsText');
const timestampText = document.getElementById('timestampText');
const sendBtn       = document.getElementById('sendBtn');
const openPPBtn     = document.getElementById('openPP');
const saveUrlBtn    = document.getElementById('saveUrl');
const appUrlInput   = document.getElementById('appUrl');
const messageEl     = document.getElementById('message');

chrome.storage.local.get(
  ['projections', 'timestamp', 'count', 'esportsCount', 'killModelUrl'],
  (data) => {
    if (data.killModelUrl) appUrlInput.value = data.killModelUrl;
    if (data.projections && data.timestamp) {
      const count = data.count || 0;
      statusText.textContent = '● CAPTURED';
      statusText.className = 'status-value green';
      countText.textContent = count;
      esportsText.textContent = data.esportsCount || count;
      timestampText.textContent = getTimeAgo(new Date(data.timestamp));
      sendBtn.disabled = false;
      sendBtn.textContent = `★ SEND ${count} PROPS TO KILL MODEL`;
    } else {
      statusText.textContent = '○ NO DATA YET';
      statusText.className = 'status-value gray';
    }
  }
);

saveUrlBtn.addEventListener('click', () => {
  const url = appUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ killModelUrl: url }, () => showMessage('✓ URL saved'));
});

sendBtn.addEventListener('click', () => {
  chrome.storage.local.get(['projections', 'killModelUrl'], (data) => {
    if (!data.projections) { showMessage('No data — browse PrizePicks first'); return; }

    const baseUrl = (data.killModelUrl || appUrlInput.value.trim() || 'https://esports-kill-model.vercel.app').replace(/\/$/, '');
    const appUrlWithParam = `${baseUrl}?ext=1`;

    // Store projections so app can read them from chrome.storage
    chrome.storage.local.set({ pendingImport: data.projections }, () => {
      // Check if app is already open
      chrome.tabs.query({}, (tabs) => {
        const appTab = tabs.find(t => t.url && t.url.includes(baseUrl.replace('https://', '')));
        if (appTab) {
          // Navigate existing tab to app URL with ?ext=1 trigger
          chrome.tabs.update(appTab.id, { url: appUrlWithParam, active: true });
          showMessage('✓ Reloading app with props…');
        } else {
          // Open new tab
          chrome.tabs.create({ url: appUrlWithParam });
          showMessage('✓ App opened — importing props…');
        }
        setTimeout(() => window.close(), 1200);
      });
    });
  });
});

openPPBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.prizepicks.com' });
});

function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

function getTimeAgo(date) {
  const s = Math.floor((new Date() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
