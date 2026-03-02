const sendBtn     = document.getElementById("sendBtn");
const openPPBtn   = document.getElementById("openPP");
const fetchAllBtn = document.getElementById("fetchAllBtn");
const saveUrlBtn  = document.getElementById("saveUrl");
const appUrlInput = document.getElementById("appUrl");
const messageEl   = document.getElementById("message");
const clearBtn    = document.getElementById("clearBtn");

const DEFAULT_BACKEND = "https://esports-kill-model.onrender.com";

// Esport keywords to filter leagues from the leagues endpoint
const ESPORTS_KEYWORDS = [
  "league of legends","lol","lck","lcs","lec","lpl","lta","lcp","worlds","msi",
  "valorant","vct",
  "counter-strike","cs2","csgo","esl","blast","iem","pgl","pro league",
  "dota","dota2","the international","dreamleague",
  "call of duty","cod","cdl",
  "rainbow six","r6","siege",
  "apex legends","algs",
  "rocket league","rlcs",
  "overwatch","owl",
];

function isEsportsLeague(name) {
  const lower = (name || "").toLowerCase();
  return ESPORTS_KEYWORDS.some(k => lower.includes(k));
}

// ─── LOAD STATE ───────────────────────────────────────────────────────────────
function loadState() {
  chrome.storage.local.get(["projections","timestamp","count","esportsCount","killModelUrl"], (data) => {
    if (data.killModelUrl) appUrlInput.value = data.killModelUrl;
    const count = data.count || 0;
    if (data.projections && count > 0) {
      setStatus("● READY", "green");
      document.getElementById("countText").textContent = count;
      document.getElementById("esportsText").textContent = count;
      document.getElementById("timestampText").textContent = data.timestamp ? getTimeAgo(new Date(data.timestamp)) : "?";
      sendBtn.disabled = false;
      sendBtn.textContent = `★ SEND ${count} ESPORTS PROPS`;
    } else {
      setStatus("○ NO DATA", "gray");
      sendBtn.disabled = true;
      sendBtn.textContent = "★ SEND PROPS";
    }
  });
}
loadState();

function setStatus(txt, cls) {
  const el = document.getElementById("statusText");
  el.textContent = txt; el.className = "status-value " + cls;
}

// ─── SAVE URL ─────────────────────────────────────────────────────────────────
saveUrlBtn.addEventListener("click", () => {
  const url = appUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ killModelUrl: url }, () => showMsg("✓ URL saved"));
});

