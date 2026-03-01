// ─── ESPORT FILTER ────────────────────────────────────────────────────────────
// Broad sport codes — PrizePicks may use full names like "Call of Duty" not "COD"
const ESPORT_CODES = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALLOFDUTY","CALL OF DUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "RAINBOW SIX","APEX LEGENDS","ROCKET LEAGUE","OVERWATCH","STARCRAFT","HALO"
]);
const ESPORT_KEYWORDS = [
  "league of legends","valorant","counter-strike","cs2","csgo","dota","rainbow six",
  "call of duty","apex legends","lol","vct","lck","lpl","lec","lcs","lta","lcp",
  "cdl","algs","r6","siege","rocket league","rlcs","overwatch","starcraft","halo",
  "esport","e-sport","gaming","cdl","cod","val","r6s","pubg","fortnite"
];

function buildLookups(included) {
  const leagueSport = {}, leagueName = {}, playerLeague = {};
  for (const item of (included || [])) {
    if (item.type === "league") {
      if (item.attributes?.sport) leagueSport[item.id] = (item.attributes.sport || "").toUpperCase().trim();
      if (item.attributes?.name)  leagueName[item.id]  = (item.attributes.name  || "").toLowerCase();
    }
    if (item.type === "new_player" && item.relationships?.league?.data?.id) {
      playerLeague[item.id] = item.relationships.league.data.id;
    }
  }
  return { leagueSport, leagueName, playerLeague };
}

function isEsport(proj, maps) {
  // Check projection's own sport/league attributes first
  const projSport = (proj.attributes?.sport || proj.attributes?.league || "").toUpperCase();
  if (projSport && (ESPORT_CODES.has(projSport) || ESPORT_KEYWORDS.some(kw => projSport.toLowerCase().includes(kw)))) return true;

  let lid = proj.relationships?.league?.data?.id;
  if (!lid) {
    const pid = proj.relationships?.new_player?.data?.id;
    if (pid) lid = maps.playerLeague[pid];
  }
  if (!lid) {
    // No league ID at all — log and include if any esports hint in description
    const desc = (proj.attributes?.description || "").toLowerCase();
    return ESPORT_KEYWORDS.some(kw => desc.includes(kw));
  }

  const rawSport = maps.leagueSport[lid] || "";
  if (rawSport && ESPORT_CODES.has(rawSport)) return true;
  if (rawSport && ESPORT_KEYWORDS.some(kw => rawSport.toLowerCase().includes(kw))) return true;

  const name = maps.leagueName[lid] || "";
  if (name && ESPORT_KEYWORDS.some(kw => name.includes(kw))) return true;

  return false;
}

// Slim down projections to only what the app needs — kills quota usage
function slimProjection(p) {
  return {
    id: p.id,
    type: p.type,
    attributes: {
      line_score:      p.attributes?.line_score,
      stat_type:       p.attributes?.stat_type,
      description:     p.attributes?.description,
      status:          p.attributes?.status,
      board_time:      p.attributes?.board_time,
      is_promo:        p.attributes?.is_promo,
      goblin_line:     p.attributes?.goblin_line,
      demon_line:      p.attributes?.demon_line,
    },
    relationships: p.relationships,
  };
}

function slimIncluded(item) {
  if (item.type === "new_player") {
    return {
      id: item.id, type: item.type,
      attributes: {
        name:        item.attributes?.name,
        display_name: item.attributes?.display_name,
        team:        item.attributes?.team,
        position:    item.attributes?.position,
        image_url:   item.attributes?.image_url,
      },
      relationships: item.relationships,
    };
  }
  if (item.type === "league") {
    return {
      id: item.id, type: item.type,
      attributes: {
        name:    item.attributes?.name,
        sport:   item.attributes?.sport,
        display_name: item.attributes?.display_name,
      },
    };
  }
  if (item.type === "game") {
    return {
      id: item.id, type: item.type,
      attributes: {
        scheduled_at: item.attributes?.scheduled_at,
        title:        item.attributes?.title,
      },
    };
  }
  return { id: item.id, type: item.type, attributes: item.attributes, relationships: item.relationships };
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

    // Slim everything down before storage
    const slimData = filteredData.map(slimProjection);
    const incomingIds = new Set(slimData.map(p => p.id));

    // Only keep included items referenced by our filtered projections
    const neededPlayerIds = new Set();
    const neededLeagueIds = new Set();
    const neededGameIds = new Set();
    slimData.forEach(p => {
      const pid = p.relationships?.new_player?.data?.id;
      const lid = p.relationships?.league?.data?.id;
      const gid = p.relationships?.game?.data?.id;
      if (pid) neededPlayerIds.add(pid);
      if (lid) neededLeagueIds.add(lid);
      if (gid) neededGameIds.add(gid);
    });

    const relevantIncluded = (incoming.included || []).filter(i => {
      if (i.type === "new_player") return neededPlayerIds.has(i.id);
      if (i.type === "league")     return neededLeagueIds.has(i.id);
      if (i.type === "game")       return neededGameIds.has(i.id);
      return false;
    }).map(slimIncluded);

    const filteredIncoming = { data: slimData, included: relevantIncluded };

    // OVERWRITE not merge — prevents 17000 prop accumulation bug
    // Each fresh load of PrizePicks replaces stored data completely
    const count = filteredIncoming.data.length;
    chrome.storage.local.set(
      { projections: filteredIncoming, timestamp: new Date().toISOString(), count, esportsCount: count },
      () => {
        if (chrome.runtime.lastError) {
          console.warn("[Kill Model] Storage error:", chrome.runtime.lastError.message);
        }
      }
    );
    sendResponse({ ok: true, count, esportsCount: count });
    return true;
  }

  // Direct fetch from popup — same pipeline
  if (message.type === "STORE_DIRECT_FETCH") {
    const incoming = message.projections;
    const maps = buildLookups(incoming.included);
    
    // Filter to esports only — direct fetch gets all sports, we need to filter
    const filteredData = (incoming.data || []).filter(p => isEsport(p, maps));
    console.log("[Kill Model] STORE_DIRECT_FETCH: total=" + (incoming.data||[]).length + " esports=" + filteredData.length);
    const slimData = filteredData.map(slimProjection);

    const neededPlayerIds = new Set();
    const neededLeagueIds = new Set();
    const neededGameIds = new Set();
    slimData.forEach(p => {
      const pid = p.relationships?.new_player?.data?.id;
      const lid = p.relationships?.league?.data?.id;
      const gid = p.relationships?.game?.data?.id;
      if (pid) neededPlayerIds.add(pid);
      if (lid) neededLeagueIds.add(lid);
      if (gid) neededGameIds.add(gid);
    });

    const relevantIncluded = (incoming.included || []).filter(i => {
      if (i.type === "new_player") return neededPlayerIds.has(i.id);
      if (i.type === "league")     return neededLeagueIds.has(i.id);
      if (i.type === "game")       return neededGameIds.has(i.id);
      return false;
    }).map(slimIncluded);

    const toStore = { data: slimData, included: relevantIncluded };
    const count = slimData.length;

    chrome.storage.local.set(
      { projections: toStore, timestamp: new Date().toISOString(), count, esportsCount: count },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: "quota_exceeded_even_after_slim" });
        } else {
          sendResponse({ ok: true, count, esportsCount: count });
        }
      }
    );
    return true;
  }

  if (message.type === "AUTO_CAPTURE_DONE") {
    console.log(`[Kill Model] Auto-capture complete: ${message.total} props across ${message.tabs} tabs`);
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
