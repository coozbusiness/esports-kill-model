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
    const appUrl = (data.killModelUrl || appUrlInput.value.trim() || 'https://esports-kill-model.vercel.app').replace(/\/$/, '');

    // Write data to extension storage under a known key
    // Then use scripting API to write it into the app tab's localStorage directly
    chrome.tabs.query({}, (tabs) => {
      const appTab = tabs.find(t => t.url && t.url.includes(appUrl.replace('https://', '')));

      const payload = JSON.stringify(data.projections);

      if (appTab) {
        // Inject script into the app tab that writes to localStorage and triggers import
        chrome.scripting.executeScript({
          target: { tabId: appTab.id },
          func: (jsonPayload) => {
            try {
              localStorage.setItem('kill_model_ext_import', jsonPayload);
              localStorage.setItem('kill_model_ext_ts', Date.now().toString());
              // Dispatch a storage event so the app picks it up immediately
              window.dispatchEvent(new StorageEvent('storage', {
                key: 'kill_model_ext_import',
                newValue: jsonPayload,
                storageArea: localStorage
              }));
              return true;
            } catch(e) { return false; }
          },
          args: [payload]
        }, (results) => {
          if (chrome.runtime.lastError) {
            showMessage('Error: ' + chrome.runtime.lastError.message);
          } else {
            chrome.tabs.update(appTab.id, { active: true });
            showMessage('✓ Props sent to open app tab');
          }
        });
      } else {
        // App not open — store and open
        chrome.storage.local.set({ pendingImport: data.projections }, () => {
          chrome.tabs.create({ url: appUrl });
          showMessage('✓ App opened — importing…');
        });
      }
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
