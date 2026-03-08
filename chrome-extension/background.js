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
let knownEsportLeagueIds    = new Set();
let knownNonEsportLeagueIds = new Set();

function isEsportLeagueName(name) {
  if (!name) return false;
  const l = name.toLowerCase();
  return ESPORT_LEAGUE_KEYWORDS.some(kw => l.includes(kw));
}
function isEsportSport(sport) {
  return sport ? ESPORT_SPORT_VALUES.has(sport.toUpperCase().trim()) : false;
}
function buildLookups(included) {
  const leagueSport={}, leagueName={}, leagueDisplay={}, playerLeague={};
  for (const item of (included||[])) {
    if (item.type==="league") {
      const sport = item.attributes?.sport || item.attributes?.category || "";
      if (sport) leagueSport[item.id] = sport.toUpperCase().trim();
      if (item.attributes?.name)         leagueName[item.id]    = item.attributes.name;
      if (item.attributes?.display_name) leagueDisplay[item.id] = item.attributes.display_name;
      const lname  = item.attributes?.name || item.attributes?.display_name || "";
      const lsport = sport.toUpperCase().trim();
      if (isEsportSport(lsport) || isEsportLeagueName(lname)) {
        knownEsportLeagueIds.add(item.id);
      } else if (lname) {
        const nonE = ["nba","nfl","mlb","nhl","ncaa","college","premier league",
          "bundesliga","la liga","serie a","mls","ufc","pga","tennis","golf",
          "nascar","baseball","football","basketball","hockey","soccer"];
        if (nonE.some(x => lname.toLowerCase().includes(x)))
          knownNonEsportLeagueIds.add(item.id);
      }
    }
    if ((item.type==="new_player"||item.type==="player") && item.relationships?.league?.data?.id) {
      playerLeague[item.id] = item.relationships.league.data.id;
    }
  }
  return { leagueSport, leagueName, leagueDisplay, playerLeague };
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
    const sport = maps.leagueSport[lid] || "";
    if (isEsportSport(sport)) { knownEsportLeagueIds.add(lid); return true; }
    const lname = maps.leagueName[lid] || maps.leagueDisplay[lid] || "";
    if (isEsportLeagueName(lname)) { knownEsportLeagueIds.add(lid); return true; }
  }
  const projSport = (proj.attributes?.sport||"").trim();
  if (isEsportSport(projSport) || isEsportLeagueName(projSport)) return true;
  return false;
}

// ─── DATA SLIMMING ────────────────────────────────────────────────────────────
function slimProjection(p) {
  return {
    id: p.id, type: p.type,
    attributes: {
      line_score:  p.attributes?.line_score,
      stat_type:   p.attributes?.stat_type,
      description: p.attributes?.description,
      status:      p.attributes?.status,
      board_time:  p.attributes?.board_time,
      is_promo:    p.attributes?.is_promo,
      goblin_line: p.attributes?.goblin_line,
      demon_line:  p.attributes?.demon_line,
    },
    relationships: p.relationships,
  };
}
function slimIncluded(item) {
  if (item.type==="new_player"||item.type==="player") return {
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
  if (item.type==="league") return {
    id: item.id, type: item.type,
    attributes: {
      name:         item.attributes?.name,
      display_name: item.attributes?.display_name,
      sport:        item.attributes?.sport,
    },
  };
  if (item.type==="game") return {
    id: item.id, type: item.type,
    attributes: {
      start_time:   item.attributes?.start_time,
      description:  item.attributes?.description,
      away_team_id: item.attributes?.away_team_id,
      home_team_id: item.attributes?.home_team_id,
      status:       item.attributes?.status,
    },
  };
  return item;
}

// ─── SPORT DETECTION FROM PP DATA ────────────────────────────────────────────
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
  const l = (name||"").toLowerCase();
  if (l.includes("valorant")||l.includes("vct"))                              return "Valorant";
  if (l.includes("league of legends")||l.includes("lck")||l.includes("lcs")||l.includes("lpl")||l.includes("lec")) return "LoL";
  if (l.includes("counter-strike")||l.includes("cs2")||l.includes("csgo")||l.includes("esl pro")) return "CS2";
  if (l.includes("dota"))                                                       return "Dota2";
  if (l.includes("rainbow six")||l.includes(" r6")||l.includes("siege"))       return "R6";
  if (l.includes("call of duty")||l.includes("cdl"))                           return "COD";
  if (l.includes("apex"))                                                       return "APEX";
  return null;
}

