importScripts("stats-scraper.js");

// ─── ESPORT IDENTIFICATION ────────────────────────────────────────────────────
const ESPORT_LEAGUE_KEYWORDS = [
  "league of legends","valorant","vct","counter-strike","cs2","csgo",
  "dota","call of duty","cdl","apex legends","algs","rainbow six","r6",
  "rocket league","rlcs","overwatch","starcraft","halo","pubg","fortnite",
  "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
  "esl pro league","blast","iem ","pgl ","dreamleague","esl one",
  "esport","e-sport"
];
const ESPORT_SPORT_VALUES = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
  "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS"
]);
let knownEsportLeagueIds   = new Set();
let knownNonEsportLeagueIds = new Set();

function isEsportLeagueName(name) {
  if (!name) return false;
  const l = name.toLowerCase();
  return ESPORT_LEAGUE_KEYWORDS.some(kw => l.includes(kw));
}
function isEsportSport(sport) {
  if (!sport) return false;
  return ESPORT_SPORT_VALUES.has(sport.toUpperCase().trim());
}
function buildLookups(included) {
  const leagueSport={}, leagueName={}, leagueDisplay={}, playerLeague={};
  for (const item of (included||[])) {
    if (item.type==="league") {
      const sport = item.attributes?.sport || item.attributes?.category || "";
      if (sport) leagueSport[item.id] = sport.toUpperCase().trim();
      if (item.attributes?.name)         leagueName[item.id]    = item.attributes.name;
      if (item.attributes?.display_name) leagueDisplay[item.id] = item.attributes.display_name;
      const lname = item.attributes?.name || item.attributes?.display_name || "";
      const lsport = sport.toUpperCase().trim();
      if (isEsportSport(lsport)||isEsportLeagueName(lname)) { knownEsportLeagueIds.add(item.id); }
      else if (lname) {
        const nonE=["nba","nfl","mlb","nhl","ncaa","college","premier league","bundesliga",
          "la liga","serie a","mls","ufc","pga","tennis","golf","nascar",
          "baseball","football","basketball","hockey","soccer"];
        if (nonE.some(x=>lname.toLowerCase().includes(x))) knownNonEsportLeagueIds.add(item.id);
      }
    }
    if ((item.type==="new_player"||item.type==="player")&&item.relationships?.league?.data?.id) {
      playerLeague[item.id] = item.relationships.league.data.id;
    }
  }
  return {leagueSport,leagueName,leagueDisplay,playerLeague};
}
function isEsport(proj, maps) {
  let lid = proj.relationships?.league?.data?.id;
  if (!lid) {
    const pid = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
    if (pid) lid = maps.playerLeague[pid];
  }
  if (lid) {
    if (knownEsportLeagueIds.has(lid))    return true;
    if (knownNonEsportLeagueIds.has(lid)) return false;
    const sport = maps.leagueSport[lid]||"";
    if (isEsportSport(sport))  { knownEsportLeagueIds.add(lid); return true; }
    const lname = maps.leagueName[lid]||maps.leagueDisplay[lid]||"";
    if (isEsportLeagueName(lname)) { knownEsportLeagueIds.add(lid); return true; }
  }
  const projSport = (proj.attributes?.sport||"").trim();
  if (isEsportSport(projSport)||isEsportLeagueName(projSport)) return true;
  return false;
}

// ─── DATA SLIMMING ────────────────────────────────────────────────────────────
function slimProjection(p) {
  return {
    id: p.id, type: p.type,
    attributes: {
      line_score:   p.attributes?.line_score,
      stat_type:    p.attributes?.stat_type,
      description:  p.attributes?.description,
      status:       p.attributes?.status,
      board_time:   p.attributes?.board_time,
      is_promo:     p.attributes?.is_promo,
      goblin_line:  p.attributes?.goblin_line,
      demon_line:   p.attributes?.demon_line,
    },
    relationships: p.relationships,
  };
}
function slimIncluded(item) {
  if (item.type==="new_player"||item.type==="player") return {
    id:item.id, type:item.type,
    attributes:{
      name:item.attributes?.name, display_name:item.attributes?.display_name,
      team:item.attributes?.team, position:item.attributes?.position,
      image_url:item.attributes?.image_url,
    },
    relationships:item.relationships,
  };
  if (item.type==="league") return {
    id:item.id, type:item.type,
    attributes:{
      name:item.attributes?.name, display_name:item.attributes?.display_name,
      sport:item.attributes?.sport,
    },
  };
  if (item.type==="game") return {
    id:item.id, type:item.type,
    attributes:{
      start_time:item.attributes?.start_time, description:item.attributes?.description,
      away_team_id:item.attributes?.away_team_id, home_team_id:item.attributes?.home_team_id,
      status:item.attributes?.status,
    },
  };
  return item;
}

