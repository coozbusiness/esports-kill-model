// ─── ESPORT FILTER ────────────────────────────────────────────────────────────
const ESPORT_CODES = new Set(["VAL","LOL","CS2","CSGO","DOTA","DOTA2","R6","COD","APEX"]);
const ESPORT_KEYWORDS = [
  "league of legends","valorant","counter-strike","cs2","dota","rainbow six",
  "call of duty","apex legends","lol","vct","lck","lpl","lec","lcs","cdl","algs","r6","siege"
];

function buildLookups(included) {
  const leagueSport = {}, leagueName = {}, playerLeague = {};
  for (const item of (included || [])) {
    if (item.type === "league") {
      if (item.attributes?.sport) leagueSport[item.id] = (item.attributes.sport || "").toUpperCase();
      if (item.attributes?.name)  leagueName[item.id]  = (item.attributes.name  || "").toLowerCase();
    }
    if (item.type === "new_player" && item.relationships?.league?.data?.id) {
      playerLeague[item.id] = item.relationships.league.data.id;
    }
  }
  return { leagueSport, leagueName, playerLeague };
}

function isEsport(proj, maps) {
  let lid = proj.relationships?.league?.data?.id;
  if (!lid) {
    const pid = proj.relationships?.new_player?.data?.id;
    if (pid) lid = maps.playerLeague[pid];
  }
  if (!lid) return false;
  const code = maps.leagueSport[lid] || "";
  if (ESPORT_CODES.has(code)) return true;
  const name = maps.leagueName[lid] || "";
  return ESPORT_KEYWORDS.some(kw => name.includes(kw));
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "PRIZEPICKS_DATA") {
    const incoming = message.projections;
    const maps = buildLookups(incoming.included);
    const filteredData = (incoming.data || []).filter(p => isEsport(p, maps));

    if (filteredData.length === 0) {
      sendResponse({ ok: true, count: 0, esportsCount: 0 });
      return true;
    }

    const filteredIncoming = { ...incoming, data: filteredData };
    const incomingIds = new Set(filteredData.map(p => p.id));

    chrome.storage.local.get(["projections"], (stored) => {
      const existing = stored.projections;
      let merged;

      if (existing && Array.isArray(existing.data) && existing.data.length > 0) {
        const kept = existing.data.filter(p => !incomingIds.has(p.id));
        const existingIncIds = new Set((existing.included || []).map(x => x.type + ":" + x.id));
        const newInc = (incoming.included || []).filter(i => !existingIncIds.has(i.type + ":" + i.id));
        merged = {
          ...filteredIncoming,
          data: [...kept, ...filteredData],
          included: [...(existing.included || []), ...newInc],
        };
      } else {
        merged = filteredIncoming;
      }

      const count = merged.data.length;
      chrome.storage.local.set({ projections: merged, timestamp: new Date().toISOString(), count, esportsCount: count });
      console.log(`[Kill Model] ${count} esports props stored (added ${filteredData.length} from this batch)`);
      sendResponse({ ok: true, count, esportsCount: count });
    });
    return true;
  }

  if (message.type === "AUTO_CAPTURE_DONE") {
    // Fired when inject-shim finishes clicking all tabs
    console.log(`[Kill Model] Auto-capture complete: ${message.total} props across ${message.tabs} tabs`);
    // Badge the extension icon with count
    chrome.action.setBadgeText({ text: String(message.total) });
    chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });
    return true;
  }

  if (message.type === "GET_LATEST") {
    chrome.storage.local.get(["projections","timestamp","count","esportsCount"], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (message.type === "CLEAR") {
    chrome.storage.local.clear(() => {
      chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Clear badge on install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
