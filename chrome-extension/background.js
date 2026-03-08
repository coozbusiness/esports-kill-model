// ─── ESPORTS STATS SCRAPER (inlined from stats-scraper.js) ─────────────────────
const STATS_TTL  = 20 * 60 * 60 * 1000; // 20h — fresh before 9pm nightly window
const SLUG_TTL   = 7  * 24 * 60 * 60 * 1000; // 7d slug mappings
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────
function csGet(key) {
  return new Promise(r => chrome.storage.local.get([key], d => r(d[key] ?? null)));
}
function csSet(key, val) {
  return new Promise(r => chrome.storage.local.set({ [key]: val }, r));
}
function csGetMany(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
function isFresh(e, ttl = STATS_TTL) {
  return e && e.ts && (Date.now() - e.ts < ttl);
}

// ─── FETCH HELPERS ───────────────────────────────────────────────────────────
async function xFetch(url, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      }
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function xFetchJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function s(str) { return (str || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function avg(a) { return a.length ? Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10 : null; }
function pf(v)  { const n = parseFloat((v||'').toString().replace(/[^0-9.-]/g,'')); return isNaN(n)?null:n; }
function pi(v)  { const n = parseInt((v||'').toString()); return isNaN(n)?null:n; }

function cellText(html) {
  return html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function parseRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = tdRe.exec(m[1])) !== null) cells.push(cellText(cm[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// ─── MAIN ENTRY ──────────────────────────────────────────────────────────────
// Called by background.js after PP fetch.
// props = [{ player, sport, team, opponent }]
// Returns formatted stats map: { "playername::Sport": "HLTV | 22.4k/map | Rtg1.21 ..." }
async function scrapeStatsForBoard(props, onProgress) {
  const raw = {};   // raw stat objects keyed by "player::Sport"
  const stale = []; // props needing fresh scrape

  // 1. Deduplicate and check cache
  const seen = new Set();
  const unique = props.filter(p => {
    const k = `${s(p.player)}::${p.sport}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const cacheKeys = unique.map(p => `st::${s(p.player)}::${p.sport}`);
  const cached = await csGetMany(cacheKeys);
  let hits = 0;
  for (const p of unique) {
    const ck = `st::${s(p.player)}::${p.sport}`;
    const e  = cached[ck];
    if (isFresh(e)) { raw[`${p.player}::${p.sport}`] = e; hits++; }
    else stale.push(p);
  }
  if (onProgress) onProgress(`Cache: ${hits} fresh, ${stale.length} to scrape`);
  if (!stale.length) return formatAll(raw);

  // 2. Group stale by team+sport — one team page = all 5 players
  const teamMap = {};
  const solos   = [];
  for (const p of stale) {
    if (p.team && p.team !== '?') {
      const k = `${s(p.team)}::${p.sport}`;
      if (!teamMap[k]) teamMap[k] = { team: p.team, sport: p.sport, players: [] };
      teamMap[k].players.push(p);
    } else {
      solos.push(p);
    }
  }

  const teams = Object.values(teamMap);
  let done = 0;

  // 3. Scrape team pages
  for (const tg of teams) {
    if (onProgress) onProgress(`${tg.sport} ${tg.team} (${done+1}/${teams.length})`);
    try {
      const teamStats = await scrapeTeam(tg.team, tg.sport);
      if (teamStats) {
        for (const [pName, stats] of Object.entries(teamStats)) {
          const entry = { ...stats, ts: Date.now() };
          await csSet(`st::${s(pName)}::${tg.sport}`, entry);
          // Match against our props — fuzzy name match
          for (const p of tg.players) {
            if (s(p.player) === s(pName) ||
                s(pName).includes(s(p.player).slice(0,4)) ||
                s(p.player).includes(s(pName).slice(0,4))) {
              raw[`${p.player}::${p.sport}`] = entry;
            }
          }
        }
      }
    } catch(e) {
      console.warn(`[KM Stats] Team fail ${tg.team}/${tg.sport}:`, e.message);
    }
    done++;
    if (done < teams.length) await delay(350);
  }

  // 4. Solo players (unknown team) — individual scrape CS2/VAL only
  for (const p of solos) {
    try {
      let stats = null;
      if (p.sport === 'CS2') stats = await scrapeHltvPlayer(p.player);
      else if (p.sport === 'Valorant') stats = await scrapeVlrAllStats(p.player);
      if (stats) {
        const entry = { ...stats, ts: Date.now() };
        await csSet(`st::${s(p.player)}::${p.sport}`, entry);
        raw[`${p.player}::${p.sport}`] = entry;
      }
    } catch {}
    await delay(350);
  }

  return formatAll(raw);
}

function scrapeTeam(teamName, sport) {
  switch (sport) {
    case 'CS2':      return scrapeHltvTeam(teamName);
    case 'Valorant': return scrapeVlrTeam(teamName);
    case 'LoL':      return scrapeGolggTeam(teamName);
    case 'COD':      return scrapeBreakingPointTeam(teamName);
    case 'R6':       return scrapeSiegeGGTeam(teamName);
    case 'Dota2':    return scrapeOpenDotaTeam(teamName);
    default:         return Promise.resolve(null);
  }
}

// ─── FORMAT OUTPUT ────────────────────────────────────────────────────────────
// Output format matches what server.js formatNotes() produces so AI prompt
// receives identical-quality stats whether scraped by extension or server.
function fmtStats(stats) {
  if (!stats) return null;
  const p = [];
  const src = stats.source || '?';
  p.push(src);
  if (stats.kills_per_map  != null) p.push(`${stats.kills_per_map}k/map`);
  if (stats.kills_per_game != null && stats.kills_per_map == null) p.push(`${stats.kills_per_game}k/g`);
  if (stats.rating         != null) p.push(`Rtg${stats.rating}`);
  if (stats.acs            != null) p.push(`ACS${stats.acs}`);
  if (stats.adr            != null) p.push(`ADR${stats.adr}`);
  if (stats.hs_pct         != null) p.push(`HS%${stats.hs_pct}`);
  if (stats.kast           != null) p.push(`KAST${stats.kast}`);
  if (stats.kda            != null) p.push(`KDA${stats.kda}`);
  if (stats.assists_per_game != null) p.push(`${stats.assists_per_game}a/g`);
  if (stats.deaths_per_game  != null) p.push(`${stats.deaths_per_game}d/g`);
  if (stats.role           != null) p.push(`Role:${stats.role}`);
  if (stats.last10?.length)          p.push(`L10:[${stats.last10.join(',')}]avg${avg(stats.last10)}`);
  return p.join(' | ');
}

function formatAll(raw) {
  const out = {};
  for (const [key, stats] of Object.entries(raw)) {
    const f = fmtStats(stats);
    if (f) out[key] = f;
  }
  return out;
}

// Route stats through backend server for sports where extension can't scrape directly
// (VAL, LoL, COD, R6 — sites block service workers)
async function fetchStatsFromServer(playerList, backendUrl) {
  if (!backendUrl || !playerList.length) return {};
  try {
    const url = backendUrl.replace(/\/$/, '') + '/stats/batch';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(playerList),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const out = {};
    for (const [key, d] of Object.entries(data)) {
      if (d?.notes && !d.error) out[key] = d.notes;
    }
    console.log('[KM BG] Server stats:', Object.keys(out).length + '/' + playerList.length + ' players');
    return out;
  } catch(e) {
    console.warn('[KM BG] Server stats batch failed:', e.message);
    return {};
  }
}

// ─── HLTV — CS2 ──────────────────────────────────────────────────────────────
// HLTV blocks server IPs (Cloudflare) but allows extension fetches.
// Returns all roster members with Rating2.0, KPR→kills/map, ADR, KAST, HS%

const HLTV_TEAMS = {
  'navi':            '4608/natus-vincere',
  'natusv':          '4608/natus-vincere',
  'natusvincere':    '4608/natus-vincere',
  'g2':              '5995/g2-esports',
  'g2esports':       '5995/g2-esports',
  'faze':            '6667/faze',
  'fazeclan':        '6667/faze',
  'vitality':        '9565/vitality',
  'teamvitality':    '9565/vitality',
  'liquid':          '5973/liquid',
  'teamliquid':      '5973/liquid',
  'cloud9':          '6665/cloud9',
  'c9':              '6665/cloud9',
  'heroic':          '9961/heroic',
  'astralis':        '6665/astralis',
  'nip':             '4869/nip',
  'ninjasinpyjamas': '4869/nip',
  'mouz':            '4494/mousesports',
  'mousesports':     '4494/mousesports',
  'spirit':          '7020/spirit',
  'teamspirit':      '7020/spirit',
  'ence':            '9928/ence',
  'big':             '9943/big',
  'complexity':      '7399/complexity',
  'col':             '7399/complexity',
  'imperial':        '9455/imperial',
  'eternalf':        '12320/eternal-fire',
  'eternalfire':     '12320/eternal-fire',
  '3dmax':           '12524/3dmax',
  'virtuspro':       '5378/virtuspro',
  'vp':              '5378/virtuspro',
  'fnatic':          '4991/fnatic',
  'movistar':        '10503/movistar-riders',
  'apeks':           '12325/apeks',
  'aurora':          '12341/aurora',
  'betboom':         '12481/betboom',
  'furia':           '8158/furia',
  'natus':           '4608/natus-vincere',
  'monaspa':         '12490/mon4spa',
  'ecstatic':        '12516/ecstatic',
  'bestia':          '12515/bestia',
  'shanghaidragons': '9942/shanghai-dragons',
};

function getHltvSlug(teamName) {
  const key = s(teamName);
  if (HLTV_TEAMS[key]) return HLTV_TEAMS[key];
  // Partial match on hardcoded map (longest key match wins)
  let best = null, bestLen = 0;
  for (const [k, slug] of Object.entries(HLTV_TEAMS)) {
    if ((key.includes(k.slice(0,6)) || k.includes(key.slice(0,6))) && k.length > bestLen) {
      best = slug; bestLen = k.length;
    }
  }
  return best; // null if no match — caller handles gracefully
}

async function scrapeHltvTeam(teamName) {
  // HLTV blocks extension service workers (403/Cloudflare) — stats via server
  return null;
}

async function scrapeHltvPlayer(playerName) {
  return null;
}

function getVlrTeamId(teamName) {
  const key = s(teamName);
  if (VLR_TEAMS[key]) return VLR_TEAMS[key];
  let best = null, bestLen = 0;
  for (const [k, id] of Object.entries(VLR_TEAMS)) {
    if ((key.includes(k.slice(0,5)) || k.includes(key.slice(0,5))) && k.length > bestLen) {
      best = id; bestLen = k.length;
    }
  }
  return best;
}

async function scrapeVlrTeam(teamName) {
  // Extension cannot scrape vlr.gg directly — route through backend /stats
  // The backend has the full PandaScore VAL scraper
  return null; // handled by routeStatsViaServer below
}

function parseVlrStatsHtml(html, playerFilter) { return {}; }

async function scrapeVlrAllStats(playerName) { 
  return null; // handled by routeStatsViaServer below
}

const GOLGG_TEAMS = {
  't1':             'T1',
  'geng':           'Gen.G',          'gen.g':    'Gen.G',
  'kt':             'KT',             'ktrolster':'KT',
  'cloud9':         'Cloud9',         'c9':       'Cloud9',
  'liquid':         'Team-Liquid',    'teamliquid':'Team-Liquid',
  'tsm':            'TSM',
  'g2':             'G2-Esports',     'g2esports':'G2-Esports',
  'fnatic':         'Fnatic',
  '100t':           '100-Thieves',    '100thieves':'100-Thieves',
  'eg':             'Evil-Geniuses',  'evilgeniuses':'Evil-Geniuses',
  'blg':            'BLG',            'bilibil':  'BLG',
  'wbg':            'Weibo-Gaming',   'weibogaming':'Weibo-Gaming',
  'jdg':            'JDG',
  'nrg':            'NRG',
  'flyquest':       'FlyQuest',
  'dig':            'Dignitas',
  'gg':             'Golden-Guardians',
  'loud':           'LOUD',
  'pain':           'paiN',
  'flamengo':       'Flamengo',
  'fluxo':          'Fluxo',
  'leviatan':       'Leviatán',
  'estrelasmortes': 'Estrelashttps',
};

async function scrapeGolggTeam(teamName) {
  // gol.gg blocks extension service workers — stats via server
  return null;
}

async function scrapeBreakingPointTeam(teamName) { return null; }

async function scrapeSiegeGGTeam(teamName) { return null; }

const DOTA_TEAMS = {
  'spirit':        '8255888', 'teamspirit':    '8255888',
  'liquid':        '2163',    'teamliquid':    '2163',
  'gaiminglad':    '8607865', 'gaiminggladiators':'8607865',
  'talon':         '8376426', 'talonesports':  '8376426',
  'tundra':        '8291895',
  'nouns':         '8941494', 'nounsesports':  '8941494',
  'beastcoast':    '7391077',
  'nigsma':        '15',      'nigma':         '15',
  'og':            '2586976',
  'lgd':           '15',
  'virtuspro':     '5378',    'vp':            '5378',
};

async function scrapeOpenDotaTeam(teamName) {
  const key    = s(teamName);
  let teamId   = DOTA_TEAMS[key];
  if (!teamId) {
    for (const [k,v] of Object.entries(DOTA_TEAMS)) {
      if (key.includes(k.slice(0,5)) || k.includes(key.slice(0,5))) { teamId=v; break; }
    }
  }
  if (!teamId) {
    try {
      const data = await xFetchJSON(`https://api.opendota.com/api/search/team?q=${encodeURIComponent(teamName)}`);
      if (data?.[0]?.team_id) teamId = String(data[0].team_id);
    } catch {}
  }
  if (!teamId) return null;

  try {
    const players = await xFetchJSON(`https://api.opendota.com/api/teams/${teamId}/players`);
    if (!Array.isArray(players)) return null;
    const result = {};
    for (const p of players.filter(p => p.is_current_team_member).slice(0,7)) {
      try {
        const matches = await xFetchJSON(
          `https://api.opendota.com/api/players/${p.account_id}/matches?significant=0&limit=20`
        );
        const kills = (matches||[]).filter(m=>m.kills!=null).map(m=>m.kills).slice(0,10);
        if (!kills.length) continue;
        result[p.name] = {
          source: 'OpenDota', player: p.name,
          kills_per_game: avg(kills),
          kills_per_map: avg(kills), // Dota series = map totals
          last10: kills, games: kills.length,
        };
        await delay(200); // OpenDota rate limit
      } catch {}
    }
    const count = Object.keys(result).length;
    if (count) console.log(`[KM OpenDota] ${teamName}: ${count} players`);
    return count ? result : null;
  } catch { return null; }
}

// ─── UTIL (delay moved to top) ───────────────────────────────────────────────

// ─── BACKGROUND SERVICE WORKER ──────────────────────────────────────────────────
// ─── ESPORT IDENTIFICATION ────────────────────────────────────────────────────
const ESPORT_LEAGUE_KEYWORDS = [
  // Full names
  "league of legends","valorant","vct","counter-strike","cs2","csgo",
  "dota","call of duty","cdl","apex legends","algs","rainbow six","r6","siege",
  "rocket league","rlcs","overwatch","starcraft","halo","esport","e-sport",
  "lck","lpl","lec","lcs","lta","lcp","cblol","pcs","vcs","ljl",
  "esl pro","blast","iem ","pgl ","dreamleague","esl one",
  // PP short-code league names (CONFIRMED from live API 2026-03-08)
  "lol","cod","val","dota2","apex","rl",
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
  const l = name.toLowerCase().trim();
  // Exact match for PP short codes (e.g. "cod", "val", "lol") 
  // OR substring match for longer names
  return ESPORT_LEAGUE_KEYWORDS.some(kw => l === kw || l.includes(kw));
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
      line_score:        p.attributes?.line_score,
      stat_type:         p.attributes?.stat_type,
      stat_display_name: p.attributes?.stat_display_name,
      description:       p.attributes?.description,
      status:            p.attributes?.status,
      board_time:        p.attributes?.board_time,
      start_time:        p.attributes?.start_time,
      is_promo:          p.attributes?.is_promo,
      goblin_line:       p.attributes?.goblin_line,
      demon_line:        p.attributes?.demon_line,
      odds_type:         p.attributes?.odds_type,
      sport:             p.attributes?.sport,        // CRITICAL: sport code for detectSport()
      trending_count:    p.attributes?.trending_count,
      adjusted_odds:     p.attributes?.adjusted_odds,
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

// ─── DEFAULT BACKEND URL — used when no backendUrl is passed in opts ──────────
// This ensures PRIZEPICKS_DATA and STORE_DIRECT_FETCH auto-route stats through server.
const DEFAULT_BACKEND_URL = "https://esports-kill-model.onrender.com";

// ─── CORE PROCESS PIPELINE ───────────────────────────────────────────────────
// 1. Filter to esports (unless trustedSource)
// 2. Slim data
// 3. Store filtered props immediately (fast — user sees count right away)
// 4. Scrape stats async in background (doesn't block sendResponse)
// 5. Re-store with stats, POST to relay if backendUrl provided
async function processFetchedData(incoming, opts = {}) {
  const { trustedSource = false, backendUrl = DEFAULT_BACKEND_URL } = opts;

  const maps = buildLookups(incoming.included);
  const filteredData = trustedSource
    ? (incoming.data || [])
    : (incoming.data || []).filter(p => isEsport(p, maps));

  console.log(`[KM BG] Props: ${(incoming.data||[]).length} in → ${filteredData.length} esports`);
  if (filteredData.length > 0) {
    const sports = [...new Set(filteredData.map(p => p.attributes?.sport || '?'))];
    console.log(`[KM BG] Sports on projections: ${sports.join(', ')}`);
    const sample = filteredData[0];
    console.log(`[KM BG] Sample prop sport field: "${sample.attributes?.sport}" | league rel: ${sample.relationships?.league?.data?.id || 'NONE'}`);
  }
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
    if (i.type==="league") return true; // always include ALL leagues - needed for sport detection even when prop has no direct league relationship
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
      
      // Separate players by whether extension can scrape them (CS2/Dota2) vs needs server
      const serverSports = new Set(['Valorant', 'LoL', 'COD', 'R6', 'APEX', 'CS2']);
      const serverPlayers = playerList.filter(p => serverSports.has(p.sport));
      const extensionPlayers = playerList.filter(p => !serverSports.has(p.sport));
      
      // Extension-scraped (OpenDota for Dota2 — actually works from extension)
      const dotaPlayers = playerList.filter(p => p.sport === 'Dota2');
      if (dotaPlayers.length) {
        const dotaStats = await scrapeStatsForBoard(dotaPlayers, msg => console.log("[KM Stats]", msg));
        Object.assign(statsMap, dotaStats);
      }
      
      // Server-routed for everything else (most reliable path)
      if (serverPlayers.length && backendUrl) {
        const serverPropList = serverPlayers.map(p => ({ player: p.player, sport: p.sport, team: p.team, opponent: p.opponent }));
        const serverStats = await fetchStatsFromServer(serverPropList, backendUrl);
        // serverStats keys are "player::sport" notes strings
        Object.assign(statsMap, serverStats);
      }
      
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
      // VERIFIED real esport league IDs from live PP API (2026-03-08)
      "121","145","159","161","174","265","267","268","274",
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

      // Broad sweep — merge ALL unfiltered props, let processFetchedData's isEsport() filter
      // DO NOT pre-filter here: VAL/COD props often have sport="VAL"/"COD" on the projection
      // itself with NO league relationship chain, so leagueLookup-based filters drop them.
      // isEsport() in processFetchedData checks proj.attributes.sport as final fallback.
      try {
        const r = await fetch("https://api.prizepicks.com/projections?per_page=500&single_stat=true", { headers: { "Accept": "application/json" } });
        if (r.ok) { merge(await r.json()); }
      } catch {}

      if (!allData.length) {
        notifyAppTabs(backendUrl, { type:"FETCH_AND_RELAY_DONE", ok:false, error:"No props found" });
        return;
      }

      const result = await processFetchedData(
        { data: allData, included: allIncluded },
        { trustedSource: false, backendUrl } // must be false: isEsport() catches VAL/COD via proj.attributes.sport
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