// ─── FETCH ALL DIRECT ─────────────────────────────────────────────────────────
fetchAllBtn.addEventListener("click", async () => {
  fetchAllBtn.disabled = true;
  fetchAllBtn.textContent = "◌ STEP 1: LEAGUES…";
  showMsg("Fetching league list from PrizePicks…");

  const ESPORT_KEYWORDS = [
    "league of legends","valorant","vct","counter-strike","cs2","csgo",
    "dota","call of duty","cdl","apex legends","algs","rainbow six","r6",
    "rocket league","rlcs","overwatch","starcraft","halo","esport","e-sport",
    "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
    "esl pro league","blast","iem ","pgl ","dreamleague"
  ];
  const ESPORT_SPORTS = new Set([
    "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
    "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
    "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
    "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS"
  ]);

  function isEsportLeague(league) {
    const sport = (league.attributes?.sport || "").toUpperCase().trim();
    if (ESPORT_SPORTS.has(sport)) return true;
    const name = (league.attributes?.name || league.attributes?.display_name || "").toLowerCase();
    return ESPORT_KEYWORDS.some(kw => name.includes(kw));
  }

  try {
    // ── STEP 1: Get all leagues, find esports ones ──────────────────────────
    let esportLeagueIds = [];
    try {
      const lr = await fetch("https://api.prizepicks.com/leagues", {
        headers: { "Accept": "application/json" }
      });
      if (lr.ok) {
        const lj = await lr.json();
        const leagues = Array.isArray(lj) ? lj : (lj.data || []);
        const esportLeagues = leagues.filter(isEsportLeague);
        esportLeagueIds = esportLeagues.map(l => l.id);
        const names = esportLeagues.map(l => l.attributes?.name || l.id).join(", ");
        console.log("[KM] Esport leagues found:", names);
        showMsg(`Found ${esportLeagues.length} esport leagues — fetching props…`);
      }
    } catch(e) {
      console.warn("[KM] Leagues fetch failed:", e.message);
    }

    // ── STEP 2: Fetch projections ───────────────────────────────────────────
    const allData = [];
    const allIncluded = [];
    const seenIds = new Set();
    const seenIncIds = new Set();

    function mergeResponse(json) {
      let added = 0;
      (json.data || []).forEach(p => {
        if (!seenIds.has(p.id)) { seenIds.add(p.id); allData.push(p); added++; }
      });
      (json.included || []).forEach(i => {
        const k = i.type + ":" + i.id;
        if (!seenIncIds.has(k)) { seenIncIds.add(k); allIncluded.push(i); }
      });
      return added;
    }

    if (esportLeagueIds.length > 0) {
      // Fetch by each known esport league ID — GUARANTEED to get VAL, COD, etc.
      for (let i = 0; i < esportLeagueIds.length; i++) {
        const lid = esportLeagueIds[i];
        fetchAllBtn.textContent = `◌ LEAGUE ${i+1}/${esportLeagueIds.length}…`;
        try {
          const r = await fetch(
            `https://api.prizepicks.com/projections?league_id=${lid}&per_page=250&single_stat=true`,
            { headers: { "Accept": "application/json" } }
          );
          if (r.ok) {
            const j = await r.json();
            const added = mergeResponse(j);
            if (added > 0) showMsg(`League ${lid}: +${added} props (total: ${allData.length})`);
          }
        } catch(e) { /* skip failed league */ }
        await new Promise(r => setTimeout(r, 250));
      }
    }

    // ── STEP 3: Always do a broad sweep too — catches anything missed ───────
    fetchAllBtn.textContent = "◌ BROAD SWEEP…";
    showMsg("Running broad sweep for any missed props…");
    try {
      const r = await fetch(
        "https://api.prizepicks.com/projections?per_page=500&single_stat=true",
        { headers: { "Accept": "application/json" } }
      );
      if (r.ok) {
        const j = await r.json();
        const added = mergeResponse(j);
        if (added > 0) showMsg(`Broad sweep: +${added} more props`);
      }
    } catch(e) { /* optional */ }

    if (allData.length === 0) {
      showMsg("⚠ No props found — PrizePicks may be blocking. Try opening PP manually.");
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
      return;
    }

    // ── STEP 4: Send to background to filter esports + store ────────────────
    fetchAllBtn.textContent = "◌ STORING…";
    const merged = { data: allData, included: allIncluded };

    chrome.runtime.sendMessage({ type: "STORE_DIRECT_FETCH", projections: merged }, (response) => {
      if (chrome.runtime.lastError) {
        showMsg("Storage error: " + chrome.runtime.lastError.message);
        fetchAllBtn.disabled = false;
        fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
        return;
      }
      const count = response?.count || 0;
      setStatus("● READY", "green");
      document.getElementById("countText").textContent = count;
      document.getElementById("esportsText").textContent = count;
      document.getElementById("timestampText").textContent = "just now";
      sendBtn.disabled = false;
      sendBtn.textContent = `★ SEND ${count} ESPORTS PROPS`;
      showMsg(`✓ ${count} esports props (${allData.length} total fetched from ${esportLeagueIds.length} leagues)`);
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
    });

  } catch(err) {
    showMsg("Error: " + err.message);
    fetchAllBtn.disabled = false;
    fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
  }
});