function extractPlayersForStats(slimData, includedArr) {
  const playerMap={}, leagueMap={}, gameMap={};
  for (const i of (includedArr||[])) {
    if (i.type==="new_player"||i.type==="player") playerMap[i.id] = i;
    if (i.type==="league") leagueMap[i.id] = i;
    if (i.type==="game")   gameMap[i.id]   = i;
  }
  // Map game → set of teams
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
  const seen = new Set(), players = [];
  for (const p of slimData) {
    const pid    = p.relationships?.new_player?.data?.id || p.relationships?.player?.data?.id;
    const lid    = p.relationships?.league?.data?.id;
    const gid    = p.relationships?.game?.data?.id;
    const player = playerMap[pid];
    if (!player) continue;
    const pname = player.attributes?.display_name || player.attributes?.name || "";
    if (!pname) continue;
    const league    = leagueMap[lid];
    const sportAttr = (league?.attributes?.sport||"").toUpperCase().trim();
    const sport     = SPORT_CODE_MAP[sportAttr] || detectSportFromLeagueName(league?.attributes?.name||"");
    if (!sport) continue;
    const key = `${pname}::${sport}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const team     = player.attributes?.team || "?";
    const teams    = gid ? [...(gameTeams[gid]||[])] : [];
    const opponent = teams.find(t => t !== team) || "?";
    players.push({ player: pname, sport, team, opponent });
  }
  return players;
}

// ─── RELAY ────────────────────────────────────────────────────────────────────
async function postRelay(backendUrl, payload) {
  try {
    const body = JSON.stringify(payload);
    const r = await fetch(`${backendUrl}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return r.ok;
  } catch(e) {
    console.warn("[KM BG] postRelay failed:", e.message);
    return false;
  }
}

// ─── SAFE STORAGE SET ─────────────────────────────────────────────────────────
function safeStorageSet(data) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          console.warn("[KM BG] Storage error:", chrome.runtime.lastError.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch(e) {
      console.warn("[KM BG] Storage set threw:", e.message);
      resolve(false);
    }
  });
}

// ─── CORE PROCESS PIPELINE ───────────────────────────────────────────────────
// 1. Filter to esports (unless trustedSource)
// 2. Slim data
// 3. Store filtered props immediately (fast — user sees count right away)
// 4. Scrape stats async in background (doesn't block sendResponse)
// 5. Re-store with stats, POST to relay if backendUrl provided
async function processFetchedData(incoming, opts = {}) {
  const { trustedSource = false, backendUrl = null } = opts;

  const maps = buildLookups(incoming.included);
  const filteredData = trustedSource
    ? (incoming.data || [])
    : (incoming.data || []).filter(p => isEsport(p, maps));

  console.log(`[KM BG] Props: ${(incoming.data||[]).length} in → ${filteredData.length} esports`);
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

  const count = slimData.length;

  // ── PHASE 1: Store props immediately (no stats yet) — fast path ───────────
  const toStorePhase1 = { data: slimData, included: relevantIncluded, stats: {} };
  await safeStorageSet({
    projections: toStorePhase1,
    timestamp: new Date().toISOString(),
    count,
    esportsCount: count,
  });
  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });

  // ── PHASE 2: Scrape stats in background — does NOT block sendResponse ─────
  // Runs after this function returns. Stats get written back to storage + relay.
  scrapeAndStore(slimData, relevantIncluded, backendUrl).catch(e => {
    console.warn("[KM BG] scrapeAndStore failed:", e.message);
  });

  return { count, ok: true };
}

