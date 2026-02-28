const statusText    = document.getElementById('statusText');
const countText     = document.getElementById('countText');
const esportsText   = document.getElementById('esportsText');
const timestampText = document.getElementById('timestampText');
const sendBtn       = document.getElementById('sendBtn');
const openPPBtn     = document.getElementById('openPP');
const saveUrlBtn    = document.getElementById('saveUrl');
const appUrlInput   = document.getElementById('appUrl');
const messageEl     = document.getElementById('message');

const DEFAULT_BACKEND = 'https://esports-kill-model.onrender.com';

chrome.storage.local.get(['projections','timestamp','count','esportsCount','killModelUrl','backendUrl'], (data) => {
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
});

saveUrlBtn.addEventListener('click', () => {
  const url = appUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ killModelUrl: url }, () => showMessage('✓ URL saved'));
});

sendBtn.addEventListener('click', async () => {
  const data = await new Promise(r => chrome.storage.local.get(['projections','killModelUrl'], r));
  if (!data.projections) { showMessage('No data — browse PrizePicks first'); return; }

  const appUrl = (data.killModelUrl || appUrlInput.value.trim() || 'https://esports-kill-model.vercel.app').replace(/\/$/, '');
  const backendUrl = DEFAULT_BACKEND;

  sendBtn.disabled = true;
  sendBtn.textContent = '◌ SENDING…';

  try {
    // POST data to relay endpoint on our own backend
    const res = await fetch(`${backendUrl}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data.projections),
    });
    const result = await res.json();

    if (!result.ok) throw new Error('Relay POST failed');

    // Now open/focus the app with ?relay=1 so it knows to fetch from relay
    chrome.tabs.query({}, (tabs) => {
      const appTab = tabs.find(t => t.url && t.url.includes(appUrl.replace('https://','')));
      if (appTab) {
        chrome.tabs.update(appTab.id, { url: `${appUrl}?relay=1`, active: true });
      } else {
        chrome.tabs.create({ url: `${appUrl}?relay=1` });
      }
    });

    showMessage(`✓ ${result.count} props sent — check app tab`);
    sendBtn.textContent = '✓ SENT';
  } catch(err) {
    showMessage('Error: ' + err.message);
    sendBtn.disabled = false;
    sendBtn.textContent = '★ RETRY SEND';
  }
});

openPPBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.prizepicks.com' });
});

function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ''; }, 4000);
}

function getTimeAgo(date) {
  const s = Math.floor((new Date() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
