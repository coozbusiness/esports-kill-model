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
  // VERIFIED from live PP API response 2026-03-08 - these are the REAL esport league IDs
  "121",  // LoL
  "145",  // COD
  "159",  // VAL
  "161",  // RL
  "174",  // Dota2
  "265",  // CS2
  "267",  // HALO
  "268",  // APEX
  "274",  // R6
];

const ESPORT_SPORT_VALUES = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
  "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
]);
const ESPORT_NAME_KEYWORDS = [
  // Full names (tournament-level leagues)
  "league of legends","valorant","vct","counter-strike","cs2","csgo",
  "dota","call of duty","cdl","apex legends","algs","rainbow six","r6","siege",
  "rocket league","rlcs","overwatch","starcraft","halo","esport","e-sport",
  "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
  "esl pro","blast","iem ","pgl ","dreamleague","esl one",
  // PP short-code league names (CONFIRMED from live API: these are the actual name values)
  "lol","cod","val","dota2","apex","rl","halo",
];

function isEsportLeague(league) {
  // PP /leagues returns flat { id, sport, name }
  // PP /projections included[] returns { attributes: { sport, name } }
  // Handle both formats:
  const sport = (league.attributes?.sport || league.sport || "").toUpperCase().trim();
  if (ESPORT_SPORT_VALUES.has(sport)) return true;
  const name = (
    league.attributes?.name || league.attributes?.display_name ||
    league.name || league.display_name || ""
  ).toLowerCase();
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
  showMsg("Fetching esport league list…");

  const allData = [];
  const allIncluded = [];
  const seenIds = new Set();
  const seenIncIds = new Set();

  function mergeResponse(json) {
    let added = 0;
    (json?.data || []).forEach(p => {
      if (!seenIds.has(p.id)) { seenIds.add(p.id); allData.push(p); added++; }
    });
    (json?.included || []).forEach(inc => {
      const k = inc.type + ":" + inc.id;
      if (!seenIncIds.has(k)) { seenIncIds.add(k); allIncluded.push(inc); }
    });
    return added;
  }

  try {
    // ── STEP 1: Discover esport league IDs via /leagues ──────────────────────
    // /leagues returns JSON:API format: { data: [{ id, type:"league", attributes:{ sport, name } }] }
    // Fall back to hardcoded range if /leagues fails or returns 0 esports.
    const FALLBACK_IDS = [
      // VERIFIED real esport league IDs from live PP API (2026-03-08)
      "121",  // LoL
      "145",  // COD
      "159",  // VAL
      "161",  // RL
      "174",  // Dota2
      "265",  // CS2
      "267",  // HALO
      "268",  // APEX
      "274",  // R6
    ];
    const ESPORT_SPORTS = new Set([
      "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
      "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
      "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
      "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
    ]);
    const ESPORT_KEYWORDS = [
      "league of legends","valorant","vct","counter-strike","cs2","csgo",
      "dota","call of duty","cdl","apex legends","algs","rainbow six","r6","siege",
      "rocket league","rlcs","overwatch","starcraft","halo","esport","e-sport",
      "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
      "esl pro","blast","iem ","pgl ","dreamleague","esl one",
    ];
    function leagueIsEsport(l) {
      // PP /leagues: NO sport field. Only name. Names are short codes like "CS2","LoL","COD","VAL"
      // Must match by name only. Short codes confirmed from live API 2026-03-08.
      const name = (l.attributes?.name || l.attributes?.display_name || l.name || "").toLowerCase().trim();
      return ESPORT_KEYWORDS.some(kw => name === kw || name.includes(kw));
    }

    let leagueIds = [];
    try {
      const lr = await fetch("https://api.prizepicks.com/leagues", {
        headers: { "Accept": "application/json" }
      });
      if (lr.ok) {
        const lj = await lr.json();
        const allLeagues = Array.isArray(lj) ? lj : (lj?.data || []);
        const esportLeagues = allLeagues.filter(leagueIsEsport);
        leagueIds = esportLeagues.map(l => String(l.id)).filter(Boolean);
        console.log("[KM] /leagues esports:", esportLeagues.map(l => l.attributes?.name || l.id).join(", "));
        showMsg(`Found ${leagueIds.length} esport leagues — fetching props…`);
      }
    } catch(e) {
      console.warn("[KM] /leagues failed:", e.message);
    }

    // Always merge in fallback IDs so known sports never get missed
    FALLBACK_IDS.forEach(id => { if (!leagueIds.includes(id)) leagueIds.push(id); });
    console.log("[KM] Total league IDs to fetch:", leagueIds.length);

    // ── STEP 2: Fetch /projections per league ID ─────────────────────────────
    // Sequential with 200ms gap to avoid PP rate-limits.
    for (let i = 0; i < leagueIds.length; i++) {
      const lid = leagueIds[i];
      fetchAllBtn.textContent = `◌ LEAGUE ${i+1}/${leagueIds.length} (${allData.length} props)`;
      try {
        const r = await fetch(
          `https://api.prizepicks.com/projections?league_id=${lid}&per_page=250&single_stat=true`,
          { headers: { "Accept": "application/json" } }
        );
        if (r.status === 429) {
          console.warn(`[KM] 429 on league ${lid} — waiting 3s`);
          await new Promise(r => setTimeout(r, 3000));
          i--; continue; // retry
        }
        if (r.ok) {
          const j = await r.json();
          const added = mergeResponse(j);
          if (added > 0) console.log(`[KM] League ${lid}: +${added} props`);
        }
      } catch(e) { /* skip timed-out league */ }
      await new Promise(r => setTimeout(r, 200));
    }

    // ── STEP 3: Broad sweep — catches any props not tied to a league_id ──────
    // Some PP props have sport on the projection itself with no league relationship.
    // background.js isEsport() catches these via proj.attributes.sport check.
    fetchAllBtn.textContent = "◌ BROAD SWEEP…";
    try {
      const r = await fetch(
        "https://api.prizepicks.com/projections?per_page=500&single_stat=true",
        { headers: { "Accept": "application/json" } }
      );
      if (r.ok) {
        const j = await r.json();
        const added = mergeResponse(j);
        if (added > 0) console.log("[KM] Broad sweep added:", added);
      }
    } catch(e) { /* broad sweep is best-effort */ }

    if (allData.length === 0) {
      showMsg("⚠ No props fetched. Open PrizePicks in a tab first, then retry.");
      fetchAllBtn.disabled = false;
      fetchAllBtn.textContent = "⬇ FETCH ALL DIRECT";
      return;
    }

    // ── STEP 4: Send ALL data to background — background.js filters esports ──
    // DO NOT pre-filter here. The popup's league lookup is unreliable because
    // PP props often have no direct league relationship on the projection object.
    // background.js isEsport() handles all edge cases (player→league, sport field, etc).
    fetchAllBtn.textContent = "◌ STORING…";
    const merged = { data: allData, included: allIncluded };

    chrome.runtime.sendMessage({
      type: "STORE_DIRECT_FETCH",
      projections: merged,
      trusted_source: false, // Let background.js run its full isEsport() filter
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
      showMsg(`✓ ${count} esports props stored (${allData.length} total fetched)`);
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
