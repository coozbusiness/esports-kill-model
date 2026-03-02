// ─── ESPORT IDENTIFICATION ────────────────────────────────────────────────────
// PrizePicks league names for esports — match against league name/display_name
// These are substring matches so "VCT Americas" matches "vct", "CDL Major" matches "cdl", etc.
const ESPORT_LEAGUE_KEYWORDS = [
  "league of legends","valorant","vct","counter-strike","cs2","csgo",
  "dota","call of duty","cdl","apex legends","algs","rainbow six","r6",
  "rocket league","rlcs","overwatch","starcraft","halo","pubg","fortnite",
  "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
  "esl pro league","blast","iem ","pgl ","dreamleague","esl one",
  "esport","e-sport"
];

// Sport attribute values PrizePicks uses for esports leagues
const ESPORT_SPORT_VALUES = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
  "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS"
]);

// Cache of known esport league IDs — populated from /leagues endpoint or learned from data
// Key insight: once we know a league ID is esports, we never misclassify it
let knownEsportLeagueIds = new Set();
let knownNonEsportLeagueIds = new Set();

function isEsportLeagueName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return ESPORT_LEAGUE_KEYWORDS.some(kw => lower.includes(kw));
}

function isEsportSport(sport) {
  if (!sport) return false;
  return ESPORT_SPORT_VALUES.has(sport.toUpperCase().trim());
}

function buildLookups(included) {
  const leagueSport = {}, leagueName = {}, leagueDisplay = {}, playerLeague = {};
  for (const item of (included || [])) {
    if (item.type === "league") {
      const sport = item.attributes?.sport || item.attributes?.category || "";
      if (sport) leagueSport[item.id] = sport.toUpperCase().trim();
      if (item.attributes?.name)         leagueName[item.id]    = (item.attributes.name || "");
      if (item.attributes?.display_name) leagueDisplay[item.id] = (item.attributes.display_name || "");

      // Learn league IDs from this response
      const lname = item.attributes?.name || item.attributes?.display_name || "";
      const lsport = sport.toUpperCase().trim();
      if (isEsportSport(lsport) || isEsportLeagueName(lname)) {
        knownEsportLeagueIds.add(item.id);
      } else if (lname && !isEsportLeagueName(lname)) {
        // Only mark as non-esport if we have a name and it's clearly not esports
        const clearlyNonEsport = ["nba","nfl","mlb","nhl","nba","ncaa","college",
          "premier league","bundesliga","la liga","serie a","mls","ufc","pga",
          "tennis","golf","nascar","baseball","football","basketball","hockey","soccer"];
        if (clearlyNonEsport.some(s => lname.toLowerCase().includes(s))) {
          knownNonEsportLeagueIds.add(item.id);
        }
      }
    }
    if ((item.type === "new_player" || item.type === "player") && item.relationships?.league?.data?.id) {
      playerLeague[item.id] = item.relationships.league.data.id;
    }
  }
  return { leagueSport, leagueName, leagueDisplay, playerLeague };
}

function isEsport(proj, maps) {
  // Resolve league ID for this projection
  let lid = proj.relationships?.league?.data?.id;
  if (!lid) {
    const pid = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
    if (pid) lid = maps.playerLeague[pid];
  }

  if (lid) {
    // Cached known answer — fastest path
    if (knownEsportLeagueIds.has(lid)) return true;
    if (knownNonEsportLeagueIds.has(lid)) return false;

    // Check sport attribute
    const sport = maps.leagueSport[lid] || "";
    if (isEsportSport(sport)) { knownEsportLeagueIds.add(lid); return true; }

    // Check league name
    const lname = maps.leagueName[lid] || maps.leagueDisplay[lid] || "";
    if (isEsportLeagueName(lname)) { knownEsportLeagueIds.add(lid); return true; }
  }

  // Check projection's own sport attribute (some PP responses include this)
  const projSport = (proj.attributes?.sport || "").trim();
  if (isEsportSport(projSport)) return true;
  if (isEsportLeagueName(projSport)) return true;

  // NO FALLBACK ON STAT TYPE — that's what was pulling in basketball
  return false;
}

// Slim down projections to only what the app needs
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
  if (item.type === "new_player" || item.type === "player") {
    return {
      id: item.id, type: item.type,
      attributes: {
        name:         item.attributes?.name,
        display_name: item.attributes?.display_name,
        team:         item.attributes?.team,
        position:     item.attributes?.position,
        image_url:    item.attributes?.image_url,
      },
      relationships: item.relationships,
    };
  }
  if (item.type === "league") {
    return {
      id: item.id, type: item.type,
      attributes: {
        name:         item.attributes?.name,
        display_name: item.attributes?.display_name,
        sport:        item.attributes?.sport,
      },
    };
  }
  if (item.type === "game") {
    return {
      id: item.id, type: item.type,
      attributes: {
        start_time:    item.attributes?.start_time,
        description:   item.attributes?.description,
        away_team_id:  item.attributes?.away_team_id,
        home_team_id:  item.attributes?.home_team_id,
        status:        item.attributes?.status,
      },
    };
  }
  return item;
}


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

    // Log all league names/sports so we can see what PrizePicks sends
    const seenSports = new Set();
    const seenNames = new Set();
    (incoming.included || []).forEach(i => {
      if (i.type === "league") {
        if (i.attributes?.sport) seenSports.add(i.attributes.sport);
        if (i.attributes?.name) seenNames.add(i.attributes.name);
        if (i.attributes?.display_name) seenNames.add(i.attributes.display_name);
      }
    });
    console.log("[KM] Sports:", [...seenSports].sort().join(", "));
    console.log("[KM] League names:", [...seenNames].sort().join(", "));

    const filteredData = (incoming.data || []).filter(p => isEsport(p, maps));
    console.log("[KM] Total props:", (incoming.data||[]).length, "→ Esports:", filteredData.length);
    console.log("[KM] Known esport league IDs:", [...knownEsportLeagueIds].join(","));

    const slimData = filteredData.map(slimProjection);

    const neededPlayerIds = new Set();
    const neededLeagueIds = new Set();
    const neededGameIds = new Set();
    slimData.forEach(p => {
      const pid = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
      const lid = p.relationships?.league?.data?.id;
      const gid = p.relationships?.game?.data?.id;
      if (pid) neededPlayerIds.add(pid);
      if (lid) neededLeagueIds.add(lid);
      if (gid) neededGameIds.add(gid);
    });

    const relevantIncluded = (incoming.included || []).filter(i => {
      if (i.type === "new_player" || i.type === "player") return neededPlayerIds.has(i.id);
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
          console.error("[KM] Storage error:", chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
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