async function fetchBroad() {
  try {
    const res = await fetch(
      "https://api.prizepicks.com/projections?per_page=500&single_stat=true",
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.data?.length) throw new Error("No data");
    showMsg(`Broad fetch: ${json.data.length} props`);
    await storeViaBackground(json);
  } catch(e) {
    showMsg("Broad fetch failed: " + e.message);
    fetchAllBtn.disabled = false;
    fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
  }
}

// Route storage through background.js so it can slim the data and handle quota
async function storeViaBackground(projections) {
  fetchAllBtn.textContent = "◌ STORING…";
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "STORE_DIRECT_FETCH", projections }, (response) => {
      if (chrome.runtime.lastError) {
        showMsg("Storage error: " + chrome.runtime.lastError.message);
        fetchAllBtn.disabled = false;
        fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
        resolve();
        return;
      }
      if (!response?.ok) {
        showMsg("Storage failed: " + (response?.error || "unknown"));
        fetchAllBtn.disabled = false;
        fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
        resolve();
        return;
      }
      const count = response.count;
      setStatus("● READY", "green");
      document.getElementById("countText").textContent = count;
      document.getElementById("esportsText").textContent = count;
      document.getElementById("timestampText").textContent = "just now";
      sendBtn.disabled = false;
      sendBtn.textContent = `★ SEND ${count} ESPORTS PROPS`;
      showMsg(`✓ ${count} props stored`);
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
      resolve();
    });
  });
}

// ─── SEND TO APP ──────────────────────────────────────────────────────────────
sendBtn.addEventListener("click", async () => {
  const data = await new Promise(r => chrome.storage.local.get(["projections","killModelUrl"], r));
  if (!data.projections?.data?.length) { showMsg("No data — fetch first"); return; }

  const appUrl = (data.killModelUrl || appUrlInput.value.trim() || "https://esports-kill-model.vercel.app").replace(/\/$/, "");
  sendBtn.disabled = true;
  sendBtn.textContent = "◌ SENDING…";

  try {
    const res = await fetch(`${DEFAULT_BACKEND}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.projections),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (!result.ok) throw new Error("Relay failed");

    chrome.tabs.query({}, (tabs) => {
      const host = appUrl.replace(/https?:\/\//, "");
      const existing = tabs.find(t => t.url?.includes(host));
      if (existing) chrome.tabs.update(existing.id, { url: `${appUrl}?relay=1`, active: true });
      else chrome.tabs.create({ url: `${appUrl}?relay=1` });
    });

    showMsg(`✓ ${result.count} props sent`);
    sendBtn.textContent = "✓ SENT";
    setTimeout(() => { sendBtn.disabled = false; sendBtn.textContent = "★ SEND AGAIN"; }, 3000);
  } catch(err) {
    showMsg("Error: " + err.message);
    sendBtn.disabled = false;
    sendBtn.textContent = "★ RETRY";
  }
});

// ─── OPEN PRIZEPICKS ──────────────────────────────────────────────────────────
openPPBtn.addEventListener("click", () => {
  chrome.tabs.query({ url: "https://app.prizepicks.com/*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
      showMsg("Switched to PrizePicks");
    } else {
      chrome.tabs.create({ url: "https://app.prizepicks.com" });
      showMsg("Opening PrizePicks…");
    }
  });
});

// ─── CLEAR ────────────────────────────────────────────────────────────────────
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CLEAR" }, () => {
      setStatus("○ CLEARED", "gray");
      document.getElementById("countText").textContent = "0";
      document.getElementById("esportsText").textContent = "0";
      document.getElementById("timestampText").textContent = "—";
      sendBtn.disabled = true;
      sendBtn.textContent = "★ SEND PROPS";
      showMsg("✓ Cleared");
    });
  });
}

function showMsg(msg) {
  messageEl.textContent = msg;
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => { messageEl.textContent = ""; }, 7000);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTimeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
