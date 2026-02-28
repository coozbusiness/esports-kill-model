// ─── POPUP SCRIPT ─────────────────────────────────────────────────────────────

const statusText   = document.getElementById('statusText');
const countText    = document.getElementById('countText');
const esportsText  = document.getElementById('esportsText');
const timestampText= document.getElementById('timestampText');
const sendBtn      = document.getElementById('sendBtn');
const openPPBtn    = document.getElementById('openPP');
const saveUrlBtn   = document.getElementById('saveUrl');
const appUrlInput  = document.getElementById('appUrl');
const messageEl    = document.getElementById('message');

// ─── LOAD SAVED STATE ─────────────────────────────────────────────────────────
chrome.storage.local.get(
  ['projections', 'timestamp', 'count', 'esportsCount', 'killModelUrl'],
  (data) => {
    // Restore saved app URL
    if (data.killModelUrl) {
      appUrlInput.value = data.killModelUrl;
    }

    if (data.projections && data.timestamp) {
      const count = data.count || 0;
      const esportsCount = data.esportsCount || 0;
      const ts = new Date(data.timestamp);
      const timeAgo = getTimeAgo(ts);

      statusText.textContent = '● CAPTURED';
      statusText.className = 'status-value green';
      countText.textContent = count;
      esportsText.textContent = esportsCount > 0 ? esportsCount : '—';
      timestampText.textContent = timeAgo;

      if (esportsCount > 0 || count > 0) {
        sendBtn.disabled = false;
        sendBtn.textContent = `★ SEND ${esportsCount || count} PROPS TO KILL MODEL`;
      }
    } else {
      statusText.textContent = '○ NO DATA YET';
      statusText.className = 'status-value gray';
      countText.textContent = '—';
      esportsText.textContent = '—';
      timestampText.textContent = '—';
    }
  }
);

// ─── SAVE APP URL ─────────────────────────────────────────────────────────────
saveUrlBtn.addEventListener('click', () => {
  const url = appUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ killModelUrl: url }, () => {
    showMessage('✓ URL saved');
  });
});

// ─── SEND TO KILL MODEL ───────────────────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  chrome.storage.local.get(['projections', 'killModelUrl'], (data) => {
    if (!data.projections) {
      showMessage('No data — browse PrizePicks first');
      return;
    }

    const appUrl = data.killModelUrl || appUrlInput.value.trim() || 'https://esports-kill-model.vercel.app';

    // Store the pending import data
    chrome.storage.local.set({ pendingImport: data.projections }, () => {
      // Open the kill model app
      chrome.tabs.create({ url: appUrl }, (tab) => {
        showMessage('✓ Kill Model opened — importing…');
        sendBtn.disabled = true;
        sendBtn.textContent = '◌ SENT — CHECK APP TAB';
      });
    });
  });
});

// ─── OPEN PRIZEPICKS ─────────────────────────────────────────────────────────
openPPBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.prizepicks.com' });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ''; }, 3000);
}

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  return date.toLocaleDateString();
}
