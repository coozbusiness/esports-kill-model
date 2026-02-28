const statusText    = document.getElementById('statusText');
const countText     = document.getElementById('countText');
const esportsText   = document.getElementById('esportsText');
const timestampText = document.getElementById('timestampText');
const sendBtn       = document.getElementById('sendBtn');
const openPPBtn     = document.getElementById('openPP');
const saveUrlBtn    = document.getElementById('saveUrl');
const appUrlInput   = document.getElementById('appUrl');
const messageEl     = document.getElementById('message');

// Load saved state
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

    const appUrl = (data.killModelUrl || appUrlInput.value.trim() || 'https://esports-kill-model.vercel.app').replace(/\/$/, '');

    // Store pending import
    chrome.storage.local.set({ pendingImport: data.projections }, () => {
      // Check if app tab is already open
      chrome.tabs.query({}, (tabs) => {
        const existingTab = tabs.find(t => t.url && t.url.includes(appUrl.replace('https://', '')));
        if (existingTab) {
          // App is already open — send message directly to that tab
          chrome.tabs.sendMessage(existingTab.id, { type: 'IMPORT_NOW', projections: data.projections }, (resp) => {
            if (chrome.runtime.lastError) {
              // Content script not ready — reload the tab
              chrome.tabs.reload(existingTab.id);
              chrome.tabs.update(existingTab.id, { active: true });
            } else {
              chrome.tabs.update(existingTab.id, { active: true });
            }
          });
          showMessage('✓ Sent to open app tab');
        } else {
          // Open new tab
          chrome.tabs.create({ url: appUrl });
          showMessage('✓ App opened — importing…');
        }
        sendBtn.textContent = '◌ SENT';
        setTimeout(() => window.close(), 1500);
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