// ─── EXTRACT PLAYER LIST FROM PP DATA ─────────────────────────────────────────
// Builds { player, sport, team, opponent } list from raw PP data for stats scraper
function extractPlayersForStats(slimData, includedArr) {
  const playerMap = {}, leagueMap = {}, gameMap = {};
  for (const i of (includedArr||[])) {
    if (i.type==="new_player"||i.type==="player") playerMap[i.id] = i;
    if (i.type==="league")  leagueMap[i.id] = i;
    if (i.type==="game")    gameMap[i.id]   = i;
  }
  // Build game→teams mapping
  const gameTeams = {};
  for (const p of slimData) {
    const gid = p.relationships?.game?.data?.id;
    const pid = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
    const player = playerMap[pid];
    if (!gid || !player) continue;
    const team = player.attributes?.team || "?";
    if (!gameTeams[gid]) gameTeams[gid] = new Set();
    gameTeams[gid].add(team);
  }

  const seen = new Set();
  const players = [];
  for (const p of slimData) {
    const pid  = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
    const lid  = p.relationships?.league?.data?.id;
    const gid  = p.relationships?.game?.data?.id;
    const player = playerMap[pid];
    if (!player) continue;
    const pname = player.attributes?.display_name || player.attributes?.name || "";
    if (!pname) continue;

    const league = leagueMap[lid];
    const sportAttr = (league?.attributes?.sport || "").toUpperCase().trim();
    const sport = SPORT_CODE_MAP[sportAttr] || detectSportFromLeagueName(league?.attributes?.name||"");
    if (!sport) continue;

    const key = `${pname}::${sport}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const team = player.attributes?.team || "?";
    const teams = gid ? [...(gameTeams[gid]||[])] : [];
    const opponent = teams.find(t => t !== team) || "?";

    players.push({ player: pname, sport, team, opponent });
  }
  return players;
}

const SPORT_CODE_MAP = {
  "VAL":"Valorant","VALORANT":"Valorant",
  "LOL":"LoL","LEAGUE OF LEGENDS":"LoL",
  "CS2":"CS2","CSGO":"CS2","CS":"CS2","COUNTER-STRIKE":"CS2","COUNTER STRIKE":"CS2",
  "DOTA":"Dota2","DOTA2":"Dota2","DOTA 2":"Dota2",
  "R6":"R6","RAINBOW SIX":"R6","RAINBOW SIX SIEGE":"R6",
  "COD":"COD","CALL OF DUTY":"COD","CALLOFDUTY":"COD",
  "APEX":"APEX","APEX LEGENDS":"APEX",
  "RL":"RL","ROCKET LEAGUE":"RL",
};

function detectSportFromLeagueName(name) {
  const l = name.toLowerCase();
  if (l.includes("valorant")||l.includes("vct")) return "Valorant";
  if (l.includes("league of legends")||l.includes("lck")||l.includes("lcs")||l.includes("lpl")||l.includes("lec")) return "LoL";
  if (l.includes("counter-strike")||l.includes("cs2")||l.includes("csgo")) return "CS2";
  if (l.includes("dota")) return "Dota2";
  if (l.includes("rainbow six")||l.includes(" r6")) return "R6";
  if (l.includes("call of duty")||l.includes("cdl")) return "COD";
  if (l.includes("apex")) return "APEX";
  return null;
}

// ─── SEND TO RELAY ────────────────────────────────────────────────────────────
async function postRelay(backendUrl, payload) {
  try {
    const r = await fetch(`${backendUrl}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

// ─── STORE PIPELINE (shared by STORE_DIRECT_FETCH + FETCH_AND_RELAY) ──────────
// 1. Filter to esports only (unless trustedSource=true)
// 2. Slim data
// 3. Scrape stats for all players (team-based, cached 20h)
// 4. Bundle stats into payload
// 5. Store in chrome.storage
// 6. If backendUrl provided, POST to relay
async function processFetchedData(incoming, opts = {}) {
  const { trustedSource = false, backendUrl = null, onProgress = null } = opts;

  const maps = buildLookups(incoming.included);

  const filteredData = trustedSource
    ? (incoming.data || [])
    : (incoming.data || []).filter(p => isEsport(p, maps));

  console.log(`[KM BG] Props: ${(incoming.data||[]).length} received → ${filteredData.length} esports`);
  if (!filteredData.length) return { count: 0, ok: true };

  const slimData = filteredData.map(slimProjection);

  const neededPlayerIds = new Set();
  const neededLeagueIds = new Set();
  const neededGameIds   = new Set();
  slimData.forEach(p => {
    const pid = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
    const lid = p.relationships?.league?.data?.id;
    const gid = p.relationships?.game?.data?.id;
    if (pid) neededPlayerIds.add(pid);
    if (lid) neededLeagueIds.add(lid);
    if (gid) neededGameIds.add(gid);
  });
  const relevantIncluded = (incoming.included||[]).filter(i => {
    if (i.type==="new_player"||i.type==="player") return neededPlayerIds.has(i.id);
    if (i.type==="league") return neededLeagueIds.has(i.id);
    if (i.type==="game")   return neededGameIds.has(i.id);
    return false;
  }).map(slimIncluded);

  // ── STATS SCRAPING ───────────────────────────────────────────────────────────
  // Extract player list → scrape team pages → bundle into relay payload
  // Stats keyed by "PlayerName::Sport" → formatted note string for AI
  let statsMap = {};
  try {
    const playerList = extractPlayersForStats(slimData, relevantIncluded);
    const sportCounts = {};
    for (const p of playerList) sportCounts[p.sport] = (sportCounts[p.sport]||0)+1;
    console.log("[KM BG] Players to stat:", Object.entries(sportCounts).map(([s,n])=>`${s}:${n}`).join(", "));
    if (onProgress) onProgress(`Scraping stats for ${playerList.length} players…`);
    statsMap = await scrapeStatsForBoard(playerList, (msg) => {
      console.log("[KM Stats]", msg);
      if (onProgress) onProgress(msg);
    });
    const statCount = Object.keys(statsMap).length;
    console.log(`[KM BG] Stats scraped: ${statCount}/${playerList.length} players`);
    if (onProgress) onProgress(`Stats: ${statCount} players scraped`);
  } catch(e) {
    console.warn("[KM BG] Stats scrape error:", e.message);
  }

  const toStore = { data: slimData, included: relevantIncluded, stats: statsMap };
  const count = slimData.length;

  // Store in chrome.storage
  await new Promise(r => chrome.storage.local.set(
    { projections: toStore, timestamp: new Date().toISOString(), count, esportsCount: count },
    r
  ));
  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });

  // POST to relay if URL provided
  if (backendUrl) {
    const relayOk = await postRelay(backendUrl, toStore);
    console.log(`[KM BG] Relay POST: ${relayOk ? "ok" : "failed"}`);
  }

  return { count, ok: true, statsCount: Object.keys(statsMap).length };
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Auto-capture from content script
  if (message.type === "PRIZEPICKS_DATA") {
    (async () => {
      const result = await processFetchedData(message.projections, { trustedSource: false });
      sendResponse({ ok: result.ok, count: result.count, esportsCount: result.count });
    })();
    return true;
  }

  // Manual fetch from popup FETCH ALL DIRECT button
  if (message.type === "STORE_DIRECT_FETCH") {
    (async () => {
      const result = await processFetchedData(message.projections, {
        trustedSource: message.trusted_source === true,
      });
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: result.ok, count: result.count, esportsCount: result.count });
      }
    })();
    return true;
  }

  // Triggered by web app — full fetch + stats + relay in one step
  if (message.type === "FETCH_AND_RELAY") {
    const backendUrl = (message.backendUrl||"https://esports-kill-model.onrender.com").replace(/\/$/,"");
    sendResponse({ ok: true, status: "started" });
    (async () => {
      try {
        const ESPORT_SPORTS = new Set([
          "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
          "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
          "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
          "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
        ]);
        function isEsportLeague(l) {
          if (ESPORT_SPORTS.has((l.attributes?.sport||"").toUpperCase().trim())) return true;
          const name = (l.attributes?.name||l.attributes?.display_name||"").toLowerCase();
          return ESPORT_LEAGUE_KEYWORDS.some(kw => name.includes(kw));
        }

        // Hardcoded known PP esport league IDs (primary path — always works)
        const KNOWN_IDS = ["197","230","232","233","234","235","236","237","238","239",
          "240","241","242","243","244","245","246","247","248","249","250",
          "251","252","253","254","255","256","257","258","259","260"];
        let leagueIds = [...KNOWN_IDS];

        // Try /leagues to pick up any new IDs
        try {
          const lr = await fetch("https://api.prizepicks.com/leagues",{headers:{"Accept":"application/json"}});
          if (lr.ok) {
            const lj = await lr.json();
            const leagues = Array.isArray(lj) ? lj : (lj?.data||[]);
            const newIds = leagues.filter(isEsportLeague).map(l=>String(l.id))
              .filter(id => id && !leagueIds.includes(id));
            if (newIds.length) leagueIds = [...leagueIds, ...newIds];
          }
        } catch {}

        // Fetch each league
        const allData=[], allIncluded=[];
        const seenIds=new Set(), seenIncIds=new Set();
        function mergeResp(json) {
          (json?.data||[]).forEach(p=>{ if(!seenIds.has(p.id)){seenIds.add(p.id);allData.push(p);} });
          (json?.included||[]).forEach(i=>{ const k=i.type+":"+i.id; if(!seenIncIds.has(k)){seenIncIds.add(k);allIncluded.push(i);} });
        }
        for (let i=0; i<leagueIds.length; i++) {
          try {
            const r = await fetch(
              `https://api.prizepicks.com/projections?league_id=${leagueIds[i]}&per_page=250&single_stat=true`,
              {headers:{"Accept":"application/json"}}
            );
            if (r.ok) { const j=await r.json(); mergeResp(j); }
            else if (r.status===429) { await new Promise(r=>setTimeout(r,3000)); i--; continue; }
          } catch {}
          await new Promise(r=>setTimeout(r,300));
        }
        // Broad sweep
        try {
          const r=await fetch("https://api.prizepicks.com/projections?per_page=500&single_stat=true",{headers:{"Accept":"application/json"}});
          if(r.ok){const j=await r.json();mergeResp(j);}
        } catch {}

        if (!allData.length) {
          notifyAppTabs(backendUrl,{type:"FETCH_AND_RELAY_DONE",ok:false,error:"No props found"});
          return;
        }

        // Process: filter + slim + scrape stats + store + relay
        const result = await processFetchedData(
          { data: allData, included: allIncluded },
          { trustedSource: true, backendUrl }
        );

        notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:true, count:result.count, statsCount:result.statsCount });
        console.log(`[KM BG] FETCH_AND_RELAY done: ${result.count} props, ${result.statsCount||0} stats`);
      } catch(err) {
        console.error("[KM BG] FETCH_AND_RELAY error:", err);
        notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:false, error:err.message });
      }
    })();
    return true;
  }

  if (message.type === "AUTO_CAPTURE_DONE") {
    chrome.action.setBadgeText({ text: String(message.total) });
    chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });
    return true;
  }

  if (message.type === "GET_LATEST") {
    chrome.storage.local.get(["projections","timestamp","count","esportsCount"], d => sendResponse(d));
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

// External messages from web app (requires externally_connectable in manifest)
chrome.runtime.onExternalMessage?.addListener?.((message, sender, sendResponse) => {
  if (message.type === "FETCH_AND_RELAY") {
    chrome.runtime.onMessage.dispatch(message, sender, sendResponse);
    return true;
  }
});

function notifyAppTabs(backendUrl, payload) {
  chrome.tabs.query({}, tabs => {
    const appHosts = ["vercel.app","localhost","onrender.com","127.0.0.1"];
    tabs.forEach(tab => {
      if (tab.url && appHosts.some(h => tab.url.includes(h))) {
        chrome.tabs.sendMessage(tab.id, payload).catch(()=>{});
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
