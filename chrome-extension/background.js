chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRIZEPICKS_DATA") {
    const incoming = message.projections;
    const included = incoming.included || [];

    // Build lookup maps from included objects
    const leagueSportMap = {};
    const leagueNameMap = {};
    included.forEach(item => {
      if (item.type === "league") {
        if (item.attributes?.sport) leagueSportMap[item.id] = (item.attributes.sport || "").toUpperCase();
        if (item.attributes?.name)  leagueNameMap[item.id]  = (item.attributes.name  || "").toLowerCase();
      }
    });

    // Also check new_player -> league path via included players
    const playerLeagueMap = {};
    included.forEach(item => {
      if (item.type === "new_player" && item.relationships?.league?.data?.id) {
        playerLeagueMap[item.id] = item.relationships.league.data.id;
      }
    });

    const ESPORTS_CODES = new Set(["VAL","LOL","CS2","CSGO","DOTA","DOTA2","R6","COD","APEX"]);
    const ESPORTS_KEYWORDS = ["league of legends","valorant","counter-strike","cs2","dota","rainbow six","call of duty","apex legends","lol","vct","lck","lpl","lec","lcs","cdl","algs","r6"];

    function isEsport(proj) {
      // Path 1: projection -> league directly
      let lid = proj.relationships?.league?.data?.id;
      // Path 2: projection -> new_player -> league
      if (!lid) {
        const pid = proj.relationships?.new_player?.data?.id;
        if (pid) lid = playerLeagueMap[pid];
      }
      if (!lid) return false;

      const code = leagueSportMap[lid] || "";
      if (ESPORTS_CODES.has(code)) return true;

      const name = leagueNameMap[lid] || "";
      return ESPORTS_KEYWORDS.some(kw => name.includes(kw));
    }

    const filteredData = (incoming.data || []).filter(isEsport);

    if (filteredData.length === 0) {
      sendResponse({ ok: true, count: 0, esportsCount: 0 });
      return true;
    }

    const filteredIncoming = { ...incoming, data: filteredData };
    const incomingIds = new Set(filteredData.map(p => p.id));

    chrome.storage.local.get(['projections'], (stored) => {
      const existing = stored.projections;
      let merged;

      if (existing && Array.isArray(existing.data) && existing.data.length > 0) {
        const kept = existing.data.filter(p => !incomingIds.has(p.id));
        const existingIncludedIds = new Set((existing.included || []).map(x => x.type + x.id));
        const newIncluded = (included).filter(i => !existingIncludedIds.has(i.type + i.id));
        merged = {
          ...filteredIncoming,
          data: [...kept, ...filteredData],
          included: [...(existing.included || []), ...newIncluded]
        };
      } else {
        merged = filteredIncoming;
      }

      const count = merged.data.length;
      chrome.storage.local.set({
        projections: merged,
        timestamp: new Date().toISOString(),
        count,
        esportsCount: count,
      });

      console.log(`[Kill Model] Stored ${count} esports props (added ${filteredData.length} from this batch)`);
      sendResponse({ ok: true, count, esportsCount: count });
    });
    return true;
  }

  if (message.type === "GET_LATEST") {
    chrome.storage.local.get(["projections","timestamp","count","esportsCount"], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (message.type === "CLEAR") {
    chrome.storage.local.clear();
    sendResponse({ ok: true });
  }
});
