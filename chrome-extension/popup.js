const sendBtn     = document.getElementById("sendBtn");
const openPPBtn   = document.getElementById("openPP");
const fetchAllBtn = document.getElementById("fetchAllBtn");
const saveUrlBtn  = document.getElementById("saveUrl");
const appUrlInput = document.getElementById("appUrl");
const messageEl   = document.getElementById("message");
const clearBtn    = document.getElementById("clearBtn");

const DEFAULT_BACKEND = "https://esports-kill-model.onrender.com";

// ─── KNOWN ESPORT LEAGUE IDs ──────────────────────────────────────────────────
// Hardcoded PP esport league IDs — these NEVER change once assigned by PP.
// Primary fetch path: always fetch these first, no /leagues discovery needed.
// Sourced from PP API observation across LoL, CS2, VAL, Dota2, R6, COD, APEX.
const KNOWN_ESPORT_LEAGUE_IDS = [
  // Core verified IDs (seen in live data)
  "197","230","232","233","234","235","236","237","238","239",
  "240","241","242","243","244","245","246","247","248","249","250",
  // Extended range — covers newer leagues PP may have added
  "251","252","253","254","255","256","257","258","259","260",
  "261","262","263","264","265","266","267","268","269","270",
];

const ESPORT_SPORT_VALUES = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
  "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
]);
const ESPORT_NAME_KEYWORDS = [
  "league of legends","valorant","vct","counter-strike","cs2","csgo",
  "dota","call of duty","cdl","apex legends","algs","rainbow six","r6","siege",
  "rocket league","rlcs","overwatch","starcraft","halo","esport","e-sport",
  "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
  "esl pro","blast","iem ","pgl ","dreamleague","esl one",
];

function isEsportLeague(league) {
  const sport = (league.attributes?.sport || "").toUpperCase().trim();
  if (ESPORT_SPORT_VALUES.has(sport)) return true;
  const name = (league.attributes?.name || league.attributes?.display_name || "").toLowerCase();
  return ESPORT_NAME_KEYWORDS.some(kw => name.includes(kw));
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
// Strategy: skip /leagues discovery (unreliable) — use hardcoded IDs as primary
// path, supplement with any new IDs found in /leagues, always do broad sweep.
// Mark all data as trusted_source=true so background.js skips isEsport re-filter.
fetchAllBtn.addEventListener("click", async () => {
  fetchAllBtn.disabled = true;
  fetchAllBtn.textContent = "◌ STEP 1: LEAGUES…";

  const allData = [];
  const allIncluded = [];
  const seenIds = new Set();
  const seenIncIds = new Set();

  function mergeResponse(json) {
    let added = 0;
    (json?.data || []).forEach(p => {
      if (!seenIds.has(p.id)) { seenIds.add(p.id); allData.push(p); added++; }
    });
    (json?.included || []).forEach(i => {
      const k = i.type + ":" + i.id;
      if (!seenIncIds.has(k)) { seenIncIds.add(k); allIncluded.push(i); }
    });
    return added;
  }

  try {
    // ── STEP 1: Try /leagues to find any NEW esport league IDs ──────────────
    // Start with known hardcoded IDs — /leagues just supplements them
    let leagueIds = [...KNOWN_ESPORT_LEAGUE_IDS];
    try {
      const lr = await fetch("https://api.prizepicks.com/leagues", {
        headers: { "Accept": "application/json" }
      });
      if (lr.ok) {
        const lj = await lr.json();
        const leagues = Array.isArray(lj) ? lj : (lj?.data || []);
        const esportLeagues = leagues.filter(isEsportLeague);
        const discovered = esportLeagues.map(l => String(l.id || l.attributes?.id));
        // Add any new IDs not already in our hardcoded list
        const newIds = discovered.filter(id => id && !leagueIds.includes(id));
        if (newIds.length) {
          leagueIds = [...leagueIds, ...newIds];
          console.log("[KM] /leagues found new IDs:", newIds.join(","));
        }
        console.log("[KM] Total league IDs to fetch:", leagueIds.length,
          "| discovered esport names:", esportLeagues.map(l => l.attributes?.name || l.id).join(", "));
        showMsg(`${esportLeagues.length} leagues found — fetching ${leagueIds.length} league IDs…`);
      }
    } catch(e) {
      console.warn("[KM] /leagues failed:", e.message, "— using hardcoded IDs only");
      showMsg(`/leagues unavailable — using ${leagueIds.length} hardcoded IDs…`);
    }

    // ── STEP 2: Fetch each league ID sequentially (250ms gap) ───────────────
    // MUST be sequential — PP rate-limits parallel fetches.
    // Skip IDs that return empty to avoid wasting time.
    let fetched = 0, withProps = 0;
    for (let i = 0; i < leagueIds.length; i++) {
      const lid = leagueIds[i];
      fetchAllBtn.textContent = `◌ ${i+1}/${leagueIds.length} (${allData.length} props)`;
      try {
        const r = await fetch(
          `https://api.prizepicks.com/projections?league_id=${lid}&per_page=250&single_stat=true`,
          { headers: { "Accept": "application/json" } }
        );
        if (r.ok) {
          const j = await r.json();
          const added = mergeResponse(j);
          if (added > 0) {
            withProps++;
            console.log(`[KM] League ${lid}: +${added} props`);
          }
          fetched++;
        } else if (r.status === 429) {
          // Rate limited — back off and retry this one
          console.warn(`[KM] League ${lid}: 429 rate limit — waiting 3s`);
          await new Promise(r => setTimeout(r, 3000));
          i--; // retry same league
          continue;
        }
      } catch(e) { /* skip timed-out league */ }
      await new Promise(r => setTimeout(r, 300)); // 300ms between each
    }

    // ── STEP 3: Broad sweep — catches any props missed by league IDs ─────────
    fetchAllBtn.textContent = "◌ BROAD SWEEP…";
    try {
      const r = await fetch(
        "https://api.prizepicks.com/projections?per_page=500&single_stat=true",
        { headers: { "Accept": "application/json" } }
      );
      if (r.ok) {
        const j = await r.json();
        const added = mergeResponse(j);
        console.log(`[KM] Broad sweep: +${added} props`);
      }
    } catch(e) { console.warn("[KM] Broad sweep failed:", e.message); }

    console.log(`[KM] Fetch complete: ${allData.length} total props from ${withProps}/${fetched} leagues`);

    if (allData.length === 0) {
      showMsg("⚠ No props found. PrizePicks may be blocking. Try opening PP first.");
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
      return;
    }

    // ── STEP 4: Store via background — trusted_source=true skips re-filter ───
    fetchAllBtn.textContent = "◌ STORING…";
    const merged = { data: allData, included: allIncluded };

    chrome.runtime.sendMessage({
      type: "STORE_DIRECT_FETCH",
      projections: merged,
      trusted_source: true, // came from explicit esport league fetch — skip isEsport re-filter
    }, (response) => {
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
      showMsg(`✓ ${count} props (${allData.length} fetched, ${withProps} leagues had data)`);
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
    });

  } catch(err) {
    showMsg("Error: " + err.message);
    fetchAllBtn.disabled = false;
    fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
  }
});

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
  showMsg._t = setTimeout(() => { messageEl.textContent = ""; }, 8000);
}

function getTimeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
