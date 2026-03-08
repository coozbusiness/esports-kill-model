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
    const trustedSource = message.trusted_source === true; // came from explicit esport league fetch
    const maps = buildLookups(incoming.included);

    // Log what we received for debugging
    const seenSports = new Set();
    const seenNames = new Set();
    (incoming.included || []).forEach(i => {
      if (i.type === "league") {
        if (i.attributes?.sport) seenSports.add(i.attributes.sport);
        if (i.attributes?.name) seenNames.add(i.attributes.name);
        if (i.attributes?.display_name) seenNames.add(i.attributes.display_name);
      }
    });
    console.log("[KM] Sports in included:", [...seenSports].sort().join(", ") || "(none)");
    console.log("[KM] League names:", [...seenNames].sort().join(", ") || "(none)");

    // trusted_source=true means data came from explicit esport league ID fetches —
    // skip isEsport re-filter entirely (the source IS the filter).
    // Without trusted_source, apply isEsport filter to avoid non-esport props.
    const filteredData = trustedSource
      ? (incoming.data || [])
      : (incoming.data || []).filter(p => isEsport(p, maps));

    console.log("[KM] Total props received:", (incoming.data||[]).length,
      "→ After filter:", filteredData.length,
      trustedSource ? "(trusted source — no re-filter)" : "(isEsport filtered)");

    if (filteredData.length === 0) {
      sendResponse({ ok: true, count: 0, esportsCount: 0 });
      return true;
    }

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

  // FETCH_AND_RELAY: triggered by the web app to run a full fetch + relay in one step.
  // Uses the extension's host permissions (bypasses CORS) to fetch all esport leagues,
  // filters to esports only, stores in chrome.storage, then POSTs to the relay backend.
  if (message.type === "FETCH_AND_RELAY") {
    const backendUrl = (message.backendUrl || "https://esports-kill-model.onrender.com").replace(/\/$/, "");
    (async () => {
      try {
        sendResponse({ ok: true, status: "started" });

        const ESPORT_KEYWORDS = [
          "league of legends","lol","lck","lcs","lec","lpl","lta","lcp","worlds","msi",
          "valorant","vct","counter-strike","cs2","csgo","esl","blast","iem","pgl","pro league",
          "dota","dota2","the international","dreamleague","call of duty","cod","cdl",
          "rainbow six","r6","siege","apex legends","algs","rocket league","rlcs",
          "overwatch","owl","esport","e-sport",
        ];
        const ESPORT_SPORTS = new Set([
          "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
          "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
          "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
          "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
        ]);
        function isEsportLeague(league) {
          const sport = (league.attributes?.sport || "").toUpperCase().trim();
          if (ESPORT_SPORTS.has(sport)) return true;
          const name = (league.attributes?.name || league.attributes?.display_name || "").toLowerCase();
          return ESPORT_KEYWORDS.some(kw => name.includes(kw));
        }

        // Step 1: discover esport league IDs
        let esportLeagueIds = [];
        try {
          const lr = await fetch("https://api.prizepicks.com/leagues", { headers: { "Accept": "application/json" } });
          if (lr.ok) {
            const lj = await lr.json();
            const leagues = Array.isArray(lj) ? lj : (lj?.data || []);
            esportLeagueIds = leagues.filter(isEsportLeague).map(l => String(l.id));
            console.log("[KM BG] Found", esportLeagueIds.length, "esport leagues");
          }
        } catch(e) { console.warn("[KM BG] /leagues failed:", e.message); }

        if (!esportLeagueIds.length) {
          esportLeagueIds = ["197","230","232","233","234","235","236","237","238","239","240","241","242","243","244","245","246","247","248","249","250"];
        }

        // Step 2: fetch each league sequentially (extension has host_permissions — no CORS)
        const allData = [], allIncluded = [];
        const seenIds = new Set(), seenIncIds = new Set();
        function mergeResp(json) {
          (json?.data || []).forEach(p => { if (!seenIds.has(p.id)) { seenIds.add(p.id); allData.push(p); } });
          (json?.included || []).forEach(i => { const k=i.type+":"+i.id; if (!seenIncIds.has(k)) { seenIncIds.add(k); allIncluded.push(i); } });
        }

        for (let i = 0; i < esportLeagueIds.length; i++) {
          try {
            const r = await fetch(
              `https://api.prizepicks.com/projections?league_id=${esportLeagueIds[i]}&per_page=250&single_stat=true`,
              { headers: { "Accept": "application/json" } }
            );
            if (r.ok) { const j = await r.json(); mergeResp(j); }
          } catch {}
          await new Promise(r => setTimeout(r, 250));
        }

        // Step 3: broad sweep
        try {
          const r = await fetch("https://api.prizepicks.com/projections?per_page=500&single_stat=true", { headers: { "Accept": "application/json" } });
          if (r.ok) { const j = await r.json(); mergeResp(j); }
        } catch {}

        if (!allData.length) {
          chrome.runtime.sendMessage({ type: "FETCH_AND_RELAY_DONE", ok: false, error: "No props found — PP may not have lines posted yet" });
          return;
        }

        // Step 4: filter esports + store
        const merged = { data: allData, included: allIncluded };
        const maps = buildLookups(allIncluded);
        const filteredData = allData.filter(p => isEsport(p, maps));
        const slimData = filteredData.map(slimProjection);
        const neededPlayerIds = new Set(), neededLeagueIds = new Set(), neededGameIds = new Set();
        slimData.forEach(p => {
          const pid = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
          const lid = p.relationships?.league?.data?.id;
          const gid = p.relationships?.game?.data?.id;
          if (pid) neededPlayerIds.add(pid);
          if (lid) neededLeagueIds.add(lid);
          if (gid) neededGameIds.add(gid);
        });
        const relevantIncluded = allIncluded.filter(i => {
          if (i.type==="new_player"||i.type==="player") return neededPlayerIds.has(i.id);
          if (i.type==="league") return neededLeagueIds.has(i.id);
          if (i.type==="game") return neededGameIds.has(i.id);
          return false;
        }).map(slimIncluded);
        const toStore = { data: slimData, included: relevantIncluded };
        const count = slimData.length;

        // Store locally
        chrome.storage.local.set({ projections: toStore, timestamp: new Date().toISOString(), count, esportsCount: count });
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });

        // Step 5: POST to relay so app can pick it up
        const relayRes = await fetch(`${backendUrl}/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toStore),
        });
        const relayOk = relayRes.ok;

        // Notify the app tab that data is ready
        chrome.tabs.query({}, tabs => {
          tabs.forEach(tab => {
            if (tab.url && (tab.url.includes("vercel.app") || tab.url.includes("localhost") || tab.url.includes("onrender.com"))) {
              chrome.tabs.sendMessage(tab.id, { type: "FETCH_AND_RELAY_DONE", ok: true, count, relayOk }).catch(() => {});
            }
          });
        });

        console.log(`[KM BG] FETCH_AND_RELAY done: ${count} props, relay: ${relayOk}`);
      } catch(err) {
        console.error("[KM BG] FETCH_AND_RELAY error:", err);
        chrome.tabs.query({}, tabs => {
          tabs.forEach(tab => {
            if (tab.url && (tab.url.includes("vercel.app") || tab.url.includes("localhost"))) {
              chrome.tabs.sendMessage(tab.id, { type: "FETCH_AND_RELAY_DONE", ok: false, error: err.message }).catch(() => {});
            }
          });
        });
      }
    })();
    return true; // keep channel open for async
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