async function scrapeAndStore(slimData, relevantIncluded, backendUrl) {
  let statsMap = {};
  try {
    const playerList = extractPlayersForStats(slimData, relevantIncluded);
    if (playerList.length === 0) {
      console.log("[KM BG] No players to scrape stats for");
    } else {
      const sportCounts = {};
      for (const p of playerList) sportCounts[p.sport] = (sportCounts[p.sport]||0)+1;
      console.log("[KM BG] Scraping stats for:", Object.entries(sportCounts).map(([s,n])=>`${s}×${n}`).join(", "));
      statsMap = await scrapeStatsForBoard(playerList, msg => console.log("[KM Stats]", msg));
      console.log(`[KM BG] Stats done: ${Object.keys(statsMap).length}/${playerList.length} players`);
    }
  } catch(e) {
    console.warn("[KM BG] Stats scraping error:", e.message);
  }

  // Re-store with stats included
  const toStoreFinal = { data: slimData, included: relevantIncluded, stats: statsMap };
  await safeStorageSet({ projections: toStoreFinal });

  // POST to relay so the app can pick up props + stats
  if (backendUrl) {
    const ok = await postRelay(backendUrl, toStoreFinal);
    console.log(`[KM BG] Relay POST: ${ok ? "ok" : "failed"}`);
  }
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Auto-capture from content script (PP page intercept)
  if (message.type === "PRIZEPICKS_DATA") {
    processFetchedData(message.projections, { trustedSource: false })
      .then(r => sendResponse({ ok: r.ok, count: r.count, esportsCount: r.count }))
      .catch(e => { console.error("[KM BG] PRIZEPICKS_DATA error:", e); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Manual fetch via popup FETCH ALL DIRECT button
  if (message.type === "STORE_DIRECT_FETCH") {
    processFetchedData(message.projections, { trustedSource: message.trusted_source === true })
      .then(r => {
        if (chrome.runtime.lastError) {
          console.warn("[KM BG] lastError after STORE_DIRECT_FETCH:", chrome.runtime.lastError.message);
        }
        sendResponse({ ok: r.ok, count: r.count, esportsCount: r.count });
      })
      .catch(e => { console.error("[KM BG] STORE_DIRECT_FETCH error:", e); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Triggered by web app — full fetch + stats + relay
  if (message.type === "FETCH_AND_RELAY") {
    const backendUrl = (message.backendUrl || "https://esports-kill-model.onrender.com").replace(/\/$/, "");
    sendResponse({ ok: true, status: "started" });

    const ESPORT_SPORTS_FAR = new Set([
      "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
      "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
      "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
      "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
    ]);
    function isEsportLeagueLocal(l) {
      if (ESPORT_SPORTS_FAR.has((l.attributes?.sport||"").toUpperCase().trim())) return true;
      const name = (l.attributes?.name||l.attributes?.display_name||"").toLowerCase();
      return ESPORT_LEAGUE_KEYWORDS.some(kw => name.includes(kw));
    }

    const KNOWN_IDS = [
      "197","230","232","233","234","235","236","237","238","239",
      "240","241","242","243","244","245","246","247","248","249","250",
      "251","252","253","254","255","256","257","258","259","260",
    ];

    const run = async () => {
      let leagueIds = [...KNOWN_IDS];
      try {
        const lr = await fetch("https://api.prizepicks.com/leagues", { headers: { "Accept": "application/json" } });
        if (lr.ok) {
          const lj = await lr.json();
          const leagues = Array.isArray(lj) ? lj : (lj?.data||[]);
          const newIds = leagues.filter(isEsportLeagueLocal).map(l => String(l.id)).filter(id => id && !leagueIds.includes(id));
          if (newIds.length) leagueIds = [...leagueIds, ...newIds];
        }
      } catch {}

      const allData=[], allIncluded=[];
      const seenIds=new Set(), seenIncIds=new Set();
      const merge = json => {
        (json?.data||[]).forEach(p => { if(!seenIds.has(p.id)){seenIds.add(p.id);allData.push(p);} });
        (json?.included||[]).forEach(i => { const k=i.type+":"+i.id; if(!seenIncIds.has(k)){seenIncIds.add(k);allIncluded.push(i);} });
      };

      for (let i=0; i<leagueIds.length; i++) {
        try {
          const r = await fetch(
            `https://api.prizepicks.com/projections?league_id=${leagueIds[i]}&per_page=250&single_stat=true`,
            { headers: { "Accept": "application/json" } }
          );
          if (r.ok) { merge(await r.json()); }
          else if (r.status===429) { await new Promise(r=>setTimeout(r,3000)); i--; continue; }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
      }

      // Broad sweep — filter to esports using league lookup before merging
      try {
        const r = await fetch("https://api.prizepicks.com/projections?per_page=500&single_stat=true", { headers: { "Accept": "application/json" } });
        if (r.ok) {
          const j = await r.json();
          // Build league lookup from broad sweep included to filter non-esports
          const sweepLeagues = {};
          (j.included||[]).forEach(i => { if(i.type==="league") sweepLeagues[i.id]=i; });
          const sweepPlayerLeague = {};
          (j.included||[]).forEach(i => {
            if((i.type==="new_player"||i.type==="player")&&i.relationships?.league?.data?.id)
              sweepPlayerLeague[i.id] = i.relationships.league.data.id;
          });
          const esportSweepData = (j.data||[]).filter(p => {
            let lid = p.relationships?.league?.data?.id;
            if(!lid){const pid=p.relationships?.new_player?.data?.id||p.relationships?.player?.data?.id; if(pid) lid=sweepPlayerLeague[pid];}
            if(!lid) return false;
            const league = sweepLeagues[lid];
            return league && isEsportLeagueLocal(league);
          });
          merge({ data: esportSweepData, included: j.included });
        }
      } catch {}

      if (!allData.length) {
        notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:false, error:"No props found" });
        return;
      }

      const result = await processFetchedData(
        { data: allData, included: allIncluded },
        { trustedSource: true, backendUrl }
      );
      notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:true, count:result.count });
    };

    run().catch(err => {
      console.error("[KM BG] FETCH_AND_RELAY error:", err);
      notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:false, error:err.message });
    });

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

// External messages from web app (externally_connectable)
if (chrome.runtime.onExternalMessage) {
  chrome.runtime.onExternalMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "FETCH_AND_RELAY") {
      // Re-dispatch through main handler
      const fakeEvent = new Event("message");
      chrome.runtime.onMessage.dispatch(message, sender, sendResponse);
      return true;
    }
  });
}

function notifyAppTabs(backendUrl, payload) {
  const appHosts = ["vercel.app","localhost","onrender.com","127.0.0.1"];
  chrome.tabs.query({}, tabs => {
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
