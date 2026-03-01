const statusText    = document.getElementById("statusText");
const countText     = document.getElementById("countText");
const esportsText   = document.getElementById("esportsText");
const timestampText = document.getElementById("timestampText");
const sendBtn       = document.getElementById("sendBtn");
const openPPBtn     = document.getElementById("openPP");
const saveUrlBtn    = document.getElementById("saveUrl");
const appUrlInput   = document.getElementById("appUrl");
const messageEl     = document.getElementById("message");
const clearBtn      = document.getElementById("clearBtn");

const DEFAULT_BACKEND = "https://esports-kill-model.onrender.com";

// ─── LOAD STATE ───────────────────────────────────────────────────────────────
chrome.storage.local.get(["projections","timestamp","count","esportsCount","killModelUrl"], (data) => {
  if (data.killModelUrl) appUrlInput.value = data.killModelUrl;
  if (data.projections && data.count > 0) {
    const count = data.count || 0;
    statusText.textContent = "● READY";
    statusText.className = "status-value green";
    countText.textContent = count;
    esportsText.textContent = count;
    timestampText.textContent = data.timestamp ? getTimeAgo(new Date(data.timestamp)) : "?";
    sendBtn.disabled = false;
    sendBtn.textContent = `★ SEND ${count} ESPORTS PROPS`;
  } else {
    statusText.textContent = "○ NO DATA";
    statusText.className = "status-value gray";
    sendBtn.disabled = true;
    sendBtn.textContent = "★ SEND PROPS";
  }
});

// ─── SAVE URL ─────────────────────────────────────────────────────────────────
saveUrlBtn.addEventListener("click", () => {
  const url = appUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ killModelUrl: url }, () => showMessage("✓ URL saved"));
});

// ─── SEND TO APP ──────────────────────────────────────────────────────────────
sendBtn.addEventListener("click", async () => {
  const data = await new Promise(r => chrome.storage.local.get(["projections","killModelUrl"], r));
  if (!data.projections || !data.projections.data?.length) {
    showMessage("No data — open PrizePicks first");
    return;
  }

  const appUrl = (data.killModelUrl || appUrlInput.value.trim() || "https://esports-kill-model.vercel.app").replace(/\/$/, "");
  const backendUrl = DEFAULT_BACKEND;

  sendBtn.disabled = true;
  sendBtn.textContent = "◌ SENDING…";

  try {
    const res = await fetch(`${backendUrl}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.projections),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 80)}`);
    }
    const result = await res.json();
    if (!result.ok) throw new Error("Relay failed");

    // Open or focus app tab with ?relay=1
    chrome.tabs.query({}, (tabs) => {
      const host = appUrl.replace("https://", "").replace("http://", "");
      const existing = tabs.find(t => t.url && t.url.includes(host));
      if (existing) {
        chrome.tabs.update(existing.id, { url: `${appUrl}?relay=1`, active: true });
      } else {
        chrome.tabs.create({ url: `${appUrl}?relay=1` });
      }
    });

    showMessage(`✓ ${result.count} props sent`);
    sendBtn.textContent = "✓ SENT";
    setTimeout(() => { sendBtn.disabled = false; sendBtn.textContent = `★ SEND AGAIN`; }, 3000);
  } catch(err) {
    showMessage("Error: " + err.message);
    sendBtn.disabled = false;
    sendBtn.textContent = "★ RETRY";
  }
});

// ─── OPEN PRIZEPICKS ──────────────────────────────────────────────────────────
openPPBtn.addEventListener("click", () => {
  // Check if PrizePicks tab already exists
  chrome.tabs.query({ url: "https://app.prizepicks.com/*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
      showMessage("Switched to existing PrizePicks tab — auto-capture is running");
    } else {
      chrome.tabs.create({ url: "https://app.prizepicks.com" });
      showMessage("Opening PrizePicks — auto-capture will start on load");
    }
  });
});

// ─── CLEAR ────────────────────────────────────────────────────────────────────
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CLEAR" }, () => {
      statusText.textContent = "○ CLEARED";
      countText.textContent = "0";
      esportsText.textContent = "0";
      timestampText.textContent = "—";
      sendBtn.disabled = true;
      sendBtn.textContent = "★ SEND PROPS";
      showMessage("✓ Data cleared");
    });
  });
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function showMessage(msg) {
  messageEl.textContent = msg;
  setTimeout(() => { messageEl.textContent = ""; }, 5000);
}

function getTimeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
