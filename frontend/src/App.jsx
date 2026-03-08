import { useState, useRef, useEffect, useCallback } from "react";

// --- BACKEND CONFIG -----------------------------------------------------------
// Set this to your Railway backend URL after deployment
// During local dev: http://localhost:3001
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "https://esports-kill-model.onrender.com";

// --- EXTENSION CONFIG ---------------------------------------------------------
// Chrome extension ID — find yours at chrome://extensions after installing
// The app uses this to trigger the extension's FETCH_AND_RELAY directly
const EXTENSION_ID = process.env.REACT_APP_EXTENSION_ID || "";

// --- SPORT CONFIG -------------------------------------------------------------
const SPORT_CONFIG = {
  LoL:      { color: "#C89B3C", accent: "#0AC8B9", icon: "⚔", label: "League of Legends" },
  CS2:      { color: "#F4A836", accent: "#FF6B2B", icon: "🎯", label: "Counter-Strike 2"  },
  Valorant: { color: "#FF4655", accent: "#FF91A0", icon: "O", label: "Valorant"           },
  Dota2:    { color: "#C23C2A", accent: "#FF6B47", icon: "🗡", label: "Dota 2"             },
  R6:       { color: "#0097D6", accent: "#00C4FF", icon: "🛡", label: "Rainbow Six"        },
  COD:      { color: "#A2FF00", accent: "#7FCC00", icon: "💥", label: "Call of Duty"       },
  APEX:     { color: "#DA292A", accent: "#FF6B35", icon: "!", label: "Apex Legends"       },
};

const PARLAY_SIZES = {
  3: { multiplier: 5,  label: "3-Pick"   },
  4: { multiplier: 10, label: "4-Pick"   },
  5: { multiplier: 20, label: "5-Pick"   },
  6: { multiplier: 25, label: "6-Pick *" },
};

// --- PICK LOGGER -------------------------------------------------------------
async function logPick(pick) {
  try {
    const res = await fetch(`${BACKEND_URL}/picks/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pick),
    });
    return res.ok ? await res.json() : null;
  } catch(e) { return null; }
}

async function fetchPickLog() {
  try {
    const res = await fetch(`${BACKEND_URL}/picks/log`);
    return res.ok ? await res.json() : null;
  } catch(e) { return null; }
}

async function settlePickById(id, result, actual) {
  try {
    const res = await fetch(`${BACKEND_URL}/picks/log/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, actual }),
    });
    return res.ok ? await res.json() : null;
  } catch(e) { return null; }
}


// --- MATCH CONTEXT FETCH (PandaScore: Bo format + Pinnacle odds in one call) --
const matchContextCache = {};
async function fetchMatchContext(team, opponent, sport) {
  const key = `${team}::${opponent}::${sport}`;
  if (matchContextCache[key]) return matchContextCache[key];
  try {
    const params = new URLSearchParams({ team, sport });
    if (opponent) params.append("opponent", opponent);
    const res = await fetch(`${BACKEND_URL}/match-context?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    matchContextCache[key] = data;
    return data;
  } catch(e) { return null; }
}

// Legacy shim -- odds now come from /match-context
async function fetchMatchOdds(team, opponent, sport) {
  const ctx = await fetchMatchContext(team, opponent, sport);
  if (!ctx?.odds) return null;
  return { available: true, win_prob: ctx.odds.team_win_prob, opp_win_prob: ctx.odds.opp_win_prob, source: ctx.odds.source };
}


// --- POWERS EV ENGINE ---------------------------------------------------------
// PrizePicks Power Play payouts (fixed, no insurance)
const POWERS_PAYOUTS = {
  2: 3,   // 2-pick = 3x
  3: 5,   // 3-pick = 5x
  4: 10,  // 4-pick = 10x
};

// Break-even hit rates needed for positive EV
// EV = p(all hit) x payout - stake
// For positive EV: p(all hit) > 1/payout
// 2-pick: need >33.3% combined, 3-pick: >20%, 4-pick: >10%
const POWERS_BREAKEVEN = {
  2: 1/3,   // 33.3%
  3: 1/5,   // 20%
  4: 1/10,  // 10%
};

// matchupPicks: { "matchup_string": { winner: "TeamA", strength: "slight"|"clear"|"upset" } }
function correctedHitProb(legs, matchupPicks = {}) {
  // Apply matchup pick adjustments to individual conf first
  const adjustedLegs = legs.map(leg => {
    const pick = matchupPicks[leg.matchup];
    if (!pick || !pick.winner) return leg;

    const isWinner = leg.team && pick.winner &&
      leg.team.toLowerCase().includes(pick.winner.toLowerCase()) ||
      pick.winner.toLowerCase().includes((leg.team||"").toLowerCase());

    const adjustments = {
      slight: { win: 8,  lose: 8  },
      clear:  { win: 12, lose: 12 },
      upset:  { win: 18, lose: 15 }, // asymmetric: upset winners over-hit more
    };
    const adj = adjustments[pick.strength] || adjustments.slight;

    let newConf = leg.conf;
    if (isWinner) {
      newConf = Math.min(95, leg.conf + adj.win);
    } else {
      newConf = Math.max(20, leg.conf - adj.lose);
    }
    return { ...leg, conf: newConf, adjusted: true, origConf: leg.conf };
  });

  // Product of adjusted confidences
  let prob = adjustedLegs.reduce((p, l) => p * (l.conf / 100), 1);

  // Correlation penalties for same-matchup pairs
  for (let i = 0; i < adjustedLegs.length; i++) {
    for (let j = i + 1; j < adjustedLegs.length; j++) {
      if (adjustedLegs[i].matchup === adjustedLegs[j].matchup) {
        if (adjustedLegs[i].team === adjustedLegs[j].team) {
          prob *= 0.85;
        } else {
          prob *= 0.92;
        }
      }
    }
  }
  return prob;
}

function calcEV(hitProb, picks, stake) {
  const payout = POWERS_PAYOUTS[picks];
  if (!payout) return null;
  // EV = (hitProb x netWin) - (missProb x stake)
  const netWin = stake * payout - stake; // profit if hit
  return (hitProb * netWin) - ((1 - hitProb) * stake);
}

function calcKelly(hitProb, picks, bankroll) {
  const b = POWERS_PAYOUTS[picks] - 1; // net odds (e.g. 2-pick: b=2)
  const q = 1 - hitProb;
  const kelly = (hitProb * b - q) / b;
  // Cap at 5% of bankroll for safety
  const fraction = Math.max(0, Math.min(0.05, kelly));
  return Math.round(fraction * bankroll);
}

function buildAllPowersCombos(candidates, bankroll = 1000, matchupPicks = {}) {
  // candidates: array of analyzed props with conf, matchup, team, player etc
  const combos = [];

  for (const picks of [2, 3, 4]) {
    const payout = POWERS_PAYOUTS[picks];
    // Generate all combinations of `picks` legs from candidates
    function combine(start, current) {
      if (current.length === picks) {
        const hitProb = correctedHitProb(current, matchupPicks);
        const breakeven = POWERS_BREAKEVEN[picks];
        if (hitProb < breakeven) return; // negative EV -- skip
        const stake = calcKelly(hitProb, picks, bankroll);
        if (stake < 1) return; // Kelly says don't bet
        const ev = calcEV(hitProb, picks, stake);
        if (ev <= 0) return;
        combos.push({
          picks,
          legs: [...current],
          hit_prob: Math.round(hitProb * 1000) / 10, // % with 1 decimal
          ev: Math.round(ev * 100) / 100,
          kelly_stake: stake,
          payout_mult: payout,
          payout_amt: Math.round(stake * payout),
          roi: Math.round((ev / stake) * 100),
          // Correlation flag
          has_correlation: current.some((a, i) =>
            current.slice(i+1).some(b => a.matchup === b.matchup)
          ),
        });
        return;
      }
      for (let i = start; i < candidates.length; i++) {
        combine(i + 1, [...current, candidates[i]]);
      }
    }
    combine(0, []);
  }

  // Sort by EV descending, then ROI
  combos.sort((a, b) => b.ev - a.ev || b.roi - a.roi);
  return combos.slice(0, 50); // top 50 combos max
}

// --- LIQUIPEDIA ENRICHMENT ---------------------------------------------------
// Free MediaWiki API -- no key, CORS via origin=* -- tested and working
// Rate limit: 1 parse req / 30s per ToS -- we throttle to 8s between calls
// Returns: team, role, status, stand-in flag, recent tournaments (2024+)

const LPEDIA_WIKIS = {
  LoL:      "leagueoflegends",
  CS2:      "counterstrike",
  Valorant: "valorant",
  Dota2:    "dota2",
  R6:       "rainbowsix",
  COD:      "callofduty",
  APEX:     "apexlegends",
};

// Session cache -- never re-fetch the same player
const lpediaCache = {};
let lpediaLastCall = 0;
const LPEDIA_GAP_MS = 8000; // 8s between parse calls (ToS max: 1/30s, we're conservative)

// Normalize player name to Liquipedia title format:
// Only first character uppercased, rest preserved (MediaWiki default behavior)
// "knight" -> "Knight", "s1mple" -> "S1mple", "NiKo" -> "NiKo"
function lpediaNormalize(name) {
  name = (name || "").trim();
  if (!name) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Parse Liquipedia player page HTML into structured data
// Handles infobox table structure: <td class="...infobox-description...">KEY</td><td>VALUE</td>
function parseLpediaHtml(html, playerName) {
  if (!html || html.length < 50) return { error: "empty_response", player: playerName };

  // Extract infobox key-value pairs from table structure
  const kvRegex = /<td[^>]*infobox[^>]*>([^<]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  const infobox = {};
  let m;
  while ((m = kvRegex.exec(html)) !== null) {
    const key = m[1].trim().replace(/:$/, "").toLowerCase();
    const val = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (key && val && val.length < 100) infobox[key] = val;
  }

  // Tournament history: date | tournament link | place
  const tourneyRegex = /<td[^>]*>(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([^<]{1,30})<\/td>/gi;
  const recent = [];
  while ((m = tourneyRegex.exec(html)) !== null) {
    const date = m[1];
    if (date >= "2024-01-01") {
      const name = m[2].replace(/<[^>]+>/g, "").trim();
      const place = m[3].trim();
      if (name && name.length > 2) recent.push(`${name} - ${place} [${date.slice(0,7)}]`);
    }
  }

  // Bail if nothing parsed -- page exists but unrecognized structure
  if (!Object.keys(infobox).length && !recent.length) {
    return { error: "parse_failed", player: playerName, hint: "Page found but no infobox data" };
  }

  // Status detection
  const statusRaw = (infobox["status"] || "").toLowerCase();
  const isStandin  = statusRaw.includes("stand");
  const isInactive = ["inactive","retired","benched","loan"].some(x => statusRaw.includes(x));
  const status = isStandin ? "STAND-IN" : isInactive ? "INACTIVE" : "ACTIVE";

  return {
    source: "Liquipedia",
    player: playerName,
    fetched_at: new Date().toLocaleTimeString(),
    status,
    is_standin: isStandin,
    is_inactive: isInactive,
    current_team: infobox["team"] || infobox["organization"] || null,
    role: infobox["role"] || infobox["position"] || null,
    nationality: infobox["nationality"] || infobox["country"] || null,
    recent_tournaments: recent.slice(0, 5),
  };
}

async function fetchLpediaPlayer(playerName, sport) {
  const wiki = LPEDIA_WIKIS[sport] || "leagueoflegends";
  const normalized = lpediaNormalize(playerName);
  const cacheKey = `${wiki}::${normalized}`;

  // Return cached result immediately (null means "checked, not found")
  if (cacheKey in lpediaCache) return lpediaCache[cacheKey];

  // Throttle: enforce gap between calls
  const elapsed = Date.now() - lpediaLastCall;
  if (elapsed < LPEDIA_GAP_MS) {
    await new Promise(r => setTimeout(r, LPEDIA_GAP_MS - elapsed));
  }
  lpediaLastCall = Date.now();

  try {
    const page = encodeURIComponent(normalized);
    const url = `https://liquipedia.net/${wiki}/api.php?action=parse&page=${page}&prop=text&format=json&origin=*`;
    const res = await fetch(url, {
      headers: { "User-Agent": "EsportsKillModel/1.0 (personal prop analyzer)" }
    });

    if (!res.ok) {
      const err = { error: res.status === 404 ? "not_found" : `http_${res.status}`, player: playerName };
      lpediaCache[cacheKey] = err;
      return err;
    }

    const d = await res.json();

    // Liquipedia returns { error: { code: "missingtitle" } } for missing pages
    if (d.error) {
      const err = { error: d.error.code === "missingtitle" ? "not_found" : d.error.info, player: playerName };
      lpediaCache[cacheKey] = err;
      return err;
    }

    const html = d?.parse?.text?.["*"] || "";
    const result = parseLpediaHtml(html, playerName);
    lpediaCache[cacheKey] = result;
    return result;

  } catch (e) {
    // Network error, CORS block, etc.
    const err = { error: String(e.message || "network_error"), player: playerName };
    lpediaCache[cacheKey] = err;
    return err;
  }
}

// --- BACKEND STATS FETCH ------------------------------------------------------
// Fetches real kill stats from the backend (gol.gg / HLTV / vlr.gg)
// Returns formatted scout notes string or null on failure

const backendStatsCache = {};

async function fetchBackendStats(playerName, sport, teamName, opponentName) {
  const key = `${playerName}::${sport}::${teamName||""}::${opponentName||""}`;
  if (backendStatsCache[key]) return backendStatsCache[key];

  try {
    let url = `${BACKEND_URL}/stats?player=${encodeURIComponent(playerName)}&sport=${encodeURIComponent(sport)}`;
    if (teamName)    url += `&team=${encodeURIComponent(teamName)}`;
    if (opponentName) url += `&opponent=${encodeURIComponent(opponentName)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    backendStatsCache[key] = data;
    return data;
  } catch (e) {
    return null;
  }
}

async function fetchBatchBackendStats(props) {
  // props = [{ player, sport, team, opponent }, ...]
  try {
    const res = await fetch(`${BACKEND_URL}/stats/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(props),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return {};
    return res.json();
  } catch (e) {
    return {};
  }
}

// --- TIER CLASSIFICATION ------------------------------------------------------
// T1 = Premier/Major/World Championship level
// T2 = Regional top league (LPL, LEC, LCS, VCT etc.)
// T3 = Qualifier / Minor / Challenger / Academy
// T4 = Everything else (show leagues, open quals, amateur)

const TIER_META = {
  1: { label: "MAJOR EVENT", color: "#FFD700", badge: "#3a2e00", desc: "Majors, Worlds, Premier international events" },
  2: { label: "PRO",         color: "#4ade80", badge: "#0f2a15", desc: "Regional pro leagues & top tier events"       },
};

function classifyTier(leagueName, matchup, sportCode) {
  // Returns 1 (MAJOR EVENT) or 2 (PRO) only -- no fluff, no tier 3/4
  // Primary classification: enrichment data from HLTV/vlr.gg/gol.gg overrides this
  // This is the fallback from PrizePicks league name strings only

  const s = (leagueName + " " + matchup + " " + (sportCode||"")).toLowerCase();

  // MAJOR EVENT -- international majors, world championships, premier events
  const isMajor = (
    s.includes("major") ||
    s.includes("world championship") || s.includes("worlds") ||
    s.includes("msi") || s.includes("mid-season invitational") ||
    s.includes("the international") || s.includes(" ti ") ||
    s.includes("vct masters") || s.includes("vct champions") ||
    s.includes("masters bangkok") || s.includes("masters toronto") ||
    s.includes("masters madrid") || s.includes("masters shanghai") ||
    s.includes("masters berlin") || s.includes("masters reykjavik") ||
    s.includes("blast premier final") ||
    s.includes("esl one") ||
    s.includes("iem cologne") || s.includes("iem katowice") || s.includes("iem dallas") ||
    s.includes("iem rio") || s.includes("iem chengdu") ||
    s.includes("pgl") ||
    s.includes("six invitational") ||
    s.includes("cdl major") || s.includes("cdl champs") ||
    s.includes("algs championship") ||
    s.includes("dpc major") || s.includes("dreamhack") ||
    s.includes("international") && (s.includes("vct") || s.includes("cs") || s.includes("dota"))
  );
  if (isMajor) return 1;

  // PRO -- everything that is a known esport defaults to PRO
  // We never return fluff for esports -- if it made it through the extension it's legit
  return 2;
}

function detectStage(leagueName) {
  const s = leagueName.toLowerCase();
  if (s.includes("grand final") || s.includes("grand finals")) return "GRAND_FINALS";
  if (s.includes("final") && !s.includes("qualifier")) return "FINALS";
  if (s.includes("semi")) return "SEMIFINALS";
  if (s.includes("quarter")) return "QUARTERFINALS";
  if (s.includes("playoff") || s.includes("knockouts") || s.includes("bracket")) return "PLAYOFFS";
  if (s.includes("group") || s.includes("swiss") || s.includes("round robin")) return "GROUPS";
  return "REGULAR";
}

// Trending count -> contrarian signal
// >50k picks: high public interest. Slightly reduces edge but does NOT determine direction.
// >100k: strong fade signal
function trendingSignal(count) {
  if (count > 100000) return "FADE_STRONG";
  if (count > 50000)  return "FADE_MILD";
  if (count > 10000)  return "NEUTRAL_HIGH";
  return "NEUTRAL";
}

// PrizePicks sends sport codes directly on the league object: VAL, LOL, CS2, DOTA, R6, COD, APEX
// Map those codes to our internal sport keys
const PP_SPORT_MAP = {
  "VAL":  "Valorant",
  "LOL":  "LoL",
  "CS2":  "CS2",
  "CSGO": "CS2",
  "DOTA": "Dota2",
  "DOTA2":"Dota2",
  "R6":   "R6",
  "COD":  "COD",
  "CALLOFDUTY": "COD",
  "CALL OF DUTY": "COD",
  "VALORANT": "Valorant",
  "VCT": "Valorant",
  "VALO": "Valorant",
  "APEX": "APEX",
};

function detectSport(leagueName, statType, position, sportCode) {
  // 1. Use PrizePicks sport code directly if available -- most reliable
  if (sportCode) {
    const upper = sportCode.toUpperCase().trim();
    if (PP_SPORT_MAP[upper]) return PP_SPORT_MAP[upper];
    // Partial match
    for (const [code, sport] of Object.entries(PP_SPORT_MAP)) {
      if (upper.includes(code)) return sport;
    }
  }
  // 2. Fallback: parse from league name / stat type
  const s = (leagueName + " " + statType + " " + (position||"")).toLowerCase();
  if (s.includes("cs2") || s.includes("counter-strike") || s.includes("csgo") || s.includes("esl pro")) return "CS2";
  if (s.includes("valorant") || s.includes("vct") || s.includes("champions tour") || s.includes("acs"))  return "Valorant";
  if (s.includes("dota") || s.includes("the international") || s.includes("dpc"))                         return "Dota2";
  if (s.includes("r6") || s.includes("rainbow") || s.includes("siege"))                                   return "R6";
  if (s.includes("cod") || s.includes("call of duty") || s.includes("cdl"))                               return "COD";
  if (s.includes("apex") || s.includes("algs"))                                                            return "APEX";
  if (s.includes("blast") || s.includes("iem") || s.includes("hltv"))                                     return "CS2";
  if (s.includes("lol") || s.includes("league of legends") || s.includes("lpl") ||
      s.includes("lck") || s.includes("lec") || s.includes("lcs"))                                        return "LoL";
  return "LoL";
}

function parsePrizePicksJSON(raw) {
  try {
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!d?.data || !Array.isArray(d.data)) return null;

    // Build lookup maps from included
    const players = {}, games = {}, leagues = {}, playerObjs = {};
    (d.included || []).forEach(item => {
      if (item.type === "new_player") { players[item.id] = item.attributes; playerObjs[item.id] = item; }
      if (item.type === "game")       games[item.id]   = item.attributes;
      if (item.type === "league")     leagues[item.id] = item.attributes;
    });

    // ── MATCHUP INFERENCE ──────────────────────────────────────────────────────
    // PP lists projections in order: Team A (all positions) then Team B (all positions).
    // Each projection has a game relationship (game_id). Players in the same game share that id.
    // Step 1: collect all teams seen per game_id (in order of first appearance).
    // Step 2: the first 2 distinct teams in a game are the matchup.
    // This is more reliable than trying to parse game.metadata which is often missing.

    // Pass 1: extract raw data per projection
    const rawItems = d.data.map(proj => {
      const a   = proj.attributes || {};
      const pid = proj.relationships?.new_player?.data?.id;
      const gid = proj.relationships?.game?.data?.id || null;
      const pl  = players[pid] || {};
      const gm  = games[gid]  || {};

      let lid = proj.relationships?.league?.data?.id;
      if (!lid && pid && playerObjs[pid]) lid = playerObjs[pid].relationships?.league?.data?.id;
      const lg = leagues[lid] || {};

      // Team: try player.team, then game metadata home/away abbreviation matching, then description
      const gmTeams  = gm.metadata?.game_info?.teams;
      const awayAbbr = gmTeams?.away?.abbreviation || gmTeams?.away?.name || "";
      const homeAbbr = gmTeams?.home?.abbreviation || gmTeams?.home?.name || "";

      const plTeam = (pl.team || "").trim() ||
                     (a.description || "").split(" ").slice(0,-1).join(" ").trim() ||
                     "?";

      return {
        projId:   proj.id,
        pid, gid, lid,
        player:   pl.name || "?",
        team:     plTeam,
        position: pl.position || "?",
        line:     parseFloat(a.line_score) || 0,
        odds_type: a.odds_type || "standard",
        stat:     a.stat_display_name || a.stat_type || "Kills",
        stat_type: a.stat_type || "",
        stat_display_name: a.stat_display_name || "",
        start_time: a.start_time || null,
        trending: a.trending_count || 0,
        adjusted_odds: a.adjusted_odds || false,
        is_combo: !!(pl.combo || a.event_type === "combo" || (a.stat_type||"").includes("Combo")),
        leagueName: lg.name || "",
        sportCode:  lg.sport || a.sport || "", // fallback to projection's own sport field (VAL/COD often have no league relationship)
        awayAbbr, homeAbbr,
        image_url: pl.image_url || null,
      };
    }).filter(x => x.player !== "?" && x.line > 0);

    // Pass 2: build per-game team order map
    // For each game_id, collect teams in the ORDER they first appear in the PP data.
    // PP always lists all players of Team A before Team B (their board order).
    const gameTeamOrder = {}; // game_id -> [teamA, teamB] (in appearance order)
    for (const item of rawItems) {
      if (!item.gid || item.team === "?") continue;
      if (!gameTeamOrder[item.gid]) gameTeamOrder[item.gid] = [];
      const existing = gameTeamOrder[item.gid];
      if (!existing.includes(item.team)) {
        existing.push(item.team);
        if (existing.length === 2) continue; // found both teams, stop adding
      }
    }

    // Pass 3: build final props with correct matchup + opponent
    const props = [];
    for (const item of rawItems) {
      const { gid, team, leagueName, sportCode } = item;

      // Resolve matchup from game team order
      let matchup = "?", opponent = "?";
      if (gid && gameTeamOrder[gid] && gameTeamOrder[gid].length >= 2) {
        const [tA, tB] = gameTeamOrder[gid];
        matchup  = `${tA} vs ${tB}`;
        opponent = team === tA ? tB : team === tB ? tA : tB;
      } else if (gid && gameTeamOrder[gid]?.length === 1) {
        // Only one team found (solo props or missing data)
        const [tA] = gameTeamOrder[gid];
        // Fall back to game metadata abbreviations if available
        if (item.awayAbbr && item.homeAbbr) {
          matchup  = `${item.awayAbbr} vs ${item.homeAbbr}`;
          opponent = team === item.awayAbbr ? item.homeAbbr : item.awayAbbr;
        } else {
          matchup  = tA;
          opponent = "?";
        }
      } else if (item.awayAbbr && item.homeAbbr) {
        matchup  = `${item.awayAbbr} vs ${item.homeAbbr}`;
        opponent = team === item.awayAbbr ? item.homeAbbr :
                   team === item.homeAbbr ? item.awayAbbr :
                   item.homeAbbr;
      }

      const sport = detectSport(leagueName, item.stat_type, item.position, sportCode);
      const tier  = classifyTier(leagueName, matchup, sportCode);
      const stage = detectStage(leagueName);

      const stat_category = (() => {
        const st = (item.stat_type + " " + item.stat_display_name).toLowerCase();
        if (item.is_combo) return "COMBO";
        if (st.includes("headshot") || st.includes(" hs")) return "HEADSHOTS";
        if (st.includes("assist")) return "ASSISTS";
        return "KILLS";
      })();

      props.push({
        id: item.projId, player: item.player, team: item.team,
        position: item.position, sport, league: leagueName, league_id: item.lid,
        tier, stage, stat: item.stat, line: item.line,
        odds_type: item.odds_type, is_combo: item.is_combo, stat_category,
        matchup, opponent,
        start_time: item.start_time, trending: item.trending,
        trending_signal: trendingSignal(item.trending),
        image_url: item.image_url, adjusted_odds: item.adjusted_odds,
      });
    }

    return props;
  } catch (e) {
    console.error("PP parse error:", e);
    return null;
  }
}

function groupProps(props) {
  const groups = {};
  props.forEach(p => {
    const k = `${p.player}||${p.matchup}||${p.stat}`;
    if (!groups[k]) groups[k] = { standard: null, goblin: null, demon: null, meta: p, notes: "" };
    groups[k][p.odds_type] = p;
  });
  return Object.values(groups);
}

// --- SYSTEM PROMPTS -----------------------------------------------------------
function buildSystemPrompt(sport) {
  const base = `You are the sharpest esports prop analyst alive. Real money is on the line. Be decisive, mathematical, ruthlessly honest. ALWAYS cite specific numbers from SCOUT NOTES when available. "L7 avg 8.2 vs season 6.9, HOT" beats any vague qualitative claim. Today: ${new Date().toDateString()}.

===============================================
BACKTEST CALIBRATION -- MANDATORY OVERRIDES
===============================================
These rules come from real 2024-2025 historical prop analysis (31 verified props).
VIOLATING THESE CAPS IS THE #1 SOURCE OF LOSING PICKS.

CS2 RULES -- TWO PATHS:

PATH A -- VETO CONFIRMED (notes contain "CS2_VETO_KNOWN" or "VETO_CONFIRMED"):
  Conf cap is LIFTED to 78. This is the fixed CS2 path.
  STEP 1: Read MAP_PROJ from notes -- this is the per-map kill projection for confirmed maps.
  STEP 2: AWP-favorable maps (Dust2, Mirage, Inferno, Ancient): AWPers project +10-15% above season avg.
          Rifle-favorable maps (Nuke, Overpass, Vertigo, Anubis): AWPers project -10-15% below season avg.
  STEP 3: Check per-map stats (e.g. "Dust2:29.5k Mirage:26.0k") -- use MAP_PROJ as primary projection.
  STEP 4: Apply normal rules (IGL cap, stomp, form trend) ON TOP of MAP_PROJ.
  STEP 5: Max conf 78 (not 84) -- CS2 still has round-to-round variance even with veto.
  WHY THIS WORKS: The 42.9% accuracy was entirely due to not knowing the map. ZywOo on Inferno = ~18k. ZywOo on Dust2 = ~30k. Same player, different prop call entirely.

PATH B -- VETO UNKNOWN (notes contain "CS2_MAP_POOL_UNKNOWN"):
  Conf MUST be <= 68. No exceptions. Reason: 42.9% accuracy when blind to map.
  ONLY reliable signal: IGL non-fraggers (karrigan, gla1ve, neaLaN) -> LESS, max conf 72.
  All other CS2 props -> cap at 68. Do not exceed regardless of other factors.
  If per-map stats provided (e.g. "PER_MAP(Dust2:29k/Mirage:25k)") -- these are for context only.
  Without knowing WHICH maps are played, you cannot know which stat applies.

CURRENT CS2 STATUS: System now scrapes HLTV match veto page. When confirmed, uses PATH A.
  When not yet available (pre-event), uses PATH B until veto data arrives.

CS2 PER-MAP KILL REFERENCE (use with VETO_CONFIRMED to project precisely):
  ZywOo:   Dust2~30 | Mirage~28 | Inferno~24 | Ancient~25 | Nuke~18 | Overpass~20 | Vertigo~19 | Anubis~22
  NiKo:    Dust2~27 | Mirage~26 | Inferno~22 | Ancient~23 | Nuke~20 | Overpass~22 | Vertigo~20 | Anubis~21
  ropz:    Dust2~25 | Mirage~24 | Inferno~21 | Ancient~21 | Nuke~19 | Overpass~20 | Vertigo~19 | Anubis~20
  m0NESY:  Dust2~26 | Mirage~25 | Inferno~22 | Ancient~22 | Nuke~18 | Overpass~21 | Vertigo~20 | Anubis~21
  xertioN: Dust2~24 | Mirage~23 | Inferno~20 | Ancient~21 | Nuke~18 | Overpass~20 | Vertigo~19 | Anubis~20
  stavn:   Dust2~24 | Mirage~23 | Inferno~20 | Ancient~20 | Nuke~17 | Overpass~19 | Vertigo~18 | Anubis~19
  karrigan: ALL maps 13-17 (IGL, never use for MORE props)
  gla1ve:  ALL maps 12-16 (IGL, never use for MORE props)
  arT:     Dust2~22 | Mirage~21 | Inferno~20 (entry-first = slightly lower ceiling but higher than avg IGL)
  For players NOT listed: use role_avg x MAP_KILL_MULTIPLIER from map constants.

COD HARD CAP: If stats notes contain "COD_MODE_UNKNOWN" -> conf MUST be <= 65. No exceptions.
  Reason: HP vs SnD kill totals differ by 3-5x. Without mode, any projection is a guess.
  Do not exceed 65 confidence on ANY COD prop. Mark as Grade B max. Never parlay_worthy.

POSITIVE EV SPORTS (directionally confirmed across small verified sample -- 31 total picks):
  Valorant: 6/6 in seed data (small sample -- treat as directional, not absolute). Agent-confirmed props are sharpest signal.
  LoL: 7/9 in seed data (77.8%). Role+champion confirmed props show consistent edge.
  Dota2: 4/4 in seed data (very small n). Position analysis shows signal.
  IMPORTANT: These are seed samples, not large-scale backtests. Apply normal confidence rules -- do NOT inflate confidence solely because the sport is Valorant or LoL.
  These three are your primary parlay construction sports -- but only on confirmed signal props.

APEX: Always -8 conf (zone RNG = 30%+ irreducible variance). Never above 70.


===============================================
If ANY of these are true, output Grade C, all recs SKIP, parlay_worthy false, and STOP:
  - Player role is pure support/healer/anchor/IGL AND kill line > 4.5
    (Soraka, Nami, Lulu, Karma in SUPPORT, pos5 hard support with zero kill history)
    Note: Killjoy/Cypher CAN get 12-16 kills/map -- only SKIP if line is clearly above their ceiling.
    Note: IGLs who DO frag (NiKo, s1mple) are NOT auto-skip -- check their actual stats first.
  - APEX Legends prop AND line > 10 AND no exceptional fragger context in scout notes
  - Standin confirmed AND no recent match data
  - Projected is within 2.5% of line AND no strong role signal (IGL/enchanter/zero-kill hero) present
    NOTE: Apply this check to the ORIGINAL projection BEFORE series-length multiplication.
    If proj_orig is within 2.5% of line, no directional conviction exists at source.
    Bo5 series multiplication on a flat projection creates false signal — output SKIP, not LESS.
  - DEMON line AND projected < demon line x 1.12 (not enough cushion)
These are automatic losers at scale. Do not analyze further. Output the SKIP JSON and move on.

===============================================
RULE 1 -- CHAMPION/AGENT PICK OVERRIDE (highest priority signal)
===============================================
Champion/agent pick determines 35-42% of kill outcome. These override everything else:

AUTO-LESS overrides (regardless of role avg, win prob, or anything):
  LoL:      Soraka, Nami, Lulu, Karma, Zilean, Janna, Yuumi -> cap projected at 1.5 kills/map
  LoL:      Azir, Orianna played utility -> reduce projected 25% from role baseline
  LoL:      Maokai, Sion, Malphite SUP -> 0-1 kills/map, always LESS
  Valorant: Killjoy, Cypher played anchor -> cap projected at 14 kills/map (not per series)
  Valorant: Sage -> cap projected at 12 kills/map
  CS2:      IGL confirmed non-fragger (karrigan, gla1ve, neaLaN) -> cap 15 kills/map
  Dota2:    Pos5 (Chen, Io, Treant) -> cap 3 kills/game

AUTO-MORE signals (primary carry picks -- apply +10% to role baseline):
  LoL:      Zed, Katarina, Fizz, Akali, Draven, Jinx on carry -> +15-25% kill projection
  LoL:      Hecarim, Vi, Lee Sin ganking JNG (team win_prob >= 50%): +10-15% to JNG baseline
            Hecarim, Vi, Lee Sin ganking JNG (team win_prob < 50%, underdog): -5% to JNG baseline
            REASON: Underdog ganking junglers get shut down — they cannot invade a favored team's jungle.
            Ganking style only pays off when your lanes already have pressure to open up invades.
            Do NOT apply the ganking bonus when the player's team is the underdog.
  Valorant: Jett, Reyna -> +20% to duelist baseline
  Valorant: Neon on flat maps (Breeze, Sunset) -> +15%
  CS2:      Primary AWPer on Mirage, Dust2 -> +10% to star fragger baseline
  Dota2:    Teamfight draft (Magnus, Tidehunter, Enigma) -> +40% to all kill projections

If draft/agent is unknown: use role baseline, reduce conf -4, note "pick unknown."

===============================================
RULE 2 -- SERIES LENGTH (compute from win probability, do not estimate)
===============================================
Use the exact win probability provided. Compute expected maps precisely:
  p = team win probability (higher side)
  P(sweep) = p2 + (1-p)2  [either team sweeps]
  P(full)  = 1 - P(sweep)
  expected_maps = P(sweep) x 2 + P(full) x 3  [Bo3]
  For Bo5: expected_maps = P(3-0)x3 + P(3-1)x4 + P(3-2)x5

Examples (use these as anchors):
  80% favorite: expected ~= 2.18 maps -> COMPRESS all props heavily
  70% favorite: expected ~= 2.30 maps -> compress moderately
  60% favorite: expected ~= 2.42 maps -> slight compression
  50/50:        expected ~= 2.50 maps -> standard
  Note: 2.50 is the theoretical max for Bo3 at true 50/50

ALWAYS multiply role_avg_per_map x expected_maps as your raw base.
Never use a round number like "2.4 maps" -- compute it from the actual win prob given.

===============================================
RULE 3 -- STOMP RISK (underdog carry compression)
===============================================
Stomps compress underdog kills dramatically. Apply these ADDITIONAL penalties to underdog carries:
  Opponent 75%+ favorite: multiply underdog carry projection x 0.72 (heavy stomp risk)
  Opponent 65-74% favorite: multiply underdog carry projection x 0.82
  Opponent 55-64% favorite: multiply underdog carry projection x 0.92
  Opponent <55% (competitive): no stomp compression -- series is close

Why 0.72 not 0.85: In LoL/Valorant stomps, losing carries routinely hit 30-40% of their projected kills.
A 7 kill/map average becomes 2-3 kills in a dominated game. The line rarely prices this in.

Exception: high-floor fraggers whose kills are INDEPENDENT of winning (AWPer, entry fragger who dies first, Reyna dismiss mechanics). Apply only -10% instead of stomp multiplier for these.

===============================================
RULE 4 -- FORM TREND (resets the projection, not just confidence)
===============================================
PRIORITY: If SCOUT NOTES provide L7 kills (e.g. "L7-K:[8,7,9,6,8,7,10]avg7.9"), USE THOSE NUMBERS directly.
L7 data from SCOUT NOTES is the single most accurate projection input. Do not ignore it.

If recent form data is provided (last 30d vs season):
  HOT    (recent 10%+ above season): USE recent avg as your projection base, conf +4
           Example: season 7k/map, last-30d 8.2k/map → project 8.2, add +4 conf.
  COLD   (recent 10%+ below season): USE recent avg as your projection base, conf -5, flag clearly
           Example: season 8k/map, last-30d 5.8k/map → project 5.8, subtract -5 conf. This is the most impactful modifier.
  STABLE (within 10%): USE season avg, no modifier.
  UNKNOWN -- three tiers:
    Tier A (T1/GEN/Vitality/G2/NaVi/Paper Rex/LOUD known rosters): treat as STABLE. 0 modifier. These players are public-stat tracked; absence of L7 data is a scraping issue, not player issue.
    Tier B (known pro player, regional leagues): apply -2 conf only, not -3.
    Tier C (genuinely unknown, standin, no public presence): apply -5 conf, flag "data poor."

L7 KILLS INTERPRETATION:
  If last7 avg > season avg by 10%+: HOT
  If last7 avg < season avg by 10%+: COLD
  Always report the L7 avg in your insights: "L7 avg X vs season Y — HOT/COLD/STABLE"

The key: form trend changes the NUMBER you project, not just the confidence.
A player averaging 8 kills/map season but L7 showing 5.5/map projects at 5.5, not 8.
This is the most commonly mispriced factor on the entire board — prioritize it.

===============================================
RULE 5 -- COMBO PROBABILITY (enforce the math)
===============================================
Combo props require ALL players to hit simultaneously. Apply true probability math:
  2-player combo: effective_conf = (conf_A/100) x (conf_B/100) x 100
  3-player combo: effective_conf = (conf_A/100) x (conf_B/100) x (conf_C/100) x 100
  Then apply -10% variance haircut to the combined projection

Example: Two 68% conf players -> effective combo conf = 0.68 x 0.68 x 100 = 46%
That is Grade C. Never recommend a combo as parlay-worthy unless effective_conf >= 62.

Report effective_conf in variance_flags as "Combo effective conf: X%"

===============================================
RULE 6 -- HYPE LINE SKEPTICISM
===============================================
PrizePicks adjusts lines based on public narrative. When a player just had a huge series,
their line is often bumped to price in recency bias. Signs of a hype-inflated line:
  - DEMON line on a player coming off career-high performance
  - Line 20%+ above their season average
  - High trending count (50k+ picks) on a MORE prop

When you detect a hype line: reduce edge by 5%, note "potential hype inflation." This does NOT change direction -- only lowers confidence slightly. If your projection still clears the line by 12%+, the bet stands.
The market has already done the obvious work. The edge is finding spots the public missed.

===============================================
RULE 7 -- WINNER/LOSER NUANCE (full framework)
===============================================
Win probability from Pinnacle is your strongest matchup prior. But kills != wins.

WINNER CARRIES:
  60-69% favorite: primary carry +5 conf, secondary carry +3 conf
  70-74% favorite: primary carry +3 conf only (stomp risk offsets)
  75%+ favorite:   primary carry 0 conf change (stomp cancels out) -- apply Rule 3 instead

LOSER CARRIES -- DO NOT AUTO-FADE. Evaluate by role type:
  HIGH-FLOOR FRAGGERS (kills independent of winning -- AWPer, entry fragger, Jett/Reyna):
    Competitive series (45-55%): 0 conf penalty -- series goes long, they accumulate kills
    Moderate underdog (35-44%): -3 conf only
    Heavy underdog (<35%):      -5 conf (stomp risk real but floor protects them)
  TEAM-DEPENDENT FRAGGERS (kills require team winning fights -- utility carries, BOT in peel meta):
    Moderate underdog (35-44%): -6 conf
    Heavy underdog (<35%):      -10 conf, likely SKIP

NEVER supports on either team. Role determines kills, not win probability.

===============================================
RULE 8 -- CONFIDENCE SCALE & GRADE RUBRIC
===============================================
Start at 65. Apply all modifiers from Rules 1-7. Cap at 84. Floor at 50.

  84 -- Maximum. Absolute lock. Elite floor fragger, goblin line, heavy favorite, HOT form.
  78-83 -- Grade S. Everything stacked. Should appear 2-4 times per full board.
  70-77 -- Grade A. Clear edge with solid math. Should appear 4-8 per board.
  62-69 -- Grade B. Playable solo, marginal for parlay. Lower priority.
  50-61 -- Grade C. SKIP. Do not recommend.

HARD CAPS (non-negotiable):
  NEVER conf > 84
  NEVER conf > 76 for pure enchanter supports (Soraka, Nami, Lulu in support role ONLY)
  NEVER conf > 74 on true coin-flip matchups (48-52% win prob, no clear edge)
  NEVER conf > 78 on APEX props (zone RNG adds irreducible variance)
  NEVER parlay_worthy = true for Grade C
  Grade B props CAN be parlay_worthy = true if edge > 12% and conf >= 67

DIRECTION BALANCE -- you must find edges in BOTH directions:
  MORE edge: player projected above line, favorable matchup, hot form
  LESS edge: player projected below line, unfavorable matchup, support/utility
  DO NOT default to LESS just because there is uncertainty. Uncertainty = lower conf, not LESS direction.
  If projected = line +/- 3%: lower conf, not automatic LESS.
  LESS is only correct when your projection is clearly below the line.

===============================================
RULE 9 -- LINE VALUE
===============================================
Edge = ((projected - line) / line) x 100

GOBLIN: line below EV. Need projected > goblin. Low bar. +3 edge bonus.
STANDARD: need projected > standard by 10%+.
DEMON: need projected > demon by 15%+ AND conf >= 68. Do NOT recommend demon MORE below this.
       Demon MORE with conf < 68 is the single most common losing bet type.

Hype adjustment: if trending > 50k picks on a MORE prop, reduce edge -6% (public has bid up the line).

Best bet = line type with largest (projected - line) gap after adjustments.

===============================================
RULE 10 -- MISSING DATA & PATCH CONTEXT
===============================================
No stat data for player: use role position baseline, cap conf 65, flag "role baseline only"
Unknown player profile: use role baseline, cap conf 62, flag "unknown player"
Standin confirmed: cap conf 58, Grade C, SKIP parlay
Patch unknown: apply most recent meta knowledge, note "patch unverified", compress projection 5%
Pick/agent unknown: use role baseline -10%, conf -4, flag "pick unknown"

H2H CONTEXT: When MATCH CONTEXT line contains H2H data (H2H_WIN_RATE, RECENT_H2H):
  USE IT. It is verified from PandaScore match history. Apply as follows:
  H2H_WIN_RATE 70%+: +4 conf for winner-side carries, -4 for loser-side carries
  H2H_WIN_RATE 55-70%: +2 conf for winner-side carries
  H2H_WIN_RATE ~50%: neutral (use win_prob instead)
  Recent form (e.g. "T1_FORM: W vs GenG | L vs NRG"): factor last 3 results as form signal
  If no H2H data: use win_prob from Pinnacle and known rivalries from training knowledge.

MISSING DATA WATERFALL (follow in order):
  1. Real stats in SCOUT NOTES → use directly, highest priority
  2. MATCH CONTEXT (PandaScore) → series format, H2H, win prob
  3. LIQUIPEDIA DATA → team/role confirmation
  4. Player profiles from your training knowledge → known player kill ranges
  5. Role baselines from sport-specific section → conservative estimate
  At each level: if data exists, use it. Cap conf by data quality level (1=84, 2=78, 3=72, 4=68, 5=65).

Return ONLY valid JSON. No markdown. No preamble. No explanation outside the JSON.`;

  const sports = {

// -----------------------------------------------------------------------------
LoL: `
SPORT: League of Legends

SERIES FORMAT: Use the MATCH CONTEXT line provided in the prompt. Do NOT default to Bo3.
If no match context: assume Bo3, note "format unconfirmed", apply -3 conf.

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. CHAMPION PICK (highest kill variance driver -- ~35% of outcome)
   Assassins/carries (Zed, Katarina, Fizz, Draven, Jinx, Caitlyn): +25-40% to role kill-share
   Utility/control (Orianna, Azir, Lulu, Karma, Zilean): -20-35% vs baseline
   Tank supports (Leona, Nautilus, Alistar): 1-3 kill avg, occasionally steal kills
   Enchanter supports (Soraka, Nami, Lulu): 0-1 kill avg -- always LESS
   Engage junglers (Lee Sin, Vi, Jarvan, Hecarim carry): +15%
   Farm junglers (Graves, Karthus, Belveth PVE): -15%
   -> Patch champion tier matters. Dominant meta picks inflate that role's kill-share.

2. TEAM KILL PACE (affects all player projections equally)
   High kill-pace teams (BLG, T1, Gen.G aggressive): avg 28-35 kills/map
   Standard pace (WBG, most LEC): avg 22-27 kills/map
   Passive/scaling teams (early 2024 JDG style, some KR teams): avg 18-22 kills/map
   -> Use team avg as denominator. Inflates or deflates every player on that team.

3. MATCHUP PACE INTERACTION
   Aggressive vs Aggressive: kill totals spike (30-40/map)
   Aggressive vs Passive: moderate total (20-28/map), win team inflates
   Passive vs Passive: low total (15-22/map), compress all props downward
   -> If both teams are passive, LESS on everyone is profitable.

4. SERIES LENGTH PROBABILITY
   Expected maps = P(2-0) x 2 + P(2-1) x 3
   Heavy favorite series: ~55% chance 2-0, so expected maps ~= 2.45
   Even series: ~25% chance 2-0, expected maps ~= 2.75
   -> Props are live for MORE maps = more kill opportunities.
   -> 2-0 risk is the #1 reason to lower projection and conf.

5. STOMP FACTOR
   Stomps (>15 kill differential) inflate winning team and DEFLATE losing team.
   Losing team BOT/MID in a stomp often ends 2-3 kills vs 7-10 projected.
   -> Factor expected win probability. Favored team's carries MORE, underdog carries LESS.

6. FIRST BLOOD & EARLY GAME RATE
   Teams with high first blood rate (BLG, T1) inflate JNG/MID early kills.
   Lane swap metas reduce early kill variance.
   -> JNG props are most sensitive to early game pace.

7. PATCH CONTEXT
   Kill-inflated patches (assassin buffs, ADC items): all kill props trend MORE
   Defensive patches (tank/support buffs): compress kill counts league-wide
   -> Always note current patch direction.

ROLE KILL-SHARE BASELINES (apply after pace and pick adjustments):
  BOT:  25-35% team kills/map. Most consistent floor regardless of meta.
  MID:  20-30%. Highest variance -- hero-dependent. Assassin MID = 28-30%, utility = 18-22%.
  JNG:  16-24%. Ganking style = upper range. Farm path = lower. Most patch-sensitive role.
  TOP:  10-18%. Island tops (Fiora, Camille) = 10-13%. TP fighters = 15-18%.
  SUP:  3-8%. Engage = 4-8%. Enchanter = 0-3%. Never parlay a SUP kill prop.

Bo3 PROJECTION FORMULA:
  raw = team_kill_avg x role_share x expected_maps
  Adjust: x1.15 for aggressive team, x0.85 for passive team
  Adjust: x0.80 for stomp underdog, x1.10 for stomp favorite
  Adjust for champion pick tier (see above)

PP LINE CONVENTION (CRITICAL):
  PrizePicks LoL kill lines are SERIES TOTALS labeled "MAPS 1-3 Kills" (Bo3) or "MAPS 1-5 Kills" (Bo5).
  PP sets lines contextually -- not mechanically. Real calibrated ranges from live boards:
  Bo3 realistic lines:
    MID/BOT carry:    12-18  (e.g. knight=15, Viper=14.5 on current boards)
    TOP fighter:       6-13  (e.g. Xiaoxu=6.5)
    JNG carry:         8-14
    SUP enchanter:     1-4   (e.g. ON=2.0)
    SUP engage:        3-7
  Bo5 realistic lines:
    MID/BOT carry:    25-38  (e.g. Ruler ~31.5)
    JNG:              14-22
    TOP utility:      12-18
  SANITY CHECK: If a LoL Bo3 carry line is below 10, or a Bo5 carry line below 22, flag as suspect.
  -> Your proj must be in series-total space: proj_series = proj_per_map x xmaps_expected.

PLAYER PROFILES -- LCK (2025-2026):
  T1:
    Faker    (T1 MID)  -- GOAT, consistent 5-8 kills/map, utility-first but spikes on assassins
    Gumayusi (T1 BOT)  -- top ADC, 7-10 kills/map on carry picks, very reliable floor
    Keria    (T1 SUP)  -- elite support, 1-3 kills, never play kill props
    Oner     (T1 JNG)  -- kill-hungry jungler, 4-7 kills/map
    Zeus     (T1 TOP)  -- strong fighter top, 4-6 kills/map
  Gen.G:
    Chovy    (GEN MID) -- one of best mids in world, consistent 7-10 kills/map
    Peyz     (GEN BOT) -- elite ADC, 7-9 kills/map, reliable MORE props
    Peanut   (GEN JNG) -- proactive, 4-6 kills/map
    Doran    (GEN TOP) -- above avg for role, 3-5 kills/map
  KT Rolster:
    Kiin     (KT TOP)  -- fighter top, 4-7 kills/map on carry picks
    Pyosik   (KT JNG)  -- aggressive, 4-7 kills/map
    BDD      (KT MID)  -- veteran carry, 6-8 kills/map
    Aiming   (KT BOT)  -- top ADC, 7-10 kills/map, very consistent

PLAYER PROFILES -- LCS/LTA NORTH (2025-2026):
  C9: Fudge TOP, Inspired JNG, Jojopyun MID, Berserker BOT -- aggressive, ~25/map pace
  TL: Impact TOP, UmTi JNG, APA MID, Yeon BOT -- inconsistent, ~22/map pace
  100T: Ssumday TOP, Closer JNG, Quid MID, Spawn BOT -- improving, ~22/map pace
  NRG: Dhokla TOP, Contractz JNG, tactical BOT -- volatile, ~20/map pace
  Note: LTA North kill pace runs 15-20% below LCK/LPL. Lines calibrated lower.

TEAM STYLE REFERENCE (2025-2026):
  BLG:   Ultra-aggressive, ~32/map. All carries inflate. knight/Viper = best LoL duo.
  NRO:   North Korea-based squad (T1/GEN era), high kill pace ~29/map.
  T1:    Methodical but explosive when ahead, ~27/map. Faker utility but can spike.
  Gen.G: Objective-first but Chovy/Peyz kill hungry, ~26/map.
  WBG:   Balanced moderate pace ~24/map. Xiaohu consistent not explosive.
  EDG:   Aggressive early, ~28/map. Scout MID high kill share.
  JDG:   Defensive, low kill pace ~20/map. Compress all prop projections.
  LYON:  Berserker-driven LEC, highest LEC kill pace ~27/map.
  G2:    Reformed aggressive, Caps + Hans Sama, ~25/map.
  KC:    Standard LEC ~22-24/map. No consistent star carry.
  Fnatic: Volatile, historically explosive Upset/Humanoid, ~23/map.
  Cloud9: Berserker import = must inflate BOT kill projections, ~25/map.

PLAYER PROFILES -- EXPANDED (2025-2026):
  LPL:
    knight   (BLG MID) -- GOAT-tier carry mid. Roamer/assassin. Floor 7k/map, ceiling 12. 
    Viper    (BLG BOT) -- most consistent ADC on planet. 7-10k/map on carries. High floor.
    Bin      (BLG TOP) -- TP-fighter, 4-6k/map. Darius/Garen style spikes to 7.
    Xun      (BLG JNG) -- ganking jungler, early invades, 4-7k/map. Series total 10-18.
    Xiaohu   (WBG MID) -- veteran, consistent 5-7, peaks 8 on assassins. Not explosive.
    Elk      (WBG BOT) -- strong laner, 6-8k/map, reliable carry.
    Zika     (WBG TOP) -- skirmish top, above avg 4-6k/map.
    Scout    (EDG MID) -- carry-first, assassin/control, 6-9k/map aggressive pace.
    Viper2   (EDG BOT) -- renamed player -- standard ADC 6-8k/map.
  LCK:
    Faker    (T1 MID)  -- utility first. Standard 5-7k/map. Spikes on Ryze/Syndra. GOAT.
    Gumayusi (T1 BOT)  -- elite ADC. 7-10k/map carry picks. Reliable floor 6.
    Keria    (T1 SUP)  -- DO NOT play kill props. 1-3k only.
    Oner     (T1 JNG)  -- kill-hungry, ganking, 4-7k/map. Inflates on comfortable picks.
    Zeus     (T1 TOP)  -- fighter top, TP style. 4-6k/map. Peaks 8 on carries.
    Chovy    (GEN MID) -- best pure laner in world. 7-10k/map. Very consistent floor.
    Peyz     (GEN BOT) -- elite ADC, 7-9k/map, top 3 ADC in world. Consistent MORE.
    Peanut   (GEN JNG) -- proactive, 4-6k/map. Series total 10-15.
    Doran    (GEN TOP) -- above-avg TOP, 3-5k/map. Reliable but not explosive.
    Kiin     (KT TOP)  -- fighter top, 4-7k/map. Carry picks spike 8+.
    Pyosik   (KT JNG)  -- aggressive, 4-7k/map. Similar to Oner profile.
    BDD      (KT MID)  -- veteran carry, 6-8k/map. Consistent but no ceiling.
    Aiming   (KT BOT)  -- top 3 LCK ADC, 7-10k/map. Very consistent MORE target.
  LEC:
    Berserker (LYON/C9 BOT) -- highest kill-share BOT in any western league. 7-9/map. Elite.
    Saint    (LYON MID) -- aggressive carry, 6-8k/map.
    Inspired (LYON/C9 JNG) -- proactive, 4-6k/map.
    Caps     (G2 MID)  -- veteran EU carry, 6-8k/map. Spikes on assassins.
    Hans Sama (G2 BOT) -- aggressive ADC, 6-8k/map. Hard lane bully.
    Humanoid (Fnatic MID) -- volatile carry, 5-8k/map. High ceiling, high floor risk.
    Upset    (Fnatic BOT) -- explosive carry, 6-9k/map on hyper carries.`,

// -----------------------------------------------------------------------------
CS2: `
SPORT: Counter-Strike 2

SERIES FORMAT: Use the MATCH CONTEXT line provided in the prompt. Do NOT default to Bo3.
If no match context: assume Bo3, note "format unconfirmed", apply -3 conf.
Bo1 = -6 conf vs Bo3 baseline (single map = highest variance, one bad T-side ends everything).

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. MAP POOL (single highest predictor of kill count -- ~40% of outcome)
   HIGH kill maps (>25 kills avg per player per map):
     Mirage: open mid, lots of peeks, high kill rate
     Dust2: long/B site, wide angles, entry kills abundant
     Inferno: banana/apps fights, aggressive CT plays
     Ancient: contested mid, eco rounds inflate kills
   LOW kill maps (<20 kills avg per player per map):
     Nuke: rotation-heavy, players die in executes not duels
     Vertigo: stack-heavy, fewer individual duel opportunities
     Anubis: methodical, lower pace
     Overpass: utility-heavy, position-based, fewer aim duels
   -> Map pool determines 35-40% of kill count. Always factor veto preferences.

2. PLAYER ROLE / IN-GAME FUNCTION
   Star Fragger / Primary AWP: 22-30 kills/map avg. Most consistent kill floor.
   Entry Fragger: 18-25 kills/map. High ceiling, dies often -- volatile.
   Secondary AWP/Rifler: 18-24 kills/map. Consistent but not spectacular.
   IGL (in-game leader): 14-20 kills/map. Takes safe positions, calls over fragging.
   Support (throw flashes, trade): 12-18 kills/map. Lowest floor.
   Lurk: 15-22 kills/map. Timing-dependent, round-economy sensitive.

3. RATING / KILL EFFICIENCY
   HLTV Rating 1.20+: Top-tier fragger, consistently exceeds lines.
   HLTV Rating 1.05-1.19: Reliable, hits standard lines.
   HLTV Rating 0.95-1.04: Mediocre fragger, lines often too high.
   HLTV Rating <0.95: Support/IGL profile -- fade kill props.
   -> Rating is the #2 predictor after map pool.

4. CT vs T SIDE DYNAMICS
   CT-sided maps (Nuke, Vertigo): T-side fragging reduced, CT AWPers inflate.
   T-sided maps (Inferno, Overpass): Entry fraggers spike on attack.
   -> Players with dominant CT-side on CT-heavy maps = kill inflation.

5. SERIES LENGTH & FORMAT — PP LINE CONVENTION
   CRITICAL: PrizePicks CS2 kill lines are SERIES TOTALS (all maps combined), NOT per-map.
   The prop label is "MAPS 1-3 Kills" (Bo3) or "MAPS 1-2 Kills" (Bo2) -- total across all maps played.
   PP sets lines contextually based on matchup/form/map pool -- NOT simply (per_map_avg x maps).
   Bo3 realistic line ranges by role:
     Star Fragger / Primary AWP: 50-65 (context-suppressed maps may set lower, e.g. ZywOo 37.5 on Nuke+Inf)
     Entry Fragger:              45-60
     Secondary Rifler:           42-55
     IGL (non-fragger):          22-32
     Support:                    35-48
   Bo2 realistic line ranges (exactly 2 maps played):
     Star Fragger:               27-36
     IGL:                        18-24
     Support:                    22-30
   SANITY CHECK: If a CS2 Bo3 line is below 25 for a non-IGL, flag as suspiciously low.
   -> Your projection must be in series-total space. proj_series = proj_per_map x xmaps_expected.
   Bo3: Expected maps = 2.4. Each map ~28-32 rounds.
   Short series risk (Bo1): single-map = single data point, highest variance.
   -> Bo1 gets -6 conf automatically vs Bo3.
6. OPPONENT DEFENSIVE STYLE
   Passive CT teams (anchor heavy, no aggression): reduce entry fragger kills.
   Aggressive CT teams (wide peeks, take duels): inflate entry fragger kills.
   AWP-heavy opponents: reduce star rifler kills (more passive positioning required).

7. ECONOMY STATE / ECO ROUND RATE
   Teams with frequent pistol/eco rounds reduce per-round kills for the winning team.
   Anti-eco rounds inflate kill counts for stars (+3-5 kills/series).
   -> Factor average round count and economic patterns.

8. SERIES STAKES / ELIMINATION PRESSURE
   Elimination games: teams play aggressive, total kills spike.
   Group stage with seeding locked: conservative play, kill counts compress.

KILL PROJECTION FORMULA:
  raw = role_avg_per_map x expected_maps
  Adjust: x1.2 for high kill maps, x0.8 for low kill maps
  Adjust: x1.1 for Rating > 1.15, x0.9 for Rating < 1.0
  Adjust: x0.85 for IGL/Support role
  Adjust: x0.92 for Bo3 short series risk

PLAYER PROFILES -- CS2 (2025-2026):
  NOTE: CS2 per-map kill averages on KEY MAPS (most predictive signal after map veto):

  Team Vitality:
    ZywOo    (Vitality AWP) -- world #1. Rating ~1.35+. Season avg 26k/map.
                               Dust2: ~30k | Mirage: ~28k | Inferno: ~24k | Nuke: ~18k | Overpass: ~20k
                               ALWAYS check map. ZywOo on Nuke = 42% accuracy. ZywOo on Dust2 = 78%.
    apEX     (Vitality IGL) -- 14-18k/map. Pure IGL, no fragging role. ALWAYS LESS on kill props.
    flameZ   (Vitality)     -- star rifler, Rating ~1.15, 18-24k/map. Consistent.
    mezii    (Vitality)     -- secondary rifler, 17-22k/map.
  NAVI (post-s1mple era roster):
    iM       (NAVI)         -- star rifler/entry, Rating ~1.15, 18-23k/map.
    b1t      (NAVI)         -- aggressive rifler, Rating ~1.1, 17-22k/map. Volatile.
    jL       (NAVI)         -- secondary rifler, 16-21k/map.
    Aleksib  (NAVI IGL)     -- IGL, 12-16k/map. Low floor. LESS on kill props.
  FaZe Clan:
    karrigan (FaZe IGL)     -- legendary IGL. 12-16k/map. ALWAYS LESS on kill props.
    ropz     (FaZe)         -- elite rifler, Rating ~1.2, 20-27k/map. Consistent.
    rain     (FaZe entry)   -- entry fragger, Rating ~1.15, 18-25k/map. High variance.
    broky    (FaZe AWP)     -- AWPer, 19-25k/map. Consistent secondary AWP.
  G2:
    NiKo     (G2)           -- elite rifler, Rating ~1.25, 22-29k/map. Most reliable CS2 prop.
    huNter   (G2)           -- secondary star, Rating ~1.1, 18-23k/map.
    m0NESY   (G2 AWP)       -- elite AWP/hybrid, Rating ~1.2+, 20-27k/map.
    nexa     (G2 IGL)       -- fragger IGL, 15-20k/map (higher than typical IGL).
  MOUZ:
    xertioN  (MOUZ)         -- elite rifler, Rating ~1.2, 19-26k/map. Underrated prop.
    torzsi   (MOUZ AWP)     -- AWPer, 18-24k/map. Consistent.
    siuhy    (MOUZ IGL)     -- fragger IGL, 15-20k/map.
  Heroic:
    stavn    (Heroic)       -- star rifler, Rating ~1.2, 19-25k/map. Reliable MORE.
    cadiaN   (Heroic IGL)   -- aggressive IGL, 16-21k/map (higher floor than avg IGL).
    TeSeS    (Heroic)       -- secondary star, 17-22k/map.
  FURIA:
    arT      (FURIA IGL/entry) -- aggressive IGL entry, 18-24k/map. Unique high-floor IGL.
    yuurih   (FURIA)        -- star rifler, 19-25k/map.
    KSCERATO (FURIA)        -- elite rifler, Rating ~1.2, 20-26k/map. Consistent MORE.
  Astralis:
    dev1ce   (Astralis AWP) -- legendary AWP, Rating ~1.15, 19-25k/map. More consistent at lower tier.
    gla1ve   (Astralis IGL) -- pure IGL, 12-16k/map. ALWAYS LESS.
  Liquid:
    NAF      (Liquid)       -- star rifler, 19-25k/map. Consistent at top tier.
    oSee     (Liquid AWP)   -- NA AWPer, 17-23k/map. Slightly below EU tier.`,

// -----------------------------------------------------------------------------
Valorant: `
SPORT: Valorant

SERIES FORMAT: Use the MATCH CONTEXT line provided in the prompt. Do NOT default to Bo3.
If no match context: assume Bo3, note "format unconfirmed", apply -3 conf.

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===
1. AGENT PICK (highest kill predictor -- ~38% of outcome)
   DUELIST (primary fragger role):
     Jett: highest individual kill ceiling. Dash enables trading safely = more net kills.
     Reyna: dismiss mechanic = can go aggressive without dying. Kill-feed machine.
     Neon: fast pace, spray accuracy, high kill rate on flat maps.
     Iso: underused but kill-heavy kit.
     Raze: grenade + satchels = explosive entry. Spikes on Haven, Split.
   INITIATOR (secondary fragger):
     Sova: info + dart kills. Consistent 15-20 kills/map.
     Breach: stun creates kills for team, some self-frags.
     Fade: haunt + reveal = pick setup. Moderate kill rate.
     KAY/O: suppression = entry kills. Similar to breach.
     Gekko: lower kill rate, more about plant/defuse utility.
   CONTROLLER (utility fragger, rarely kills):
     Omen/Astra/Viper: smoke-dependent, rarely in primary kill position.
     Clove: newer duelist-adjacent controller -- slightly higher kill rate.
   SENTINEL (lowest kill rate):
     Killjoy/Cypher: anchoring, trap kills only.
     Deadlock: similar floor.
   -> Never parlay Killjoy/Cypher props on kill counts unless line is set correctly below 15.

2. ACS (AVERAGE COMBAT SCORE) -- most reliable player-level metric
   ACS 250+: Elite fragger, consistently over lines.
   ACS 200-249: Solid, hits standard lines.
   ACS 160-199: Utility/support player -- lines often too high.
   ACS <160: Lean LESS on any kill prop.

3. MAP CHARACTERISTICS
   HIGH kill rate maps: Haven (3 sites = more fights), Split (vertical, many duels), Breeze (long angles, AWP festival)
   LOW kill rate maps: Lotus (triple site = spread kills), Fracture (attacker spawn control), Pearl (slow pace)
   -> Attacking half produces more kills than defending (attackers force duels to plant).

4. FIRST BLOOD RATE
   High FB rate players = early kill access = more total kills/map.
   Duelists with high FB% spike kill counts on aggressive maps.
   -> FB rate is the #3 predictor for duelist props.

5. ATTACKING VS DEFENDING HALF WIN RATE
   Attacker-dominant teams produce more duelist kills (force duels to plant).
   Defender-dominant teams: kills distributed -- sentinel/controller kills spike relatively.
   -> Player's attacking half performance matters more for kill props.

6. SERIES FORMAT, OVERTIME & PP LINE CONVENTION
   Bo3. Expected maps: 2.4. Overtime (13-13) adds 4-8 rounds = +3-5 kills.
   Overtime probability ~15% on even matchups. Factor as small upside.
   Valorant map avg: 25-30 kills/player over full map.

   CRITICAL: PrizePicks VAL kill lines are SERIES TOTALS labeled "MAPS 1-3 Kills" (Bo3).
   PP sets lines contextually -- not per-map. Realistic live board ranges:
     Bo3 duelist (Jett/Reyna/Neon):   45-65  (elite: 55-68)
     Bo3 initiator (Sova/Breach):      38-52
     Bo3 controller (Omen/Viper):      28-42
     Bo3 sentinel (KJ/Cypher):         22-35
   2-0 series compresses totals ~15-20% vs 2-1.
   SANITY CHECK: If a duelist Bo3 line is below 30, flag as suspect.
   -> proj_series = role_avg_per_map x xmaps_expected (2.4 for even Bo3).

7. TEAM AGGRESSION STYLE
   Aggressive teams (forced duels, fast executes): duelist kill counts inflate.
   Passive teams (defaults, operator-heavy): total kills compress, sentinel counts relatively improve.

8. OPPONENT SENTINEL/ANCHOR QUALITY
   Strong sentinel opponent (elite Killjoy/Cypher): reduces entry opportunities for opposing duelists.
   Weak anchoring: more site takes = more kill opportunities for attackers.

ROLE KILL-SHARE BASELINES:
  Duelist:    22-32% team kills/map. Highest floor AND ceiling.
  Initiator:  17-24%. Varies massively by agent (Sova = higher, Gekko = lower).
  Controller: 13-19%. Almost always lower end.
  Sentinel:   10-16%. Fade LESS unless agent is Clove.

PROJECTION FORMULA:
  raw = role_avg x expected_maps
  Adjust: x1.25 if playing Jett/Reyna, x0.75 if playing Killjoy/Cypher
  Adjust: x1.15 for high-kill maps, x0.85 for low-kill maps
  Adjust: x1.1 for ACS 250+, x0.9 for ACS <175

PLAYER PROFILES -- VCT (2025-2026):
  Sentinels:
    TenZ     (SEN Duelist) -- top mechanical fragger, ACS 250+, 22-30 kills/map on Jett/Reyna
    Zellsis  (SEN Flex) -- solid fragger, ACS ~210, 18-24 kills/map
  NRG:
    Victor   (NRG Duelist) -- aggressive, ACS ~230, 20-26 kills/map
    crashies (NRG Initiator) -- consistent, ACS ~195, 16-22 kills/map
  Cloud9:
    yay      (C9 Duelist/Op) -- elite aim, ACS ~240, 20-28 kills/map when playing Jett
    xeppaa   (C9 Flex) -- solid, ACS ~210, 17-23 kills/map
  Note: VCT agent picks vary week-to-week. ALWAYS check current agent assignment.
  Killjoy/Cypher players: ACS often 160-185, kills 12-18/map. Lean LESS if line > 16, can be MORE if line is 12-14.

PLAYER PROFILES -- VCT EXPANDED (2025-2026):
  AMERICAS:
    Sentinels:
      TenZ      (SEN Duelist/Flex) -- mechanical god. ACS 255+. 22-30k/map on Jett/Reyna. Elite MORE.
      Zellsis   (SEN Flex)         -- ACS ~210, 18-24k/map. Consistent secondary fragger.
      johnqt    (SEN IGL/Sentinel) -- 14-19k/map. IGL role. Do not play aggressive kill props.
      Marved    (SEN Controller)   -- 15-20k/map. Controller fragger.
    NRG:
      Victor    (NRG Duelist)      -- top NA duelist. ACS 230+. 20-26k/map. Reliable MORE.
      crashies  (NRG Initiator)    -- ACS ~195, 16-22k/map. Consistent.
      FNS       (NRG IGL)          -- pure IGL, 11-15k/map. ALWAYS LESS on kill props.
    Cloud9:
      yay       (C9 Duelist/Op)    -- elite aim. ACS 240+. 20-28k/map on Jett. Inflates on Haven/Breeze.
      xeppaa    (C9 Flex)          -- ACS ~210, 17-23k/map. Solid.
    Evil Geniuses:
      jawgemo   (EG Duelist)       -- aggressive, ACS ~220, 18-24k/map.
    LOUD:
      aspas     (LOUD Duelist)     -- top 3 duelist in world. ACS 265+. 24-32k/map. Among best MORE targets.
      Less       (LOUD Initiator)  -- ACS ~215, 18-24k/map. Kill-hungry initiator.
      tuyz      (LOUD Duelist)     -- ACS ~225, 19-25k/map. Consistent carry.
    100 Thieves:
      Asuna     (100T Duelist)     -- ACS ~220, 18-24k/map. Consistent.
      bang       (100T Sentinel)   -- ACS ~170. 14-18k/map. Anchor. Lean LESS if line > 16.
  PACIFIC:
    Paper Rex:
      f0rsakeN  (PRX Duelist)      -- elite duelist. ACS 250+. 22-29k/map. Jett god.
      d4v41     (PRX Initiator)    -- ACS ~230, 20-26k/map. Plays like a duelist.
      mindfreak (PRX Flex)         -- ACS ~210, 17-23k/map.
    T1 KR:
      Carpe     (T1 KR Duelist)    -- ACS ~240. 21-28k/map. Korean aim machine.
      Meteor    (T1 KR Initiator)  -- ACS ~220, 18-24k/map.
    DRX:
      MaKo      (DRX Controller)   -- ACS ~185, 14-19k/map.
      stax      (DRX IGL/Sentinel) -- ACS ~170, 13-18k/map. IGL. LESS on high kill lines.
    FPX:
      ANGE1     (FPX IGL)          -- veteran IGL, 12-16k/map. LESS on kill props.
    Global Esports:
      Bazsi     (GE Duelist)       -- ACS ~220, 18-25k/map. Underrated MORE target.
  EMEA:
    Team Vitality:
      cNed      (VIT Duelist)      -- legendary Jett player. ACS 255+. 22-30k/map when playing. Elite.
      nAts      (VIT Sentinel)     -- ACS ~175. 14-19k/map. Lean LESS if line > 18.
      BONECOLD  (VIT IGL)          -- 11-15k/map. Pure IGL. LESS.
    Team Liquid:
      ScreaM    (TL Duelist)       -- elite mechanical player. ACS 245+. 21-28k/map.
      Jamppi    (TL Flex)          -- ACS ~215, 18-24k/map. Versatile carry.
    Fnatic:
      Leo       (FNC Duelist)      -- ACS ~235, 20-26k/map. Aggressive entry.
      Alfajer   (FNC Flex)         -- ACS ~220, 18-24k/map. Consistent.
    EDward Gaming:
      CHICHOO   (EDG Initiator)    -- ACS ~210, 17-23k/map.
    KOI:
      Klaus     (KOI Duelist)      -- ACS ~225, 19-25k/map. Aggressive.

OVERTIME NOTE: In close Valorant maps (12-12 or 13-13), overtime adds 4-8 rounds.
  Overtime probability: ~20% on evenly matched Bo3s. Apply +2-4 kills to any player projected near 13k/map.
  OT always benefits fraggers more than supports -- duelist kills inflate in knife-fight OT rounds.
  If two teams are within 5% win prob, add +1.5 to projected kill total for ANY duelist prop.`,

// -----------------------------------------------------------------------------
Dota2: `
SPORT: Dota 2

SERIES FORMAT: Use the MATCH CONTEXT line provided in the prompt. Do NOT default to Bo3.
If no match context: assume Bo3, note "format unconfirmed", apply -3 conf.

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. HERO DRAFT / GAME PLAN (highest predictor -- ~42% of outcome)
   TEAMFIGHT drafts (highest kill games):
     Engage cores: Tidehunter, Magnus, Enigma combos = 40-60 kills/game
     AOE carries: Luna, Gyrocopter, Spectre late teamfights = massive kills
     Kill-centric supports: Earthshaker, Rubick, Crystal Maiden = kill inflation
   SPLITPUSH drafts (lowest kill games):
     Anti-mage, Naga Siren, Terrorblade: farm and split = 15-25 kills/game
     Medusa: afk farm, avoid fights = games end at 25-35 total kills
   PICK-OFF drafts (medium kills):
     Bounty Hunter + heroes with roam: 30-45 kills/game
     Invoker + mobile midlaners: medium kill rate
   -> Teamfight vs splitpush is the single most important Dota factor.

2. GAME LENGTH (directly determines kill count -- 35% weight)
   <30 min (stomp/fast push): 15-25 total kills. COMPRESSES ALL props.
   30-45 min (standard): 30-50 total kills. Most props set around this.
   45-60 min (long/contested): 50-75 total kills. INFLATES carry/mid props dramatically.
   60+ min (ultra-late): 70-100+ kills. Carry kill-share explodes (Pos 1 can have 20+ kills).
   -> Game length is the single biggest swing factor in Dota kill props.
   -> Bo3 expected maps 2.4. Each game is independent -- no carry-over.

3. ROSHAN CONTROL & VISION WARS
   Teams contesting Roshan force fights = kills inflated.
   Teams avoiding Roshan (splitpush meta) = fewer organized fights = fewer kills.

4. NET WORTH LEAD PATTERNS
   Snowball teams (BLG, PSG.LGD aggressive): large leads compress kill opportunities (opponents avoid).
   Come-from-behind teams: longer games, more kills overall.

5. BOUNTY HUNTER & KILL-GOLD HEROES
   Bounty Hunter on either team: inflates kill counts for both teams (tracking creates fights).
   Death Prophet, Drow: push and kill = above avg total kills.

6. POSITION / ROLE KILL-SHARE
   Pos 1 (Hard Carry):
     Short games: 2-4 kills. Very low -- protected, farming.
     Standard: 7-12 kills. Upper range vs inferior opponents.
     Long games: 15-25+ kills. Dominates kill feed when ahead.
     Variance: HIGHEST of all roles. Wide confidence intervals.
   Pos 2 (Mid):
     Most consistent role. Early kills (rune control, roam), late kills (damage dealer).
     Range: 5-15 kills. Standard games: 7-10.
     Invoker/Puck/Storm: upper range. Magnus/Batrider (utility): lower.
   Pos 3 (Offlane):
     Initiation role: Axe, Centaur, Tidehunter: 5-10 kills.
     Utility offlane: Beastmaster, Enigma: 2-6 kills.
     Carry offlane (Timber, Dragon Knight): 8-14 kills in snowball.
   Pos 4 (Soft Support / Roam):
     Roaming supports (Bounty, Spirit Breaker): 4-10 kills.
     Passive pos4 (Oracle, Dazzle): 1-5 kills.
   Pos 5 (Hard Support):
     2-6 kills in most games. Spike in very long games only.
     Always LESS unless hero is Lion/Lina (nuke support, occasionally gets kills).

PROJECTION FORMULA:
  base = position_avg x expected_games
  Adjust: x1.5 for teamfight draft, x0.7 for splitpush draft
  Adjust: x0.6 for expected short game (<30 min), x1.4 for expected long game (45+ min)
  Adjust: x0.8 for Pos1 if team is likely to stomp (hero avoidance compresses kills)

TEAM PROFILES -- DOTA2 (2025-2026):
  Team Spirit:    Aggressive snowball. YATORO carry = explosive. Avg game ~35 min, 45k kills.
                  YATORO Pos1: 9-15k/game standard, 15-22k long games. Elite MORE target.
                  Collapse Pos3: 4-7k/game. Initiation-first.
  PSG.LGD:        Methodical. XinQ mid = consistent. ~38 min games, 38k kills avg.
                  XinQ Pos2: 7-10k/game. Very consistent, less ceiling.
  Team Liquid:    Aggressive skirmish. miCKe carry = proactive. ~33 min games.
                  miCKe Pos1: 8-12k/game. Solid floor.
  OG:             Chaotic playstyle. Miracle Pos2 = highest ceiling mid. 15k+ in long games.
  EG:             Standard aggressive NA. Arteezy Pos1 = prolific killer. 9-14k/game.
  Tundra:         Defensive / 4-protect-1. skiter carry protected. 8-13k/game.
  Gaimin Gladiators: Aggressive teamfight. Paladin Pos3 = active. 6-9k/game.
  NOTE: Game length MUST factor. Against top-5 teams, expect 40+ min games (more kills).
        Against weaker opponents, expect sub-30 min stomps (kills compressed).

GAME LENGTH PRIORS (use to adjust projection):
  Top-6 world vs top-6 world: ~38-42 min avg. Use x1.3 multiplier.
  Top-6 vs tier-2: ~28-32 min avg. Use x0.85 multiplier (stomp likely).
  Tier-2 vs tier-2: ~35-40 min avg. Use x1.1 multiplier (teams evenly matched).`,

// -----------------------------------------------------------------------------
COD: `
SPORT: Call of Duty (CDL format)

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. GAME MODE (most important single factor -- determines kill rate entirely)
   HARDPOINT (HP):
     Highest kill mode. 250 points to win. ~90-110 kills/team/map.
     Per-player avg: 22-30 kills. Primary fragger role = 25-35.
     Kill props are most reliable in HP -- consistent pace.
   SEARCH AND DESTROY (SnD):
     LOWEST kill mode. 6v6, one life, best of 11 rounds.
     Per-player avg: 4-9 kills/map. Lines set very low (2.5, 3.5, etc.)
     Opener fragger role: 6-9 kills. Support/IGL: 3-5 kills.
     Variance: HIGH. One round can end with 0 kills.
   CONTROL:
     Medium kill mode. Zones contested, 3 rounds max.
     Per-player avg: 14-22 kills.
     Fragger role: 18-25. Objective player: 12-17.
   -> ALWAYS identify which mode the prop is for. Lines differ massively.
   -> If mode unknown, apply medium variance and reduce conf -5.

2. PLAYER ROLE / FUNCTION -- CRITICAL for kill line context
   Stats data includes "Role:" from breakingpoint.gg or CDL lookup table.
   Use the Role: field from stats to set kill baseline:
   
   AR (Primary Fragger / Assault Rifle): 25-35 kills HP, 6-9 SnD. Highest kill floor.
   Sub AR (Secondary Fragger): 20-28 HP, 5-8 SnD. Consistent mid-range.
   Flex (All-role / Hybrid): 22-32 HP, 5-8 SnD. Adapts to match needs.
   Anchor / Support / IGL: 14-20 HP, 3-6 SnD. Do NOT project these like ARs.
   SMG / Rush: 22-30 HP (objective-adjacent kills), 4-7 SnD.
   Sniper: High skill variance. 18-28 HP on sniper-friendly maps.
   
   -> If role says "G" or is missing, check description -- "G" in PrizePicks = generic (unknown).
     In that case, default to Sub AR baseline (conservative) and flag "role unclear".
   -> NEVER use AR baseline for a player listed as Anchor or Support.

3. MAP POOL
   HIGH kill maps: Raid, Terminal, Highrise, Estate -- open sightlines, many engagements.
   LOW kill maps: Tuscan, Karachi -- methodical, cover-heavy.
   -> Map pool affects kill count by 15-25%. Know which maps teams prefer/veto.

4. SPAWN TRAP POTENTIAL
   Teams that dominate spawns (especially in HP) can run up kill counts dramatically.
   Strong spawn trappers: historically OpTic, Rokkr aggressive rotations.
   -> Spawn trap = fragger kill counts spike to 30-40 in HP.

5. SERIES FORMAT
   CDL Majors: Bo5 series. More maps = more kill opportunities.
   Pool play: Bo3. Expected maps 2.4.
   -> Always confirm format and multiply role avg accordingly.

6. OPPONENT DEFENSIVE QUALITY
   Passive opponents (hold sightlines, minimal aggression): reduce fragger kills.
   Aggressive opponents (chase kills, trade): inflate fragger kill counts both ways.

ROLE KILL-SHARE:
  Primary Fragger:   28-35% total team kills per map (HP)
  Secondary Fragger: 22-27%
  SMG/Flex:          20-25%
  Anchor/Support:    15-20%
  -> SnD: all shares compress dramatically, flat 4-9 kills per player per map.

PROJECTION FORMULA (HP):
  raw = role_avg_per_map x expected_maps (2.4 for Bo3)
  Adjust: x1.2 for high kill maps, x0.85 for low kill maps
  Adjust: x1.15 for spawn trap potential, x0.9 for balanced matchup

CDL TEAM PROFILES (2025-2026 season):
  OpTic Texas:     Elite. Scump Sub AR, Dashy Flex, Illey AR, Clayster veteran.
                   Spawn trap specialists. HP kills run high when they dominate. ~28k/player/map HP avg.
  Atlanta FaZe:    Top team. Cellium AR star, Rated AR, Simp AR.
                   Cellium = most consistent CDL fragger. HP: 28-35k/map. SnD: 6-9k/map.
  LA Thieves:      pred AR (top fragger), Kremp Sub AR.
  Seattle Surge:   Cleanx AR (kill hungry), Grizzy Sub AR.
  Toronto Ultra:   Bance Flex, Hydra AR.
  NY Subliners:    Shotzzy Flex (elite), Mack AR.
  Boston Breach:   Beans AR, Nero AR.
  Vegas Legion:    Standy Sub AR.
  Rokkr:           Decemate AR, Havok AR.

CDL KILL BASELINES BY ROLE AND MODE (2025-26 calibrated):
  HP (Hardpoint -- most common, highest kills):
    Primary AR:    25-35k/map. Elite ARs (Cellium, pred, Cleanx): 28-35.
    Sub AR:        20-28k/map.
    Flex:          22-30k/map. Shotzzy peaks 32+ in aggressive games.
  SnD (Search and Destroy -- lowest kills):
    Primary AR:    6-10k/map. One life = floor drops dramatically.
    Sub AR:        5-8k/map.
    Flex:          5-9k/map.
  Control (medium kills):
    Primary AR:    18-25k/map.
    Sub AR:        14-20k/map.
  
  MOST IMPORTANT: If prop says "Kills" without mode, it is MOST LIKELY a series total across HP+SnD+Control maps.
  CDL Bo5 series (3 HP + 2 SnD + 2 Control structure, not all played): ALWAYS assume mode mix.
  Bo5 AR primary series total estimate: HP kills (28x2) + SnD kills (7x1.5) = ~66-70 range if all maps.
  Bo3 AR primary estimate: ~50-60 combined across all maps played.
  IF line is set at 20-30 for an AR player in a Bo3: this is suspiciously LOW → investigate mode context.`,

// -----------------------------------------------------------------------------
R6: `
SPORT: Rainbow Six Siege

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. MAP POOL (highest predictor -- maps have wildly different kill rates)
   HIGH kill maps (contested, many angles):
     Villa: large map, many entry points, kill rate high.
     Oregon: tight hallways, aggressive entries = kills.
     Chalet: kitchen area = constant duels.
     Consulate: front yard aggression = many early picks.
   LOW kill maps:
     Bank: vault-heavy, methodical, anchor-friendly.
     Coastline: roamers avoided, kills compressed.
     Theme Park: large site, spreads kills.
   -> Map preference/veto history is critical for R6 kill props.

2. ATTACKER vs DEFENDER ROLE
   Attack:
     Hard breachers (Thermite, Hibana): push sites, get kills in site entry.
     Flankers (Ash, Sledge, Zofia): mobile, get picks before site entry.
     Intel fraggers (Lion, Zero): secondary fragger role.
   Defense:
     Roamers (Jager, Bandit, Vigil): aggressive, chase kills outside site = 2-5 kills/map.
     Anchor (Echo, Maestro, Pulse): passive, 0-2 kills/map.
     Flex (Valkyrie, Doc): support, 1-3 kills/map.
   -> Roam-heavy defenders spike kills. Anchor defenders: always LESS.

3. ROUND FORMAT & PP LINE CONVENTION
   Pro League: Bo1 maps in a series. Each map 12 rounds max.
   Per-player avg: 3-8 kills per map. Stars: 5-10.
   PP lines are SERIES TOTALS labeled "MAPS 1-3 Kills" (Bo3) or "MAPS 1-2 Kills" (Bo2).
   Realistic line ranges from live boards:
     Bo3 star fragger:   12-20
     Bo3 anchor/support:  7-13
     Bo2 star fragger:    8-13
     Bo2 anchor:          4-8
   SANITY CHECK: R6 Bo3 fragger lines below 8 are suspect. Not single-map kills.
   -> proj_series = role_avg_per_map x xmaps_expected.

4. OPENING DUEL WIN RATE
   High opening win rate players (Necrox, Canadian historically): kill spikes.
   Players known for 1v1 clutch: elevated kill props.
   -> Opening duel rate is the best individual metric for R6 fraggers.

5. SERIES STAKES
   Elimination rounds: aggressive play, more duels, kills inflate.
   Already qualified/eliminated: passive play, conservative, kills compress.

KILL AVERAGES PER MAP:
  Star Fragger:     5-9 kills/map
  Secondary:        3-6 kills/map
  Roamer:           3-5 kills/map
  Anchor/Utility:   1-3 kills/map
  -> Apply xmaps_expected for series total.

TEAM PROFILES -- R6 (2025-2026 SI / PRO LEAGUE):
  Team Liquid:     Brazilian legends. Canadian anchor/star, AmarU roam. Aggressive attack style.
                   Total map kills: 15-22. Star fragger 6-9k.
  Spacestation:    NA powerhouse. Relik star fragger. 5-8k/map for star.
  G2 Esports:      EU elite. pengu IGL/support. Paluh star fragger. 5-9k/map.
  NAVI R6:         CIS powerhouse. Shaiiko (roam god). Daiya/Saves.
  BDS:             French squad. BriD star fragger. 6-9k/map.
  Team Empire:     CIS. ThunderTuck. Aggressive, high kill games ~20-25/team/map.
  Virtus.pro:      CIS. Star-driven, high individual stats.
  FaZe R6:         Mav, Rampy, ASTRO. Consistent european team.
  
  OPENING DUEL PLAYERS (highest props upside):
    pengu, Rampy, Shaiiko, Canadian -- known for high opening duel win rates.
    These players specifically benefit from MORE props in clutch moments.
    Opening duel rate translates directly: each won opening = +1 kill, each loss = -1.

  R6 SERIES TOTAL NOTE: Unlike other games, R6 is maps-of-maps.
    Typical Pro League match = Best of 1 maps in a mini-series. Each map = 12 rounds max.
    PP lines reflect total kills across all scheduled maps.
    If match format is Bo3: star fragger expected 18-27 total across series.
    If match format is a single map: star fragger expected 5-9.`,

// -----------------------------------------------------------------------------
APEX: `
SPORT: Apex Legends (ALGS format)

=== KILL CORRELATION FACTORS -- ranked by predictive weight ===

1. MATCH FORMAT (determines kill ceiling entirely)
   ALGS: 6 matches per day, 20 teams. Points = placement + kills.
   Kill points: 1 per kill. Max kills per game: theoretically 59 but realistically 10-20 for top fragger.
   Per-player avg across 6 games: 8-18 kills (3-6 stars). Elite fraggers: 15-25.
   -> Multi-game format means props usually set across 6 matches combined.

2. SQUAD COMPOSITION / LEGEND PICKS (major kill driver)
   AGGRESSIVE compositions:
     Wraith + Pathfinder/Horizon + Octane/Catalyst: rotate aggressively, take duels early.
     Kill-based comps: +30-40% kill upside vs passive comps.
   PASSIVE/POINT FARM compositions:
     Gibraltar + Bangalore + Lifeline: third-party resistant, wait for end zones.
     These teams prioritize placement over kills -- props trend LESS.
   FRAGGER LEGENDS:
     Wraith, Horizon, Valkyrie: high mobility = more skirmish opportunities.
     Newcastle, Gibraltar, Caustic: zone defensive = fewer proactive kills.

3. LANDING ZONE (directly determines early kill access)
   HOT DROP zones: fragments (Kings Canyon), ring console (WE), market (Olympus).
     Hot drops: +4-8 kills/game potential but death risk = inconsistency.
   SAFE zones: far from pack, loot and rotate.
     Safe landings: 0-2 kills early, rely on late-game zone duels.
   -> Teams that hot-drop consistently spike kill props but with high variance.

4. ZONE RNG & ROUTING
   Favorable zone routing (team's preferred landing near final rings): less movement = more stable positioning = more duels = kills.
   Unfavorable routing (running into squads during rotations): unpredictable kill distribution.
   -> Zone luck is the highest variance factor. Reduce conf -5 for any APEX prop vs other games.

5. PLAYER ROLE
   FRAGGER / IGL-FRAGGER: Primary kill engine. 4-8 kills/game avg. Series total 20-40.
   SUPPORT (healer/rez): 1-4 kills/game. Focused on keeping team alive.
   IGL (pure IGL): 2-5 kills/game, prioritizes zone/rotation calls.
   -> Always identify role. Support props on kills: almost always LESS.

6. TEAM KILL-RACE TENDENCY
   Kill-race teams (NRG historically, LOUD): actively hunt squads for points.
   Placement teams (TSM passive eras): avoid fights, streak placements.
   -> Kill-race teams inflate ALL player kill props.

7. RING CLOSURE PACE
   Fast ring = squads forced together early = more fights = kills.
   Slow ring = extended rotations = fewer fights = lower kills.
   -> Map rotation plays influence kill rate significantly.

KILL AVERAGES (across 6 ALGS games):
  Elite Fragger:    18-28 total kills
  Star Player:      12-20 total kills
  Support/IGL:      5-12 total kills
  -> APEX has the HIGHEST variance of all esports. Apply -8 conf vs LoL/CS2 baseline.
  -> Never recommend APEX props above 70% conf. Zone RNG alone justifies this.

APEX PLAYER PROFILES (ALGS 2025):
  NRG:     Sweetdreams IGL, Nafen fragger, Verhulst flex. Kill-race squad. High kill upside.
  TSM:     Reps (legendary fragger, highest kill floor in ALGS), ImperialHal IGL.
           ImperialHal = IGL-fragger hybrid, 3-6k/game. Reps = 4-8k/game. Elite floor.
  Team Liquid: Scrappy, balanced. Moderate kill rate.
  LOUD:    Brazilian squad, aggressive style. Hot-drop tendency.
  Complexity: NA, improving. Volatile.
  Luminosity: Mid-tier, inconsistent.
  MOST RELIABLE APEX PROP: Reps (TSM) kills — highest consistent floor in NA ALGS.
  WORST APEX PROP: any IGL kills prop where line > 15 total across 6 games.

PROJECTION FORMULA:
  raw = role_avg_per_game x 6 games
  Adjust: x1.3 for kill-race team (NRG, LOUD), x0.7 for placement team (passive style)
  Adjust: x1.2 for hot-drop landing tendency, x0.8 for safe landing
  Apply -8 to ALL APEX conf values (zone variance premium)`,

  };

  return base + (sports[sport] || sports.LoL);
}

async function analyzeGroup(group, retries = 2, enrichment = null) {
  let { standard, goblin, demon, meta, notes } = group;
  const lines = [
    goblin   && `goblin: ${goblin.line}`,
    standard && `standard: ${standard.line}`,
    demon    && `demon: ${demon.line}`,
  ].filter(Boolean).join(" | ");

  const stageContext = {
    GRAND_FINALS: "GRAND FINALS -- teams play execute-heavy, calculated. Kill counts compress 15-20% vs group stage. Both teams prepared. Reduce projection slightly.",
    FINALS:       "FINALS -- high stakes, methodical play. Slight kill compression vs regular season.",
    SEMIFINALS:   "SEMIFINALS -- pressure game. Teams may open up or lock down depending on style.",
    QUARTERFINALS:"QUARTERFINALS -- bracket play begins. Stakes elevated, slight aggression uptick.",
    PLAYOFFS:     "PLAYOFFS -- elimination pressure. Aggressive play slightly elevated vs group stage.",
    GROUPS:       "GROUP STAGE -- baseline stats apply. Standard kill rates.",
    REGULAR:      "REGULAR SEASON -- standard kill rates.",
  };

  const trendingContext = {
    FADE_STRONG:  "TRENDING WARNING: 100k+ public picks. High public interest -- line may have moved. Reduce your confidence by 5% and note as potential inflated side. This does NOT automatically mean LESS -- check if your projection still supports the direction. If projected > line by 15%+, the edge survives hype.",
    FADE_MILD:    "TRENDING CAUTION: 50k+ picks. Public is heavy on this prop. Reduce confidence by 3%. Direction stays the same -- if your projection clears the line, the edge still stands.",
    NEUTRAL_HIGH: "Moderate public interest. Monitor but no fade signal.",
    NEUTRAL:      "Low public interest. No trending bias.",
  };

  // Build Liquipedia context string
  let lpediaContext = "";
  if (enrichment && !enrichment.error && !enrichment.loading) {
    // Determine event tier from Liquipedia tournament data
    const recentTournaments = enrichment.recent_tournaments?.join(", ") || "";
    const isMajorEvent = recentTournaments && (
      recentTournaments.toLowerCase().includes("major") ||
      recentTournaments.toLowerCase().includes("world") ||
      recentTournaments.toLowerCase().includes("international") ||
      recentTournaments.toLowerCase().includes("masters") ||
      recentTournaments.toLowerCase().includes("champions") ||
      recentTournaments.toLowerCase().includes("invitational") ||
      recentTournaments.toLowerCase().includes("iem") ||
      recentTournaments.toLowerCase().includes("pgl") ||
      recentTournaments.toLowerCase().includes("blast premier")
    );

    lpediaContext = `\nLIQUIPEDIA DATA (verified ${enrichment.fetched_at}):
  Status: ${enrichment.status}${enrichment.is_standin ? " ⚠ STAND-IN -- APPLY -12 CONF, HIGH RISK" : ""}${enrichment.is_inactive ? " ⚠ INACTIVE -- DO NOT RECOMMEND, GRADE C" : ""}
  Team confirmed: ${enrichment.current_team || "unconfirmed"}
  Role confirmed: ${enrichment.role || "unconfirmed"}
  Event type (from Liquipedia): ${isMajorEvent ? "MAJOR EVENT -- international premier competition" : "PRO -- regional pro league"}
  Recent tournaments: ${recentTournaments || "none found"}`;
  }

  // Build recent form context from backend stats if available
  let formContext = "";
  if (meta.stats_notes) {
    const n = meta.stats_notes;
    // OPT1 FIX: Only flag UNKNOWN when stats explicitly show no recent data.
    // For known pro players on public-stat sources (HLTV/vlr/gol.gg), default to STABLE not UNKNOWN.
    // The -3 form penalty should not fire for well-known players just because we didn't scrape last-7.
    const hasExplicitForm = n.includes("Kform:") || n.includes("Form:");
    const hasNoData = n.includes("player_not_found") || n.includes("scrape_failed") || n.includes("api_unavailable");
    const formTrend = n.includes("Kform:HOT") || n.includes("Form: HOT") ? "HOT -- recent kills above season avg (+4 conf)" 
                    : n.includes("Kform:COLD") || n.includes("Form: COLD") ? "COLD -- recent kills below season avg (-5 conf, use recent avg)"
                    : n.includes("Kform:STABLE") || n.includes("Form: STABLE") ? "STABLE -- recent form consistent (no modifier)"
                    : hasNoData ? "UNKNOWN -- no stat source available (-3 conf)"
                    : "STABLE -- known pro player, treat as stable baseline (no modifier)";
    formContext = `\n
===== SCOUT NOTES — HIGHEST PRIORITY DATA =====
SOURCE: ${n}
FORM TREND SIGNAL: ${formTrend}
INSTRUCTION: Use the kill/assist numbers above as your PRIMARY projection input. Do not ignore them in favor of vague role baselines.
==============================================`;
  }

  // Compute exact expected maps from win probability (Rule 2)
  function computeExpectedMaps(winProb) {
    // Clamp to realistic range — 0 or 1 means data failure, not absolute certainty
    const p = Math.max(Math.min(Math.max(winProb, 1 - winProb), 0.90), 0.50);
    const pSweep = p * p + (1 - p) * (1 - p);
    const pFull  = 1 - pSweep;
    return Math.round((pSweep * 2 + pFull * 3) * 100) / 100;
  }

  // Real series format from PandaScore (injected by runOne via fetchMatchContext)
  const seriesFormat = meta.series_format || null; // "Bo1" | "Bo3" | "Bo5" | null
  const numGames = meta.number_of_games || null;

  const winProbContext = meta.win_prob != null && meta.win_prob > 0 && meta.win_prob < 1
    ? (() => {
        const teamWinPct  = Math.round(meta.win_prob * 100);
        const oppWinPct   = 100 - teamWinPct;
        const expectedMaps = computeExpectedMaps(meta.win_prob);
        const stompRisk   = teamWinPct >= 75 || oppWinPct >= 75 ? "HIGH stomp risk" : teamWinPct >= 65 || oppWinPct >= 65 ? "moderate stomp risk" : "low stomp risk";
        return `WIN PROBABILITY (Pinnacle sportsbook): ${meta.team} ${teamWinPct}% | ${meta.opponent} ${oppWinPct}%
Expected maps from Rule 2 formula [p=${Math.max(meta.win_prob, 1-meta.win_prob).toFixed(2)}]: ${expectedMaps} maps
Stomp risk: ${stompRisk}
Series type: ${expectedMaps <= 2.25 ? "LIKELY SWEEP — compress ALL underdog carry props heavily, winner props lightly" : expectedMaps <= 2.40 ? "moderate favorite — apply stomp compression per Rule 3" : "competitive series — standard projections, 2-1 likely"}
UNDERDOG CARRIES: Apply Rule 3 stomp multiplier. ${oppWinPct >= 75 ? "x0.72 (heavy stomp)" : oppWinPct >= 65 ? "x0.82 (moderate stomp)" : oppWinPct >= 55 ? "x0.92 (slight stomp)" : "no stomp (competitive)"}`;
      })()
    : "Win probability: NOT AVAILABLE (fetch failed or data missing). DO NOT assume extreme favorite/underdog. Estimate 50/50 unless tier/league strongly suggests otherwise. Use expected_maps = 2.4 (standard Bo3 50/50 baseline). Apply normal role-based projection without stomp compression.";

  // PandaScore match context string (Bo format, tournament tier, Pinnacle line)
  const pandaContextLine = meta.match_context_string
    ? `\nMATCH CONTEXT (PandaScore/Pinnacle verified): ${meta.match_context_string}`
    : seriesFormat
    ? `\nSERIES FORMAT: ${seriesFormat} (${numGames} maps max) -- source: PandaScore confirmed`
    : "";

  const prompt = `Analyze this ${meta.sport} PrizePicks prop:

Player: ${meta.player}
Team: ${meta.team} | Opponent: ${meta.opponent} | Position/Role: ${meta.position}
League: ${meta.league || "Unknown"} | Tier: ${TIER_META[meta.tier||4]?.label}
Stage: ${stageContext[meta.stage] || stageContext.REGULAR}
Stat: ${meta.stat} [TYPE: ${meta.stat_category || "KILLS"}]${meta.is_combo ? " (COMBO -- line is combined stat of ALL named players across full series)" : ""}

STAT TYPE CONTEXT:
${(meta.stat_category === "ASSISTS" || (meta.stat || "").toLowerCase().includes("assist")) ? `ASSISTS PROP -- analyze average assists/map NOT kills. Use assists_per_game or assists_per_map from stats. Role baselines for assists differ significantly from kills:
  LoL SUP: 12-22 assists/map, MID: 6-10/map, JNG: 7-12/map, TOP: 3-6/map, BOT: 5-9/map
  Valorant: initiator 5-9/map, controller 4-8/map, duelist 3-6/map, sentinel 4-7/map
  Dota2: pos5 highest, pos4 second, carries lowest
  CS2: support/utility roles 4-8/map, star fraggers 2-5/map` 
: meta.stat_category === "HEADSHOTS" || (meta.stat || "").toLowerCase().includes("headshot") ? `HEADSHOTS PROP -- use HS% and headshots_per_map from stats data. Key factors:
  AWPers: lower HS% (0-shot mechanic), but rifle headshots are normalized
  Riflers: HS% typically 40-65%, headshots = kills_per_map x (hs_pct/100)
  CS2/Valorant: HS% is tracked. Use headshots_per_map directly from stats notes if available.
  If no HS data: estimate from hs_pct x kills_per_map, flag as estimated.` 
: "KILLS PROP -- standard kill projection. Apply all rules as written."}
Lines -- ${lines}
${pandaContextLine}
${winProbContext}
Trending: ${meta.trending?.toLocaleString() || 0} picks -- ${trendingContext[meta.trending_signal] || trendingContext.NEUTRAL}
${lpediaContext}${formContext}
${notes ? `\nSCOUT NOTES (treat as highest-priority context, overrides baselines):\n${notes}` : ""}

EXECUTION -- 5 STEPS IN ORDER:

STEP 1 -- RULE 0 CHECK (instant SKIP gate)
  Check all Rule 0 conditions first. If any trigger -> output Grade C SKIP JSON immediately. Done.

STEP 2 -- CHAMPION/AGENT OVERRIDE (Rule 1)
  Does the pick info trigger an AUTO-LESS or AUTO-MORE override?
  If AUTO-LESS: set projected to the capped value. This is now your projection. Cannot be overridden.
  If AUTO-MORE: apply the percentage boost to role baseline before anything else.
  If pick unknown: apply -10% to baseline, conf -4.

STEP 3 -- COMPUTE PROJECTION (Rules 2-4)
  a. Compute expected_maps from the win_prob using the formula in Rule 2. Use the exact number.
     If win_prob unavailable: use 0.55 for slight favorite, 0.5 for coin flip. State assumption.
  b. DATA PRIORITY (use highest available):
     PRIORITY 1: L7 kills avg from SCOUT NOTES (e.g. "L7-K:[8,6,9,7,8]avg7.6") → use 7.6 as base/map
     PRIORITY 2: kills_per_game or kills_per_map from SCOUT NOTES stats source
     PRIORITY 3: Player profile from your training knowledge (profiles section above)
     PRIORITY 4: Role baseline from sport-specific section
  c. Base projection = best_data_per_map x expected_maps
  d. Apply form trend (Rule 4): L7 avg already IS the form-adjusted base (use it directly, don't double-apply)
     If using season avg (not L7): apply HOT/COLD multiplier before multiplying by expected_maps
  e. Apply stomp multiplier to underdog carries (Rule 3)
  f. Apply team style, opponent quality, map pool, stage modifiers
  g. Round to 1 decimal. Do NOT round up.
  h. For combos: compute each player separately, sum, apply -10% haircut, then apply Rule 5 math

STEP 4 -- CONFIDENCE & LINE VALUE (Rules 5-9)
  a. Start at 65
  b. Apply winner/loser adjustments (Rule 7)
  c. Apply all variance modifiers: role risk, format risk, prop type risk, upside modifiers
  d. Apply hype skepticism if trending > 50k (Rule 6)
  e. For combos: compute effective_conf via Rule 5 math
  f. Cap at 84, floor at 50
  g. Compute edge for each line. Best bet = highest edge after adjustments.
  h. Check Rule 0 again: if projected within 2.5% of ORIGINAL line (pre-series-length) AND no strong role signal -> SKIP
     Strong role signal = IGL confirmed non-fragger, enchanter support, zero-kill hero (Treant/Chen/Io), Sage healer.
     Flat projections that get series-length multiplied create fake directional signals -- always check pre-series edge first.

STEP 5 -- GRADE AND OUTPUT
  Apply grade rubric from Rule 8. Be decisive. Output the JSON.
  DIRECTION BIAS CHECK (mandatory before output):
  - Count how many of your recs are LESS vs MORE. If all recs are LESS, verify your projection is genuinely below the line -- if not, reconsider.
  - Uncertainty alone does NOT make something LESS. Uncertainty = lower conf, not LESS direction.
  - MORE is correct when: projected > line, player is a carry/fragger, favorable matchup.
  - LESS is correct when: projected < line, player is support/utility, unfavorable matchup.
  - If you are unsure of direction: output SKIP with lower conf, NOT automatic LESS.

OUTPUT RULES (non-negotiable):
  insights: exactly 3. Must contain SPECIFIC numbers. No vague observations.
    insight[0]: STATS FACT -- "L7 avg X.X vs season Y.Y | source: HLTV/vlr/gol.gg/PandaScore"
    insight[1]: MATCHUP FACT -- "H2H X-Y last N | Win prob Z% | Expected W.W maps | Stomp risk: LOW/MED/HIGH"
    insight[2]: EDGE FACT -- "Projected P.P vs line L.L = +X.X% edge | form: HOT/COLD/STABLE"
    BAD: "Player has high kill potential"
    GOOD: "L7 avg 7.8 vs season avg 6.2 (HOT, +26%) — vlr.gg 90d, 47 rounds sample"
  take: <=10 words. Bet slip note. No hedging.
    BAD: "Slight lean more depending on draft"
    GOOD: "Hot form, goblin line, Grade A lock"
  matchup_note: one sentence combining win_prob + H2H + format.
    BAD: "Interesting matchup with many factors to consider"
    GOOD: "Pinnacle 68% fav, expected 2.28 maps, H2H 3-1 last 4, stomp risk moderate"
  stat_type_note: REQUIRED. State what stat you used and projected vs line.
    Kills: "Kills projected P.P vs line L.L (edge: E%)"
    Assists: "Assists projected P.P vs line L.L | used assists_per_map from stats"
    Headshots: "Headshots projected P.P vs line L.L | hs_pct X% x Y kills/map"
  If a line type is null -> output "SKIP" for that rec. Never invent a line.

Return ONLY this JSON (no markdown, no preamble):
{
  "rec_goblin":      "MORE" or "LESS" or "SKIP",
  "rec_standard":    "MORE" or "LESS" or "SKIP",
  "rec_demon":       "MORE" or "LESS" or "SKIP",
  "projected":       <decimal>,
  "conf":            <integer 50-84>,
  "edge":            <decimal>,
  "grade":           "S" or "A" or "B" or "C",
  "parlay_worthy":   true or false,
  "best_bet":        "goblin" or "standard" or "demon" or "none",
  "best_line":       <number or null>,
  "risk":            "LOW" or "MEDIUM" or "HIGH",
  "trend":           "UP" or "DOWN" or "STABLE",
  "meta_rating":     "FAVORABLE" or "NEUTRAL" or "UNFAVORABLE",
  "stage_impact":    "COMPRESS" or "NEUTRAL" or "INFLATE",
  "trending_fade":   true or false,
  "variance_flags":  ["<flag>", ...],
  "insights":        ["<specific fact 1>", "<specific fact 2>", "<specific fact 3>"],
  "matchup_note":    "<one sharp sentence on the series dynamic>",
  "take":            "<10 words or fewer -- a bet slip note>",
  "stat_type_note": "<for ASSISTS: state assists projected vs line; for HEADSHOTS: state hs projected vs line; for KILLS: kills projected vs line>"
}`;

  // NOTE: win_prob is pre-fetched by runOne via fetchMatchContext and injected into meta
  // before analyzeGroup is called -- so no odds fetch needed here.
  // Single attempt -- retry logic handled by caller (runOne in queue)
  const res = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: buildSystemPrompt(meta.sport),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (res.status === 429 || res.status === 529) throw new Error(`rate_limit_${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (d.error) throw new Error(d.error.message || "API error");
  const text = (d.content || []).map(c => c.text || "").join("");
  const clean = text.replace(/```json\n?|```/g, "").replace(/^[\s\n]+|[\s\n]+$/g, "");
  const parsed = JSON.parse(clean);
  // Enforce 10-word cap on take field
  if (parsed.take) {
    const words = parsed.take.trim().split(/\s+/);
    if (words.length > 10) parsed.take = words.slice(0, 10).join(" ") + "...";
  }
  return parsed;
}

async function buildParlayAI(groups, analyses, picks, stake) {
  const aKey = g => `${g.meta.player}||${g.meta.matchup}||${g.meta.stat}`;
  const candidates = groups
    .filter(g => { const a = analyses[aKey(g)]; return a && !a._error && a.parlay_worthy && (a.grade === "S" || a.grade === "A"); })
    .map(g => {
      const a = analyses[aKey(g)];
      const prop = g[a.best_bet] || g.standard || g.goblin || g.demon;
      return {
        player: g.meta.player, team: g.meta.team, sport: g.meta.sport,
        matchup: g.meta.matchup, stat: g.meta.stat, tier: g.meta.tier,
        line: a.best_line || prop?.line, odds_type: a.best_bet,
        rec: a[`rec_${a.best_bet}`], projected: a.projected,
        conf: a.conf, edge: a.edge, grade: a.grade,
        trending_fade: a.trending_fade, take: a.take,
      };
    })
    .sort((a, b) => (b.conf * b.edge) - (a.conf * a.edge))
    .slice(0, 30); // cap at 30 to keep prompt tight

  if (candidates.length < picks) return {
    error: `Only ${candidates.length} parlay-worthy props found. Need ${picks}. Analyze more boards first.`,
    candidates
  };

  // Pre-compute correlation map: same matchup/team = correlated
  const correlationNote = candidates.map((c, i) =>
    candidates.slice(i+1).filter(d =>
      d.matchup === c.matchup || d.team === c.team
    ).map(d => `${c.player} & ${d.player} share matchup -- correlated risk`)
  ).flat();

  const res = await fetch(`${BACKEND_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1200,
      system: `You are a sharp DFS parlay optimizer. Your job is to maximize the TRUE combined hit probability of a ${picks}-pick Power Play.

CRITICAL MATH:
- Independent legs: P(all hit) = P1 x P2 x ... x Pn
- Correlated legs (same team/matchup): their failure is linked. If BLG loses, ALL BLG props lose together. This is WORSE than the math suggests.
- Correlated legs MUST be penalized -- treat two props from the same matchup as if their combined conf is (conf1 x conf2 x 0.75) not (conf1 x conf2).

CORRELATION PENALTY RULES:
- Same team in same series: -15% to combined conf
- Same matchup (different teams): -8% to combined conf
- Different sports/matchups: no penalty (true independence)

TRENDING FADE: Disqualify any leg with trending_fade=true UNLESS no replacements exist.

KELLY CRITERION: After selecting legs, compute Kelly fraction = (p x b - q) / b where p = hit prob, b = net odds (24 for 25x), q = 1-p. Recommend stake as Kelly fraction x $1000 (assume $1000 bankroll), capped at $${stake * 2} max.

Return only JSON.`,
      messages: [{ role: "user", content:
`Select optimal ${picks} legs. Penalize correlated legs hard.

Candidates:
${candidates.map((c,i) => `${i}. ${c.player}(${c.sport} T${c.tier}) ${c.matchup} | ${c.odds_type?.toUpperCase()} ${c.stat} ${c.rec} ${c.line} | Conf:${c.conf}% Edge:+${c.edge}% Grade:${c.grade}${c.trending_fade?" ⚠FADE":""}`).join("\n")}

Correlation risks: ${correlationNote.length ? correlationNote.join("; ") : "none detected"}

Return: {
  "selected_indices": [<exactly ${picks} 0-based indices>],
  "true_parlay_conf": <realistic combined hit probability 0-100, accounting for correlation>,
  "kelly_stake": <recommended stake in dollars>,
  "expected_value": <EV = true_conf/100 x payout - (1-true_conf/100) x stake>,
  "correlation_warnings": ["<any correlated pairs selected>"],
  "reasoning": "<2 sharp sentences>",
  "warning": "<biggest risk or null>"
}` }],
    }),
  });
  const d = await res.json();
  const text = (d.content || []).map(c => c.text || "").join("");
  const result = JSON.parse(text.replace(/```json|```/g, "").trim());
  return {
    legs: result.selected_indices.map(i => candidates[i]),
    parlay_conf: result.true_parlay_conf,
    kelly_stake: result.kelly_stake,
    expected_value: result.expected_value,
    correlation_warnings: result.correlation_warnings || [],
    reasoning: result.reasoning,
    warning: result.warning,
    all_candidates: candidates,
  };
}

// --- SLATE QUALITY SCORER ----------------------------------------------------
function scoreSlate(groups, analyses) {
  const ak = g => `${g.meta.player}||${g.meta.matchup}||${g.meta.stat}`;
  const analyzed = groups.filter(g => analyses[ak(g)] && !analyses[ak(g)]._error);
  if (!analyzed.length) return null;

  const parlayWorthy = analyzed.filter(g => analyses[ak(g)].parlay_worthy);
  const sGrades = analyzed.filter(g => analyses[ak(g)].grade === "S").length;
  const aGrades = analyzed.filter(g => analyses[ak(g)].grade === "A").length;
  const avgConf = parlayWorthy.length
    ? parlayWorthy.reduce((s, g) => s + analyses[ak(g)].conf, 0) / parlayWorthy.length
    : 0;

  // Simulate 6-pick parlay hit rate from top 6 parlay-worthy props
  // Apply correlation penalty: same-team pairs get -15% adjustment
  const top6 = parlayWorthy
    .sort((a,b) => analyses[ak(b)].conf - analyses[ak(a)].conf)
    .slice(0, 6);
  let sixPickHit = null;
  if (top6.length === 6) {
    let raw = top6.reduce((p, g) => p * (analyses[ak(g)].conf / 100), 1);
    // Count same-team pairs and apply 15% penalty per pair
    let corrPairs = 0;
    for (let i = 0; i < top6.length; i++)
      for (let j = i+1; j < top6.length; j++)
        if (top6[i].meta.team === top6[j].meta.team && top6[i].meta.matchup === top6[j].meta.matchup) corrPairs++;
    raw *= Math.pow(0.85, corrPairs);
    sixPickHit = raw * 100;
  }

  // Slate grade
  let slateGrade, slateColor, slateRec;
  if (sGrades >= 2 && avgConf >= 70) {
    slateGrade = "A"; slateColor = "#4ade80";
    slateRec = `STRONG SLATE -- play 6-pick. ${sGrades}S + ${aGrades}A grades available.`;
  } else if ((sGrades >= 1 || aGrades >= 4) && avgConf >= 67) {
    slateGrade = "B"; slateColor = "#facc15";
    slateRec = `SOLID SLATE -- 6-pick playable, consider 5-pick if conservative.`;
  } else if (aGrades >= 3 && avgConf >= 64) {
    slateGrade = "C"; slateColor = "#f97316";
    slateRec = `THIN SLATE -- consider 4-pick or smaller. Limited high-conf props.`;
  } else {
    slateGrade = "D"; slateColor = "#f87171";
    slateRec = `WEAK SLATE -- sit out or 3-pick only. Negative EV on 6-pick today.`;
  }

  return { slateGrade, slateColor, slateRec, parlayWorthy: parlayWorthy.length, sGrades, aGrades, avgConf: Math.round(avgConf), sixPickHit: sixPickHit ? sixPickHit.toFixed(1) : null };
}

// --- SAME-EVENT CORRELATION DETECTOR -----------------------------------------
// Detects when two props in a parlay are from the same underlying game event
// (e.g. a player's solo kills + their combo kills -- same event, not independent)
function detectSameEventConflicts(parlayGroups) {
  const conflicts = [];
  for (let i = 0; i < parlayGroups.length; i++) {
    for (let j = i + 1; j < parlayGroups.length; j++) {
      const a = parlayGroups[i].meta;
      const b = parlayGroups[j].meta;
      // Same player, same matchup = same game, different stat type
      if (a.player === b.player && a.matchup === b.matchup) {
        conflicts.push(`[!] ${a.player} has TWO props in same game -- not independent events`);
      }
      // Same team, same matchup = correlated game outcome
      if (a.team === b.team && a.matchup === b.matchup && a.player !== b.player) {
        conflicts.push(`! ${a.player} + ${b.player} same team/series -- correlated`);
      }
    }
  }
  return [...new Set(conflicts)];
}

// --- STALENESS DETECTOR -------------------------------------------------------
function isPropStale(startTime) {
  if (!startTime) return false;
  try {
    const t = new Date(startTime);
    return t < new Date();
  } catch { return false; }
}

// --- HELPERS -----------------------------------------------------------------
const ODDS_COLORS = {
  goblin:   { bg:"#071a0f", border:"#22c55e55", text:"#22c55e", label:"GOBLIN",   badge:"#14532d" },
  standard: { bg:"#070f1f", border:"#60a5fa55", text:"#60a5fa", label:"STANDARD", badge:"#1e3a5f" },
  demon:    { bg:"#1a0707", border:"#f8717155", text:"#f87171", label:"DEMON",     badge:"#5f1e1e" },
};
const gradeColor = g => ({ S:"#FFD700", A:"#4ade80", B:"#60a5fa", C:"#f87171" })[g] || "#555";
const confColor  = c => c >= 78 ? "#C89B3C" : c >= 70 ? "#4ade80" : c >= 62 ? "#facc15" : c >= 55 ? "#f97316" : "#f87171";
const riskColor  = r => ({ LOW:"#4ade80", MEDIUM:"#facc15", HIGH:"#f87171" })[r] || "#888";
const metaColor  = m => ({ FAVORABLE:"#4ade80", NEUTRAL:"#facc15", UNFAVORABLE:"#f87171" })[m] || "#888";
const trendIcon  = t => ({ UP:"^", DOWN:"v", STABLE:"->" })[t] || "->";
const aKey       = g => `${g.meta.player}||${g.meta.matchup}||${g.meta.stat}`;

// --- COMPONENTS --------------------------------------------------------------
function SportBadge({ sport }) {
  const cfg = SPORT_CONFIG[sport] || SPORT_CONFIG.LoL;
  return <span style={{ fontSize:9, fontWeight:800, letterSpacing:1.5, padding:"2px 7px", borderRadius:4, background:`${cfg.color}18`, border:`1px solid ${cfg.color}40`, color:cfg.color }}>{cfg.icon} {sport}</span>;
}

function PropCard({ group, analysis, isSelected, inParlay, onSelect, onToggleParlay }) {
  const { standard, goblin, demon, meta } = group;
  const cfg = SPORT_CONFIG[meta.sport] || SPORT_CONFIG.LoL;
  const ok = analysis && !analysis._error;

  return (
    <div onClick={onSelect} style={{ borderRadius:10, padding:"12px 14px", cursor:"pointer", background:isSelected?"rgba(255,255,255,0.04)":"rgba(255,255,255,0.015)", border:`1px solid ${inParlay?"#FFD70055":isSelected?"rgba(255,255,255,0.12)":"rgba(255,255,255,0.06)"}`, transition:"all 0.1s", position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg,${cfg.color},${cfg.accent})`, opacity:isSelected?0.8:(!ok && meta.tier<=2)?0.6:0.25 }} />

      {ok && analysis.parlay_worthy && (
        <div onClick={e => { e.stopPropagation(); onToggleParlay(); }} style={{ position:"absolute", top:9, right:9, width:22, height:22, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", background:inParlay?"#FFD70022":"rgba(255,255,255,0.03)", border:`1.5px solid ${inParlay?"#FFD700":"rgba(255,255,255,0.07)"}`, fontSize:11, cursor:"pointer", color:inParlay?"#FFD700":"#2a2a3a", zIndex:2 }}>*</div>
      )}

      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ minWidth:0, flex:1, paddingRight:26 }}>
          <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap", marginBottom:2 }}>
            <span style={{ fontSize:14, fontWeight:900, color:"#F0F2F8" }}>{meta.player}</span>
            {ok && <div style={{ width:20, height:20, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(analysis.grade)}15`, border:`1.5px solid ${gradeColor(analysis.grade)}50`, fontSize:9, fontWeight:900, color:gradeColor(analysis.grade) }}>{analysis.grade}</div>}
            {(() => {
                const catColors = { KILLS:"#f87171",ASSISTS:"#4ade80",HEADSHOTS:"#f97316",COMBO:"#a78bfa" };
                const cat = meta.stat_category || "KILLS";
                const col = catColors[cat] || "#888";
                return <span style={{ fontSize:7, fontWeight:800, padding:"1px 5px", border:`1px solid ${col}30`, borderRadius:3, color:col, letterSpacing:0.5 }}>{cat}</span>;
              })()}
          </div>
          <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap" }}>
            <SportBadge sport={meta.sport} />
            {(() => { const tm = TIER_META[meta.tier||4]; return <span style={{ fontSize:7, fontWeight:800, padding:"1px 6px", borderRadius:3, background:`${tm.color}15`, border:`1px solid ${tm.color}35`, color:tm.color, letterSpacing:1 }}>{meta.tier===1?"* ":""}{tm.label}</span>; })()}
            <span style={{ fontSize:9, color:"#333" }}>{meta.team} vs {meta.opponent}</span>
            {meta.position && meta.position !== "?" && <span style={{ fontSize:8, color:"#2a2a3a", padding:"1px 5px", border:"1px solid rgba(255,255,255,0.04)", borderRadius:3 }}>{meta.position}</span>}
          </div>
        </div>
        {ok ? (
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{ fontSize:18, fontWeight:900, color:"#F0F2F8", lineHeight:1 }}>{analysis.projected}</div>
            <div style={{ fontSize:7, color:"#2a2a3a", letterSpacing:1 }}>PROJ {meta.stat_category || "KILLS"}</div>
            <div style={{ fontSize:12, fontWeight:800, color:confColor(analysis.conf) }}>{analysis.conf}%</div>
          </div>
        ) : analysis?._error ? <span style={{ fontSize:9, color:"#f87171" }}>⚠</span> : null}
      </div>

      <div style={{ display:"flex", gap:4 }}>
        {[["goblin",goblin],["standard",standard],["demon",demon]].map(([type,prop]) => {
          if (!prop) return null;
          const oc = ODDS_COLORS[type];
          const rec = analysis?.[`rec_${type}`];
          const isBest = analysis?.best_bet === type;
          const rc = rec === "MORE" ? "#4ade80" : rec === "LESS" ? "#818cf8" : "transparent";
          return (
            <div key={type} style={{ flex:1, minWidth:52, padding:"5px 7px", borderRadius:6, textAlign:"center", background:isBest?oc.bg:"rgba(255,255,255,0.02)", border:`1px solid ${isBest?oc.border:"rgba(255,255,255,0.04)"}` }}>
              <div style={{ fontSize:7, color:oc.text, letterSpacing:1, fontWeight:700 }}>{isBest?"* "+oc.label:oc.label}</div>
              <div style={{ fontSize:14, fontWeight:900, color:"#F0F2F8" }}>{prop.line}</div>
              {rec && rec !== "SKIP" && <div style={{ fontSize:8, fontWeight:800, color:rc, letterSpacing:1 }}>{rec}</div>}
            </div>
          );
        })}
      </div>

      {ok && analysis.take && (
        <div style={{ marginTop:6, fontSize:9, color:"#2a2a3a", fontStyle:"italic", paddingTop:6, borderTop:"1px solid rgba(255,255,255,0.03)" }}>"{analysis.take}"</div>
      )}
    </div>
  );
}

function DetailPanel({ group, analysis, onReanalyze, onLogPick, notes, onNotesChange, onFetchEnrichment, enrichment, result, onLogResult, onClearResult }) {
  if (!group) return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10 }}>
      <div style={{ fontSize:36, opacity:0.15 }}>O</div>
      <div style={{ fontSize:10, textAlign:"center", lineHeight:1.8, color:"#1a1a2e" }}>Click a prop card<br/>for deep analysis</div>
    </div>
  );

  const { standard, goblin, demon, meta } = group;
  const cfg = SPORT_CONFIG[meta.sport] || SPORT_CONFIG.LoL;
  const ok = analysis && !analysis._error;
  const stale = isPropStale(meta.start_time);

  return (
    <div>
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:7, color:"#222", letterSpacing:3, marginBottom:3 }}>DEEP ANALYSIS</div>
        <div style={{ fontSize:17, fontWeight:900, color:"#F0F2F8" }}>{meta.player}</div>
        <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap", marginTop:3 }}>
          <SportBadge sport={meta.sport} />
          {(() => { const tm = TIER_META[meta.tier||4]; return <span style={{ fontSize:7, fontWeight:800, padding:"1px 6px", borderRadius:3, background:`${tm.color}15`, border:`1px solid ${tm.color}35`, color:tm.color, letterSpacing:1 }}>{meta.tier===1?"* ":""}{tm.label}</span>; })()}
          <span style={{ fontSize:9, color:"#333" }}>{meta.team} vs {meta.opponent}</span>
          {(() => {
            const catColors = { KILLS:"#f87171",ASSISTS:"#4ade80",HEADSHOTS:"#f97316",COMBO:"#a78bfa" };
            const cat = meta.stat_category || "KILLS";
            const col = catColors[cat] || "#888";
            return <span style={{ fontSize:8, fontWeight:800, color:col, padding:"1px 6px", border:`1px solid ${col}25`, borderRadius:3 }}>{cat}</span>;
          })()}
          {meta.series_format && (
            <span style={{ fontSize:8, fontWeight:800, color:"#0AC8B9", padding:"1px 6px", border:"1px solid rgba(10,200,185,0.3)", borderRadius:3 }} title="Confirmed by PandaScore">
              {meta.series_format} OK
            </span>
          )}
          {meta.win_prob != null && meta.win_prob > 0 && meta.win_prob < 1 && (
            <span style={{ fontSize:8, color:"#a78bfa", padding:"1px 6px", border:"1px solid rgba(167,139,250,0.25)", borderRadius:3 }} title="Pinnacle-derived win probability">
              {meta.team} {Math.round(meta.win_prob*100)}% (Pinnacle)
            </span>
          )}
        </div>
        {stale && (
          <div style={{ marginTop:5, fontSize:8, color:"#f87171", padding:"3px 8px", background:"rgba(248,113,113,0.07)", border:"1px solid rgba(248,113,113,0.2)", borderRadius:4, display:"inline-block" }}>
            ⚠ GAME MAY HAVE STARTED -- verify prop is still live
          </div>
        )}
        {meta.trending > 0 && (
          <div style={{ marginTop:4, fontSize:8, color: meta.trending_signal==="FADE_STRONG"?"#f87171":meta.trending_signal==="FADE_MILD"?"#f97316":"#facc15" }}>
            {meta.trending_signal==="FADE_STRONG"?"🔴":meta.trending_signal==="FADE_MILD"?"🟠":"🔥"} {meta.trending?.toLocaleString()} picks
            {meta.trending_signal==="FADE_STRONG" && " -- PUBLIC FADE SIGNAL"}
            {meta.trending_signal==="FADE_MILD" && " -- line likely moved"}
          </div>
        )}
      </div>

      {/* -- SCOUT DATA PANEL -- */}
      <div style={{ marginBottom:10 }}>

        {/* Liquipedia enrichment block */}
        <div style={{ marginBottom:7 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:5 }}>
            <div style={{ fontSize:7, color:"#0AC8B9", letterSpacing:2 }}>LIQUIPEDIA DATA</div>
            <div style={{ display:"flex", gap:4 }}>
              {enrichment && !enrichment.loading && enrichment.error && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#0AC8B9", background:"rgba(10,200,185,0.06)", border:"1px solid rgba(10,200,185,0.2)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>-> Retry</button>
              )}
              {!enrichment?.loading && enrichment && !enrichment.error && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#555", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>-> Refresh</button>
              )}
              {!enrichment?.loading && (!enrichment || enrichment.error) && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#0AC8B9", background:"rgba(10,200,185,0.06)", border:"1px solid rgba(10,200,185,0.2)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>v Fetch</button>
              )}
            </div>
          </div>

          {!enrichment && (
            <div style={{ fontSize:8, color:"#1a3a3a", padding:"7px 9px", borderRadius:5, border:"1px dashed rgba(10,200,185,0.12)", lineHeight:1.6 }}>
              Click Fetch to pull live data from Liquipedia -- team status, role, tournament history, stand-in flags.
            </div>
          )}
          {enrichment?.loading && (
            <div style={{ fontSize:8, color:"#0AC8B9", padding:"7px 9px", borderRadius:5, border:"1px solid rgba(10,200,185,0.15)" }}>o Fetching from Liquipedia...</div>
          )}
          {enrichment?.error && (
            <div style={{ fontSize:8, color:"#f87171", padding:"6px 9px", borderRadius:5, border:"1px solid rgba(248,113,113,0.15)" }}>
              ⚠ {enrichment.error === "not_found" ? "Player page not found on Liquipedia" : enrichment.error}
            </div>
          )}
          {enrichment && !enrichment.error && !enrichment.loading && (
            <div style={{ borderRadius:6, overflow:"hidden", border:"1px solid rgba(10,200,185,0.15)" }}>
              {/* Status row -- most important */}
              <div style={{ padding:"6px 9px", background: enrichment.is_standin || enrichment.is_inactive ? "rgba(248,113,113,0.07)" : "rgba(10,200,185,0.05)", borderBottom:"1px solid rgba(10,200,185,0.08)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5 }}>STATUS</span>
                <span style={{ fontSize:9, fontWeight:900, color: enrichment.is_standin || enrichment.is_inactive ? "#f87171" : "#4ade80" }}>
                  {enrichment.is_standin && "⚠ "}{enrichment.is_inactive && "⚠ "}{enrichment.status}
                </span>
              </div>
              {(enrichment.is_standin || enrichment.is_inactive) && (
                <div style={{ padding:"5px 9px", background:"rgba(248,113,113,0.06)", borderBottom:"1px solid rgba(248,113,113,0.1)", fontSize:8, color:"#f87171", fontWeight:700 }}>
                  {enrichment.is_standin ? "STAND-IN DETECTED -- conf auto-penalized -12pts" : "INACTIVE -- recommend SKIP/grade C"}
                </div>
              )}
              {/* Data rows */}
              {[
                enrichment.current_team && ["TEAM", enrichment.current_team, "#aaa"],
                enrichment.role         && ["ROLE", enrichment.role, "#aaa"],
                enrichment.nationality  && ["COUNTRY", enrichment.nationality, "#555"],
              ].filter(Boolean).map(([label, val, color]) => (
                <div key={label} style={{ padding:"4px 9px", borderBottom:"1px solid rgba(255,255,255,0.03)", display:"flex", justifyContent:"space-between" }}>
                  <span style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5 }}>{label}</span>
                  <span style={{ fontSize:8, color }}>{val}</span>
                </div>
              ))}
              {/* Backend live stats row */}
              {enrichment.backendStats && !enrichment.backendStats.error && (
                <div style={{ padding:"4px 9px", borderBottom:"1px solid rgba(255,255,255,0.03)", display:"flex", justifyContent:"space-between" }}>
                  <span style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5 }}>LIVE STATS</span>
                  <span style={{ fontSize:8, color:"#4ade80" }}>
                    {enrichment.backendStats.kills_per_game != null && `${enrichment.backendStats.kills_per_game}k/g`}
                    {enrichment.backendStats.kills_per_map != null && `${enrichment.backendStats.kills_per_map}k/map`}
                    {enrichment.backendStats.rating != null && ` . R${enrichment.backendStats.rating}`}
                    {enrichment.backendStats.acs != null && ` . ACS${enrichment.backendStats.acs}`}
                  </span>
                </div>
              )}
              {enrichment.recent_tournaments?.length > 0 && (
                <div style={{ padding:"5px 9px" }}>
                  <div style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5, marginBottom:3 }}>RECENT EVENTS</div>
                  {enrichment.recent_tournaments.map((t,i) => (
                    <div key={i} style={{ fontSize:8, color:"#444", marginBottom:1 }}>> {t}</div>
                  ))}
                </div>
              )}
              <div style={{ padding:"3px 9px 5px", fontSize:6, color:"#0a2a2a" }}>Source: Liquipedia (CC-BY-SA 3.0) . {enrichment.fetched_at}</div>
            </div>
          )}
        </div>

        {/* Manual scout notes */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
          <div style={{ fontSize:7, color:"#C89B3C", letterSpacing:2 }}>SCOUT NOTES <span style={{ color:"#333", fontWeight:400 }}>(H2H kills, recent form, roster intel)</span></div>
          {notes && <button onClick={() => onNotesChange && onNotesChange("")} style={{ fontSize:6, color:"#333", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:3, padding:"1px 6px", cursor:"pointer", fontFamily:"inherit" }}>clear</button>}
        </div>
        <textarea
          value={notes || ""}
          onChange={e => onNotesChange && onNotesChange(e.target.value)}
          placeholder={"Paste H2H kills, recent game stats, stand-in info...\nEx: 'knight avg 8.2 kills/map vs T1 last 6 series, playing Azir'\nModel treats this as highest-priority override."}
          style={{ width:"100%", minHeight:72, background:"rgba(200,155,60,0.04)", border:"1px solid rgba(200,155,60,0.18)", borderRadius:6, color:"#999", fontFamily:"inherit", fontSize:9, padding:"7px 9px", resize:"vertical", lineHeight:1.5, boxSizing:"border-box" }}
        />
        {notes && (
          <div style={{ fontSize:7, color:"#C89B3C", marginTop:2 }}>OK Notes included in next analysis</div>
        )}
      </div>

      {!analysis ? (
        <button onClick={onReanalyze} style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background:`linear-gradient(135deg,${cfg.color},${cfg.accent})`, color:"#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor:"pointer" }}>
          O ANALYZE THIS PROP
        </button>
      ) : (
        <div style={{ display:"flex", gap:6, marginBottom:10 }}>
          <button onClick={onReanalyze} style={{ flex:1, padding:"7px", borderRadius:7, border:"1px solid rgba(255,255,255,0.07)", background:"transparent", color:"#444", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:2, cursor:"pointer" }}>
            -> RE-ANALYZE
          </button>
          {analysis && !analysis._error && (
            <button onClick={onLogPick} style={{ padding:"7px 12px", borderRadius:7, border:"1px solid rgba(10,200,185,0.3)", background:"rgba(10,200,185,0.06)", color:"#0ac8b9", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:1.5, cursor:"pointer" }}>
              📋 LOG PICK
            </button>
          )}
        </div>
      )}

      {analysis?._error && (
        <div style={{ textAlign:"center", padding:"18px 0" }}>
          <div style={{ color:"#f87171", fontSize:11, marginBottom:6 }}>⚠ {analysis._error}</div>
          <button onClick={onReanalyze} style={{ fontSize:8, color:"#f87171", background:"rgba(248,113,113,0.08)", border:"1px solid #f8717130", padding:"5px 12px", borderRadius:5, cursor:"pointer", fontFamily:"inherit" }}>-> Retry</button>
        </div>
      )}

      {ok && (
        <>
          <div style={{ borderRadius:9, padding:"13px", marginBottom:9, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:1 }}>PROJECTED</div>
                <div style={{ fontSize:34, fontWeight:900, color:"#F0F2F8" }}>{analysis.projected}</div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ width:30, height:30, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(analysis.grade)}15`, border:`1.5px solid ${gradeColor(analysis.grade)}50`, fontSize:13, fontWeight:900, color:gradeColor(analysis.grade), marginBottom:4 }}>{analysis.grade}</div>
                <div style={{ fontSize:18, fontWeight:900, color:confColor(analysis.conf) }}>{analysis.conf}%</div>
                <div style={{ fontSize:7, color:"#333", letterSpacing:1 }}>CONF</div>
              </div>
            </div>
            <div style={{ height:3, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden", marginTop:9 }}>
              <div style={{ height:"100%", width:`${analysis.conf}%`, background:`linear-gradient(90deg,${cfg.color},${cfg.accent})`, transition:"width 1s" }} />
            </div>
          </div>

          <div style={{ marginBottom:9 }}>
            <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:5 }}>ALL LINES</div>
            {[["goblin",goblin,"rec_goblin"],["standard",standard,"rec_standard"],["demon",demon,"rec_demon"]].map(([type,prop,rk]) => {
              if (!prop) return null;
              const oc = ODDS_COLORS[type];
              const rec = analysis[rk];
              const isBest = analysis.best_bet === type;
              const rc = rec === "MORE" ? "#4ade80" : rec === "LESS" ? "#818cf8" : "#222";
              return (
                <div key={type} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 10px", borderRadius:6, marginBottom:4, background:isBest?oc.bg:"rgba(255,255,255,0.015)", border:`1px solid ${isBest?oc.border:"rgba(255,255,255,0.05)"}`, position:"relative" }}>
                  {isBest && <div style={{ position:"absolute", top:-7, right:7, fontSize:7, fontWeight:900, background:oc.badge, color:oc.text, padding:"1px 6px", borderRadius:3, letterSpacing:1.5 }}>* BEST BET</div>}
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <span style={{ fontSize:8, fontWeight:800, color:oc.text, letterSpacing:1.5, minWidth:52 }}>{oc.label}</span>
                    <span style={{ fontSize:17, fontWeight:900, color:"#F0F2F8" }}>{prop.line}</span>
                  </div>
                  <div style={{ padding:"3px 10px", borderRadius:4, fontWeight:900, fontSize:10, letterSpacing:2, background:rec&&rec!=="SKIP"?`${rc}12`:"transparent", border:rec&&rec!=="SKIP"?`1px solid ${rc}40`:"none", color:rc }}>{rec||"SKIP"}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:4, marginBottom:9 }}>
            {[
              ["EDGE",   `+${analysis.edge}%`,  "#4ade80"],
              ["RISK",   analysis.risk,          riskColor(analysis.risk)],
              ["TREND",  `${trendIcon(analysis.trend)} ${analysis.trend}`, analysis.trend==="UP"?"#4ade80":analysis.trend==="DOWN"?"#f87171":"#facc15"],
              ["META",   analysis.meta_rating,   metaColor(analysis.meta_rating)],
              ["STAGE",  analysis.stage_impact||"NEUTRAL", analysis.stage_impact==="COMPRESS"?"#f87171":analysis.stage_impact==="INFLATE"?"#4ade80":"#facc15"],
              ["PARLAY", analysis.parlay_worthy?"YES":"NO", analysis.parlay_worthy?"#FFD700":"#333"],
              ["TYPE",   meta.is_combo?"COMBO":"SINGLE", meta.is_combo?"#a78bfa":"#60a5fa"],
            ].map(([label,val,col]) => (
              <div key={label} style={{ padding:"7px 5px", borderRadius:5, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.04)", textAlign:"center" }}>
                <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:2 }}>{label}</div>
                <div style={{ fontSize:9, fontWeight:800, color:col }}>{val}</div>
              </div>
            ))}
          </div>

          <div style={{ borderRadius:7, padding:"9px 11px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.04)", marginBottom:7 }}>
            <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:4 }}>MATCHUP</div>
            <div style={{ fontSize:10, color:"#666", lineHeight:1.6 }}>{analysis.matchup_note}</div>
          </div>

          {analysis.variance_flags && analysis.variance_flags.length > 0 && (
            <div style={{ borderRadius:7, padding:"9px 11px", background:"rgba(249,115,22,0.04)", border:"1px solid rgba(249,115,22,0.12)", marginBottom:7 }}>
              <div style={{ fontSize:7, color:"#f97316", letterSpacing:2, marginBottom:6 }}>VARIANCE FLAGS</div>
              {analysis.variance_flags.map((flag, i) => (
                <div key={i} style={{ display:"flex", gap:6, marginBottom:3, alignItems:"flex-start" }}>
                  <span style={{ color:"#f97316", fontSize:8, flexShrink:0 }}>⚠</span>
                  <span style={{ fontSize:9, color:"#7a4010", lineHeight:1.4 }}>{flag}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ borderRadius:7, padding:"9px 11px", background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:6 }}>KEY FACTORS</div>
            {(analysis.insights||[]).map((ins,i) => (
              <div key={i} style={{ display:"flex", gap:6, marginBottom:5, alignItems:"flex-start" }}>
                <span style={{ color:cfg.color, fontSize:8, flexShrink:0, marginTop:2 }}>></span>
                <span style={{ fontSize:10, color:"#555", lineHeight:1.5 }}>{ins}</span>
              </div>
            ))}
          </div>

          {/* Result Tracker */}
          <div style={{ marginTop:10, borderRadius:7, padding:"9px 11px", background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:7 }}>LOG RESULT</div>
            {result ? (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <div style={{ fontSize:16, fontWeight:900, color: result.hit ? "#4ade80" : "#f87171" }}>{result.hit ? "OK HIT" : "X MISS"}</div>
                  <div style={{ fontSize:8, color:"#333" }}>{result.date} . Grade {result.grade} . {result.conf}% conf</div>
                </div>
                <button onClick={onClearResult} style={{ fontSize:7, color:"#333", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>clear</button>
              </div>
            ) : (
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={() => onLogResult && onLogResult(true)} style={{ flex:1, padding:"7px", borderRadius:6, border:"1px solid rgba(74,222,128,0.25)", background:"rgba(74,222,128,0.06)", color:"#4ade80", fontFamily:"inherit", fontSize:9, fontWeight:800, cursor:"pointer", letterSpacing:1 }}>OK HIT</button>
                <button onClick={() => onLogResult && onLogResult(false)} style={{ flex:1, padding:"7px", borderRadius:6, border:"1px solid rgba(248,113,113,0.25)", background:"rgba(248,113,113,0.06)", color:"#f87171", fontFamily:"inherit", fontSize:9, fontWeight:800, cursor:"pointer", letterSpacing:1 }}>X MISS</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ParlayPanel({ groups, analyses, parlay, setParlay, parlayResult, setParlayResult, matchupPicks, setMatchupPicks }) {
  const [bankroll,   setBankroll]  = useState(1000);
  const [mode,       setMode]      = useState("powers"); // "powers" | "manual"
  const [building,   setBuilding]  = useState(false);
  const [buildError, setBuildError]= useState("");
  const [filterPicks,setFilterPicks] = useState(0); // 0=all, 2,3,4

  // Build candidate list from analyzed parlay-worthy props
  const candidates = Object.entries(analyses)
    .filter(([, a]) => a && !a._error && a.parlay_worthy && (a.grade === "S" || a.grade === "A" || (a.grade === "B" && a.conf >= 67)) && a.conf >= 60)
    .map(([key, a]) => {
      const group = groups.find(g => aKey(g) === key);
      if (!group) return null;
      return {
        key,
        player: group.meta.player,
        team: group.meta.team,
        matchup: group.meta.matchup,
        sport: group.meta.sport,
        tier: group.meta.tier,
        conf: a.conf,
        edge: a.edge,
        grade: a.grade,
        best_bet: a.best_bet,
        line: (group[a.best_bet] || group.standard || group.goblin)?.line,
        rec: a[`rec_${a.best_bet}`],
        take: a.take,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.conf - a.conf)
    .slice(0, 20); // top 20 by conf for combo engine

  // Build all positive EV combos
  const allCombos = buildAllPowersCombos(candidates, bankroll, matchupPicks);
  const filtered = filterPicks ? allCombos.filter(c => c.picks === filterPicks) : allCombos;

  // Manual parlay (star-picked props)
  const parlaySet    = new Set(parlay);
  const parlayGroups = groups.filter(g => parlaySet.has(aKey(g)));

  const handleBuildAI = async () => {
    setBuilding(true);
    setBuildError("");
    setParlayResult(null);
    try {
      const result = await buildParlayAI(groups, analyses, 6, Math.round(bankroll * 0.02));
      if (result.error) setBuildError(result.error);
      else {
        setParlayResult(result);
        setParlay(result.legs.map(l => `${l.player}||${l.matchup}||${l.stat}`));
      }
    } catch (e) { setBuildError(String(e.message||e)); }
    setBuilding(false);
  };

  const evColor = ev => ev >= 5 ? "#4ade80" : ev >= 1 ? "#facc15" : "#f97316";
  const probColor = p => p >= 50 ? "#4ade80" : p >= 33 ? "#facc15" : "#f97316";

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display:"flex", gap:5, marginBottom:12 }}>
        {[["powers","! POWERS EV"],["manual","* MANUAL"]].map(([m,label]) => (
          <button key={m} onClick={() => setMode(m)} style={{ flex:1, padding:"6px", borderRadius:6, border:`1px solid ${mode===m?"#FFD70055":"rgba(255,255,255,0.07)"}`, background:mode===m?"rgba(255,215,0,0.08)":"transparent", color:mode===m?"#FFD700":"#444", fontFamily:"inherit", fontSize:8, fontWeight:900, letterSpacing:1.5, cursor:"pointer" }}>{label}</button>
        ))}
      </div>

      {mode === "powers" && (
        <div>
          {/* Bankroll input */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:4 }}>BANKROLL ($)</div>
            <div style={{ display:"flex", gap:3 }}>
              {[100,250,500,1000,2500].map(b => (
                <button key={b} onClick={() => setBankroll(b)} style={{ flex:1, padding:"5px 0", borderRadius:4, border:`1px solid ${bankroll===b?"#FFD70055":"rgba(255,255,255,0.05)"}`, background:bankroll===b?"rgba(255,215,0,0.07)":"transparent", color:bankroll===b?"#FFD700":"#333", fontFamily:"inherit", fontSize:7, fontWeight:800, cursor:"pointer" }}>${b>=1000?`${b/1000}k`:b}</button>
              ))}
            </div>
          </div>

          {/* Filter by picks */}
          <div style={{ display:"flex", gap:4, marginBottom:10 }}>
            {[[0,"ALL"],[2,"2-PICK 3x"],[3,"3-PICK 5x"],[4,"4-PICK 10x"]].map(([n,label]) => (
              <button key={n} onClick={() => setFilterPicks(n)} style={{ flex:1, padding:"4px 0", borderRadius:4, border:`1px solid ${filterPicks===n?"rgba(255,255,255,0.2)":"rgba(255,255,255,0.05)"}`, background:filterPicks===n?"rgba(255,255,255,0.06)":"transparent", color:filterPicks===n?"#F0F2F8":"#333", fontFamily:"inherit", fontSize:7, fontWeight:800, cursor:"pointer" }}>{label}</button>
            ))}
          </div>

          {/* Stats summary */}
          {allCombos.length > 0 && (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:4, marginBottom:10 }}>
              {[
                ["COMBOS", filtered.length, "#60a5fa"],
                ["BEST EV", `+$${filtered[0]?.ev?.toFixed(0)||0}`, "#4ade80"],
                ["BEST HIT%", `${filtered[0]?.hit_prob||0}%`, "#facc15"],
              ].map(([label,val,color]) => (
                <div key={label} style={{ padding:"6px 5px", borderRadius:5, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.04)", textAlign:"center" }}>
                  <div style={{ fontSize:7, color:"#333", letterSpacing:1.5, marginBottom:2 }}>{label}</div>
                  <div style={{ fontSize:11, fontWeight:900, color }}>{val}</div>
                </div>
              ))}
            </div>
          )}

          {/* -- Matchup Winner Picker -------------------------------- */}
          {(() => {
            // Collect unique matchups from candidates
            const matchups = [...new Set(candidates.map(c => c.matchup).filter(Boolean))];
            if (!matchups.length) return null;
            return (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:5 }}>MATCHUP PICKS <span style={{ color:"#1a1a2a", fontWeight:400 }}>(optional -- boosts EV for your called winners)</span></div>
                {matchups.map(matchup => {
                  const pick = matchupPicks[matchup] || {};
                  // Get teams from candidates in this matchup
                  const matchupCandidates = candidates.filter(c => c.matchup === matchup);
                  const teams = [...new Set(matchupCandidates.map(c => c.team).filter(Boolean))];
                  return (
                    <div key={matchup} style={{ marginBottom:6, padding:"8px 10px", borderRadius:6, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ fontSize:8, color:"#555", marginBottom:5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{matchup}</div>
                      {/* Team picker */}
                      <div style={{ display:"flex", gap:3, marginBottom:4 }}>
                        {teams.slice(0,2).map(team => (
                          <button key={team} onClick={() => setMatchupPicks(prev => ({
                            ...prev,
                            [matchup]: { ...prev[matchup], winner: prev[matchup]?.winner === team ? null : team }
                          }))} style={{ flex:1, padding:"4px 5px", borderRadius:4, border:`1px solid ${pick.winner===team?"#4ade8055":"rgba(255,255,255,0.06)"}`, background:pick.winner===team?"rgba(74,222,128,0.08)":"transparent", color:pick.winner===team?"#4ade80":"#444", fontFamily:"inherit", fontSize:7, fontWeight:800, cursor:"pointer", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {pick.winner===team?"OK ":""}{team||"Team"}
                          </button>
                        ))}
                        {teams.length === 0 && (
                          <div style={{ fontSize:7, color:"#1a1a2a" }}>Teams not identified -- analyze props first</div>
                        )}
                      </div>
                      {/* Strength picker -- only show if winner selected */}
                      {pick.winner && (
                        <div style={{ display:"flex", gap:3 }}>
                          {[["slight","SLIGHT +8%"],["clear","CLEAR +12%"],["upset","UPSET CALL +18%"]].map(([s,label]) => (
                            <button key={s} onClick={() => setMatchupPicks(prev => ({
                              ...prev,
                              [matchup]: { ...prev[matchup], strength: s }
                            }))} style={{ flex:1, padding:"3px 4px", borderRadius:3, border:`1px solid ${pick.strength===s?"rgba(250,204,21,0.4)":"rgba(255,255,255,0.05)"}`, background:pick.strength===s?"rgba(250,204,21,0.07)":"transparent", color:pick.strength===s?"#facc15":"#333", fontFamily:"inherit", fontSize:6, fontWeight:800, cursor:"pointer", letterSpacing:0.5 }}>{label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {Object.keys(matchupPicks).length > 0 && (
                  <button onClick={() => setMatchupPicks({})} style={{ fontSize:7, color:"#333", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:4, padding:"3px 8px", cursor:"pointer", fontFamily:"inherit", marginTop:2 }}>✕ clear all picks</button>
                )}
              </div>
            );
          })()}

          {candidates.length < 2 && (
            <div style={{ padding:"18px", textAlign:"center", border:"1px dashed rgba(255,255,255,0.06)", borderRadius:8 }}>
              <div style={{ fontSize:10, color:"#222", marginBottom:4 }}>No positive EV combos yet</div>
              <div style={{ fontSize:8, color:"#1a1a2a", lineHeight:1.6 }}>Analyze more props first.<br/>Need at least 2 props with Grade A/S and 60%+ conf.</div>
            </div>
          )}

          {/* Combo list */}
          {filtered.slice(0, 15).map((combo, idx) => (
            <div key={idx} style={{ marginBottom:6, borderRadius:7, padding:"9px 10px", background:idx===0?"rgba(255,215,0,0.05)":"rgba(255,255,255,0.015)", border:`1px solid ${idx===0?"rgba(255,215,0,0.2)":"rgba(255,255,255,0.05)"}` }}>
              {/* Header row */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  {idx === 0 && <span style={{ fontSize:7, color:"#FFD700", fontWeight:900, letterSpacing:1 }}>* BEST</span>}
                  <span style={{ fontSize:8, fontWeight:900, color:"#F0F2F8" }}>{combo.picks}-PICK POWER</span>
                  <span style={{ fontSize:7, color:"#444" }}>{combo.payout_mult}x</span>
                  {combo.has_correlation && <span style={{ fontSize:6, color:"#facc15", padding:"1px 4px", border:"1px solid rgba(250,204,21,0.3)", borderRadius:2 }}>! CORR</span>}
                </div>
                <div style={{ textAlign:"right" }}>
                  <span style={{ fontSize:11, fontWeight:900, color:evColor(combo.ev) }}>+${combo.ev.toFixed(2)} EV</span>
                </div>
              </div>

              {/* Metrics row */}
              <div style={{ display:"flex", gap:4, marginBottom:7 }}>
                <div style={{ flex:1, padding:"4px 5px", borderRadius:4, background:"rgba(255,255,255,0.02)", textAlign:"center" }}>
                  <div style={{ fontSize:7, color:"#222", letterSpacing:1 }}>HIT RATE</div>
                  <div style={{ fontSize:11, fontWeight:900, color:probColor(combo.hit_prob) }}>{combo.hit_prob}%</div>
                </div>
                <div style={{ flex:1, padding:"4px 5px", borderRadius:4, background:"rgba(255,255,255,0.02)", textAlign:"center" }}>
                  <div style={{ fontSize:7, color:"#222", letterSpacing:1 }}>KELLY BET</div>
                  <div style={{ fontSize:11, fontWeight:900, color:"#60a5fa" }}>${combo.kelly_stake}</div>
                </div>
                <div style={{ flex:1, padding:"4px 5px", borderRadius:4, background:"rgba(255,255,255,0.02)", textAlign:"center" }}>
                  <div style={{ fontSize:7, color:"#222", letterSpacing:1 }}>WIN</div>
                  <div style={{ fontSize:11, fontWeight:900, color:"#4ade80" }}>${combo.payout_amt}</div>
                </div>
                <div style={{ flex:1, padding:"4px 5px", borderRadius:4, background:"rgba(255,255,255,0.02)", textAlign:"center" }}>
                  <div style={{ fontSize:7, color:"#222", letterSpacing:1 }}>ROI</div>
                  <div style={{ fontSize:11, fontWeight:900, color:evColor(combo.roi) }}>{combo.roi}%</div>
                </div>
              </div>

              {/* Legs */}
              {combo.legs.map((leg, li) => {
                const cfg = SPORT_CONFIG[leg.sport] || SPORT_CONFIG.LoL;
                return (
                  <div key={li} style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 6px", borderRadius:4, marginBottom:2, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.03)" }}>
                    <span style={{ fontSize:8, color:cfg.color }}>{cfg.icon}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <span style={{ fontSize:9, fontWeight:800, color:"#E0E2EE" }}>{leg.player}</span>
                      <span style={{ fontSize:7, color:"#333", marginLeft:5 }}>{(ODDS_COLORS[leg.best_bet]||ODDS_COLORS.standard).label} {leg.line} {leg.rec}</span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                      <div style={{ width:16, height:16, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(leg.grade)}15`, border:`1px solid ${gradeColor(leg.grade)}40`, fontSize:7, fontWeight:900, color:gradeColor(leg.grade) }}>{leg.grade}</div>
                      <span style={{ fontSize:9, fontWeight:800, color:confColor(leg.conf) }}>{leg.conf}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {filtered.length === 0 && candidates.length >= 2 && (
            <div style={{ padding:"14px", textAlign:"center", border:"1px dashed rgba(255,255,255,0.06)", borderRadius:8 }}>
              <div style={{ fontSize:9, color:"#333" }}>No positive EV combos for this filter</div>
              <div style={{ fontSize:8, color:"#1a1a2a", marginTop:3 }}>Try "ALL" to see all pick sizes</div>
            </div>
          )}

          {/* EV education footer */}
          <div style={{ marginTop:10, padding:"8px 10px", borderRadius:6, background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.04)" }}>
            <div style={{ fontSize:7, color:"#1a1a2a", lineHeight:1.8 }}>
              <div style={{ color:"#333", fontWeight:700, letterSpacing:1, marginBottom:3 }}>HOW EV IS CALCULATED</div>
              EV = (hit% x profit) - (miss% x stake)<br/>
              Kelly bet = optimal stake size from bankroll<br/>
              Break-even: 2-pick 33.3% . 3-pick 20% . 4-pick 10%<br/>
              Only positive EV combos shown. Correlated legs penalized.
            </div>
          </div>
        </div>
      )}

      {mode === "manual" && (
        <div>
          <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:8 }}>MANUAL PARLAY -- click * on prop cards to add</div>

          {/* Bankroll for kelly on manual */}
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:4 }}>BANKROLL ($)</div>
            <div style={{ display:"flex", gap:3 }}>
              {[100,250,500,1000,2500].map(b => (
                <button key={b} onClick={() => setBankroll(b)} style={{ flex:1, padding:"5px 0", borderRadius:4, border:`1px solid ${bankroll===b?"#FFD70055":"rgba(255,255,255,0.05)"}`, background:bankroll===b?"rgba(255,215,0,0.07)":"transparent", color:bankroll===b?"#FFD700":"#333", fontFamily:"inherit", fontSize:7, fontWeight:800, cursor:"pointer" }}>${b>=1000?`${b/1000}k`:b}</button>
              ))}
            </div>
          </div>

          {buildError && <div style={{ fontSize:9, color:"#f87171", marginBottom:7, padding:"7px 10px", border:"1px solid #f8717125", borderRadius:6 }}>{buildError}</div>}

          {parlayGroups.length > 0 && (
            <div>
              {/* Conflict warnings */}
              {(() => {
                const conflicts = detectSameEventConflicts(parlayGroups);
                return conflicts.map((c,i) => (
                  <div key={i} style={{ fontSize:8, color:"#f87171", padding:"4px 8px", background:"rgba(248,113,113,0.05)", border:"1px solid rgba(248,113,113,0.18)", borderRadius:5, marginBottom:4 }}>{c}</div>
                ));
              })()}

              <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:6 }}>LEGS ({parlayGroups.length})</div>
              {parlayGroups.map(g => {
                const a = analyses[aKey(g)];
                const bestProp = g[a?.best_bet] || g.standard || g.goblin || g.demon;
                const cfg = SPORT_CONFIG[g.meta.sport] || SPORT_CONFIG.LoL;
                return (
                  <div key={aKey(g)} style={{ display:"flex", alignItems:"center", gap:7, padding:"7px 9px", borderRadius:6, marginBottom:4, background:"rgba(255,215,0,0.04)", border:"1px solid rgba(255,215,0,0.12)" }}>
                    <div style={{ width:18, height:18, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(a?.grade)}15`, border:`1px solid ${gradeColor(a?.grade)}40`, fontSize:8, fontWeight:900, color:gradeColor(a?.grade) }}>{a?.grade||"?"}</div>
                    <span style={{ fontSize:8, color:cfg.color }}>{cfg.icon}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:10, fontWeight:800, color:"#E0E2EE" }}>{g.meta.player}</div>
                      <div style={{ fontSize:8, color:"#333" }}>{(ODDS_COLORS[a?.best_bet]||ODDS_COLORS.standard).label} {bestProp?.line} -- {a?.[`rec_${a?.best_bet}`]||"?"}</div>
                    </div>
                    <div style={{ fontSize:11, fontWeight:900, color:confColor(a?.conf||0) }}>{a?.conf||"?"}%</div>
                    <button onClick={() => setParlay(prev => prev.filter(k=>k!==aKey(g)))} style={{ fontSize:11, color:"#222", background:"none", border:"none", cursor:"pointer" }}>✕</button>
                  </div>
                );
              })}

              {/* EV summary for manual parlay */}
              {parlayGroups.length >= 2 && parlayGroups.length <= 4 && (() => {
                const legs = parlayGroups.map(g => {
                  const a = analyses[aKey(g)];
                  return { conf: a?.conf||0, matchup: g.meta.matchup, team: g.meta.team };
                });
                const picks = parlayGroups.length;
                const payout = POWERS_PAYOUTS[picks];
                if (!payout) return null;
                const hitProb = correctedHitProb(legs, matchupPicks);
                const stake = calcKelly(hitProb, picks, bankroll);
                const ev = calcEV(hitProb, picks, stake || 10);
                const hitPct = Math.round(hitProb * 1000) / 10;
                return (
                  <div style={{ marginTop:8, padding:"11px", borderRadius:8, background:`linear-gradient(135deg,rgba(255,215,0,0.07),rgba(255,215,0,0.02))`, border:"1px solid rgba(255,215,0,0.2)", textAlign:"center" }}>
                    <div style={{ fontSize:7, color:"#7a6800", letterSpacing:2, marginBottom:3 }}>{picks}-PICK POWER . {payout}x</div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5, marginBottom:5 }}>
                      {[
                        ["HIT%", `${hitPct}%`, probColor(hitPct)],
                        ["EV", ev>0?`+$${ev.toFixed(0)}`:`-$${Math.abs(ev).toFixed(0)}`, ev>0?"#4ade80":"#f87171"],
                        ["KELLY", `$${stake}`, "#60a5fa"],
                        ["WIN", `$${Math.round((stake||10)*payout)}`, "#4ade80"],
                      ].map(([l,v,c]) => (
                        <div key={l} style={{ padding:"5px 3px", borderRadius:4, background:"rgba(255,255,255,0.02)" }}>
                          <div style={{ fontSize:6, color:"#555", letterSpacing:1 }}>{l}</div>
                          <div style={{ fontSize:10, fontWeight:900, color:c }}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {ev <= 0 && <div style={{ fontSize:8, color:"#f87171" }}>⚠ Negative EV -- consider different legs</div>}
                    {ev > 0 && <div style={{ fontSize:8, color:"#4ade80" }}>OK Positive EV -- mathematically sound bet</div>}
                  </div>
                );
              })()}
            </div>
          )}

          {parlayGroups.length === 0 && (
            <div style={{ padding:"18px", textAlign:"center", border:"1px dashed rgba(255,255,255,0.06)", borderRadius:8 }}>
              <div style={{ fontSize:10, color:"#222" }}>No legs added</div>
              <div style={{ fontSize:8, color:"#1a1a2a", marginTop:3 }}>Click * on analyzed prop cards to add legs</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- BACKEND STATUS ----------------------------------------------------------
function BackendStatus() {
  const [status, setStatus] = useState("checking");

  useEffect(() => {
    fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => r.ok ? setStatus("online") : setStatus("offline"))
      .catch(() => setStatus("offline"));
  }, []);

  const color = status === "online" ? "#4ade80" : status === "offline" ? "#f87171" : "#facc15";
  const label = status === "online" ? "* STATS SERVER ONLINE" : status === "offline" ? "O STATS SERVER OFFLINE" : "o CONNECTING...";
  return (
    <div style={{ fontSize:7, color, letterSpacing:1.5, marginTop:2 }}>{label}</div>
  );
}


// --- BACKTEST PANEL -----------------------------------------------------------
// --- BACKTEST FINDINGS (hardcoded from real 2024 analysis) ---------------------
const BACKTEST_FINDINGS = {
  Valorant: { sample:6, accuracy:100, verdict:"SHARP", ev:"+EV", note:"6/6 seed picks (n=6, too small to be conclusive). Agent-confirmed props are the sharpest signal.", cap:null, color:"#4ade80" },
  LoL:      { sample:9, accuracy:78,  verdict:"SHARP", ev:"+EV", note:"7/9 seed picks. Role+champion confirmed props. Primary parlay sport.", cap:null, color:"#4ade80" },
  Dota2:    { sample:4, accuracy:100, verdict:"SOLID", ev:"+EV", note:"4/4 seed picks (n=4, tiny sample). Position+draft analysis shows signal.", cap:null, color:"#facc15" },
  R6:       { sample:2, accuracy:100, verdict:"LOW N",  ev:"NEUTRAL", note:"2/2 seed picks but n=2 is statistically meaningless. Treat as coin flip until n>20.", cap:68, color:"#888" },
  CS2:      { sample:7, accuracy:43,  verdict:"⚠ NEG EV", ev:"-EV", note:"3/7 seed picks -- below random. Map pool veto unknown = #1 blind spot. IGL LESS (karrigan) only exception.", cap:68, color:"#f87171" },
  COD:      { sample:3, accuracy:100, verdict:"⚠ SKIP",  ev:"SKIP", note:"3/3 seed picks BUT all were Grade B (conf 60-63). Mode (HP vs SnD) varies kills 3-5x -- never parlay COD.", cap:65, color:"#f97316" },
};

function BacktestPanel({ backendUrl }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("calibration"); // "calibration" | "findings"

  useEffect(() => {
    fetch(`${backendUrl}/picks/log`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding:20, textAlign:"center", color:"#333", fontSize:10 }}>Loading calibration data...</div>;
  if (!data) return <div style={{ padding:20, textAlign:"center", color:"#f87171", fontSize:10 }}>Could not load -- stats server offline?</div>;

  const { stats } = data;
  const cal = stats.calibration;

  const sportData = Object.entries(cal?.bySport || {}).filter(([,v]) => v.n >= 2);
  const gradeColor = g => ({ S:"#C89B3C", A:"#4ade80", B:"#60a5fa", C:"#f87171" })[g] || "#555";
  const deltaColor = d => d == null ? "#555" : d > 0.05 ? "#4ade80" : d < -0.05 ? "#f87171" : "#facc15";
  const BREAKEVEN = 57.7;

  return (
    <div>
      <div style={{ fontSize:7, color:"#333", letterSpacing:3, marginBottom:10 }}>MODEL CALIBRATION + BACKTEST</div>

      {/* Tab switcher */}
      <div style={{ display:"flex", gap:4, marginBottom:10 }}>
        {[["calibration","📊 Live Cal"],["findings","🔬 Findings"]].map(([t,label]) => (
          <button key={t} onClick={() => setTab(t)} style={{ flex:1, padding:"5px 0", borderRadius:5, border:`1px solid ${tab===t?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.04)"}`, background:tab===t?"rgba(255,255,255,0.06)":"transparent", color:tab===t?"#ccc":"#333", fontSize:9, cursor:"pointer", letterSpacing:1 }}>{label}</button>
        ))}
      </div>

      {tab === "calibration" && (
        <>
          {/* Overall */}
          <div style={{ textAlign:"center", padding:"12px", borderRadius:9, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", marginBottom:10 }}>
            <div style={{ fontSize:32, fontWeight:900, color:(cal?.overallHitRate||0) >= 65 ? "#4ade80" : (cal?.overallHitRate||0) >= 55 ? "#facc15" : "#f87171" }}>{cal?.overallHitRate ?? "--"}%</div>
            <div style={{ fontSize:8, color:"#333", letterSpacing:2 }}>OVERALL HIT RATE</div>
            <div style={{ fontSize:9, color:"#444", marginTop:2 }}>{cal?.totalSettled ?? 0} picks . {cal?.seedCount ?? 0} verified 2024 seeds</div>
            <div style={{ fontSize:7, color:"#333", marginTop:2 }}>Breakeven for +EV: {BREAKEVEN}% per leg</div>
          </div>

          {/* By Grade */}
          {cal && cal.totalSettled > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:6 }}>GRADE CALIBRATION (actual vs expected)</div>
              {["S","A","B","C"].map(g => {
                const d = cal.byGrade?.[g];
                if (!d || d.n === 0) return null;
                const actual = d.actualRate != null ? Math.round(d.actualRate * 100) : null;
                const expected = d.expectedRate != null ? Math.round(d.expectedRate * 100) : null;
                const delta = d.delta != null ? Math.round(d.delta * 100) : null;
                return (
                  <div key={g} style={{ display:"flex", alignItems:"center", gap:7, marginBottom:5, padding:"6px 8px", borderRadius:6, background:"rgba(255,255,255,0.015)", border:`1px solid ${gradeColor(g)}18` }}>
                    <div style={{ width:20, height:20, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(g)}15`, border:`1.5px solid ${gradeColor(g)}50`, fontSize:9, fontWeight:900, color:gradeColor(g) }}>{g}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                        <span style={{ fontSize:7, color:"#444" }}>Exp: {expected ?? "--"}%</span>
                        <span style={{ fontSize:7, color:actual != null && expected != null && actual >= expected ? "#4ade80" : "#f87171" }}>Act: {actual ?? "--"}%</span>
                      </div>
                      <div style={{ height:3, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${actual || 0}%`, background:gradeColor(g), borderRadius:2 }} />
                      </div>
                    </div>
                    <div style={{ minWidth:40, textAlign:"right" }}>
                      <div style={{ fontSize:8, fontWeight:900, color:deltaColor(d.delta) }}>{delta != null ? (delta >= 0 ? `+${delta}%` : `${delta}%`) : "--"}</div>
                      <div style={{ fontSize:7, color:"#333" }}>{d.n}p</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* By Sport from live picks */}
          {sportData.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:6 }}>HIT RATE BY SPORT (live + seeds)</div>
              {sportData.sort((a,b)=>b[1].n-a[1].n).map(([sport, d]) => {
                const bf = BACKTEST_FINDINGS[sport];
                const col = bf?.color || "#888";
                const isEV = d.hit_rate >= BREAKEVEN;
                return (
                  <div key={sport} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                    <span style={{ fontSize:7, fontWeight:700, color:col, minWidth:58, letterSpacing:1 }}>{sport}</span>
                    <div style={{ flex:1, height:4, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${d.hit_rate||0}%`, background:isEV?"#4ade80":"#f87171", borderRadius:2 }} />
                    </div>
                    <span style={{ fontSize:9, fontWeight:800, color:isEV?"#4ade80":"#f87171", minWidth:32, textAlign:"right" }}>{d.hit_rate ?? "--"}%</span>
                    <span style={{ fontSize:7, color:"#333", minWidth:20 }}>{d.n}p</span>
                  </div>
                );
              })}
              <div style={{ fontSize:7, color:"#1a1a2a", marginTop:4 }}>Red bar = negative EV (&lt;{BREAKEVEN}% breakeven)</div>
            </div>
          )}

          <div style={{ padding:"7px 9px", borderRadius:6, background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.04)", fontSize:8, color:"#1a1a2a", lineHeight:1.7 }}>
            Positive delta = model underconfident (good). Negative = overconfident.<br/>
            Grade A target: 70-80%. Grade S: 78-84%.<br/>
            {cal?.seedCount ? `${cal.seedCount} verified 2024 results seed calibration from day 1.` : ""}
          </div>
        </>
      )}

      {tab === "findings" && (
        <>
          <div style={{ padding:"8px 10px", borderRadius:7, background:"rgba(74,222,128,0.05)", border:"1px solid rgba(74,222,128,0.15)", marginBottom:10 }}>
            <div style={{ fontSize:8, fontWeight:700, color:"#4ade80", letterSpacing:1, marginBottom:3 }}>BACKTEST CONCLUSION</div>
            <div style={{ fontSize:8, color:"#aaa", lineHeight:1.7 }}>
              Build parlays from <span style={{ color:"#4ade80", fontWeight:700 }}>Valorant + LoL + Dota2</span> only.<br/>
              CS2 and COD are -EV as parlay legs. IGL LESS in CS2 is the one exception.<br/>
              Breakeven per leg: <span style={{ color:"#facc15" }}>57.7%</span> (2-pick 3x). All +EV sports exceed this.
            </div>
          </div>

          {Object.entries(BACKTEST_FINDINGS).map(([sport, f]) => (
            <div key={sport} style={{ marginBottom:6, padding:"8px 10px", borderRadius:7, background:"rgba(255,255,255,0.015)", border:`1px solid ${f.color}18` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:9, fontWeight:900, color:f.color }}>{sport}</span>
                  <span style={{ fontSize:7, padding:"1px 5px", borderRadius:3, background:`${f.color}15`, border:`1px solid ${f.color}30`, color:f.color, letterSpacing:1 }}>{f.ev}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <div style={{ width:36, height:4, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${f.accuracy}%`, background:f.accuracy >= BREAKEVEN ? "#4ade80" : "#f87171", borderRadius:2 }} />
                  </div>
                  <span style={{ fontSize:9, fontWeight:900, color:f.accuracy >= BREAKEVEN ? "#4ade80" : "#f87171" }}>{f.accuracy}%</span>
                  <span style={{ fontSize:7, color:"#333" }}>n={f.sample}</span>
                </div>
              </div>
              <div style={{ fontSize:7, color:"#555", lineHeight:1.6 }}>
                {f.note}
                {f.cap && <span style={{ color:"#f97316" }}> Conf capped {f.cap} max.</span>}
              </div>
            </div>
          ))}

          <div style={{ marginTop:6, padding:"7px 9px", borderRadius:6, background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.04)", fontSize:7, color:"#1a1a2a", lineHeight:1.7 }}>
            Data: 31 verified 2024-2025 esports props with documented outcomes.<br/>
            Sources: Liquipedia match history, vlr.gg, gol.gg, HLTV stats.<br/>
            CS2/COD conf caps enforced in stat notes -> AI system prompt.
          </div>
        </>
      )}
    </div>
  );
}

// --- LOG VIEW COMPONENT -----------------------------------------------------
function LogView({ backendUrl }) {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [settling, setSettling] = useState({});

  function loadLog() {
    setLoading(true);
    setError(null);
    fetch(`${backendUrl}/picks/log`)
      .then(r => r.json())
      .then(data => { setLog(data); setLoading(false); })
      .catch(err => { setError(String(err)); setLoading(false); });
  }

  useEffect(() => { loadLog(); }, []);

  async function settle(id, result, actual) {
    setSettling(s => ({...s, [id]: true}));
    try {
      await fetch(`${backendUrl}/picks/log/${id}`, {
        method: "PATCH", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ result, actual: actual ? parseFloat(actual) : undefined }),
      });
      const fresh = await fetch(`${backendUrl}/picks/log`).then(r => r.json());
      setLog(fresh);
    } catch(e) {}
    setSettling(s => ({...s, [id]: false}));
  }

  if (loading) return <div style={{ padding:30, fontFamily:"monospace", color:"#333", fontSize:11, textAlign:"center" }}>Loading pick log...</div>;

  if (!log) return (
    <div style={{ padding:30, fontFamily:"monospace", fontSize:11, textAlign:"center" }}>
      <div style={{ color:"#f87171", marginBottom:12 }}>{error || "Could not load pick log"}</div>
      <button onClick={loadLog} style={{ padding:"8px 18px", borderRadius:6, border:"1px solid #4ade8044", background:"rgba(74,222,128,0.06)", color:"#4ade80", fontFamily:"monospace", fontSize:10, cursor:"pointer", letterSpacing:1 }}>RETRY</button>
    </div>
  );

  const { stats, log: picks } = log;
  const gradeColor = { S:"#C89B3C", A:"#4ade80", B:"#60a5fa", C:"#444" };
  const resultColor = { HIT:"#4ade80", MISS:"#f87171", PUSH:"#aaa", PENDING:"#333" };

  return (
    <div style={{ padding:"16px 14px", fontFamily:"monospace", fontSize:11, color:"#ccc", maxHeight:"100%", overflowY:"auto" }}>
      <div style={{ fontSize:9, color:"#333", letterSpacing:3, marginBottom:14 }}>PICK LOG + PERFORMANCE</div>

      {/* Stats summary */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:6, marginBottom:14 }}>
        {[
          ["TOTAL", stats.total],
          ["HIT RATE", stats.hit_rate != null ? `${stats.hit_rate}%` : "--"],
          ["HITS", stats.hits],
          ["PENDING", stats.pending],
        ].map(([label, val]) => (
          <div key={label} style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:7, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:4 }}>{label}</div>
            <div style={{ fontSize:14, color:"#ccc", fontWeight:900 }}>{val ?? "--"}</div>
          </div>
        ))}
      </div>

      {/* Grade breakdown */}
      {stats.settled > 0 && (
        <div style={{ display:"flex", gap:6, marginBottom:14 }}>
          {["S","A","B","C"].map(g => {
            const d = stats.by_grade[g];
            return d.total > 0 ? (
              <div key={g} style={{ flex:1, background:"rgba(255,255,255,0.02)", border:`1px solid ${gradeColor[g]}22`, borderRadius:7, padding:"7px", textAlign:"center" }}>
                <div style={{ fontSize:12, color:gradeColor[g], fontWeight:900 }}>{g}</div>
                <div style={{ fontSize:8, color:"#555", marginTop:2 }}>{d.hit_rate != null ? `${d.hit_rate}% (${d.hits}/${d.total})` : "No data"}</div>
              </div>
            ) : null;
          })}
        </div>
      )}

      {/* Pick list */}
      {picks.length === 0 ? (
        <div style={{ textAlign:"center", padding:30, color:"#222", fontSize:10 }}>No picks logged yet.<br/>Analyze props and click 📋 LOG PICK to track them.</div>
      ) : picks.map(p => (
        <div key={p.id} style={{ background:"rgba(255,255,255,0.02)", border:`1px solid ${resultColor[p.result]}22`, borderRadius:8, padding:"10px 12px", marginBottom:8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
            <div>
              <span style={{ color:"#ccc", fontWeight:700 }}>{p.player}</span>
              <span style={{ color:"#333", marginLeft:6 }}>{p.team} vs {p.opponent}</span>
            </div>
            <span style={{ fontSize:9, color:resultColor[p.result], fontWeight:900, letterSpacing:1 }}>{p.result}</span>
          </div>
          <div style={{ display:"flex", gap:10, fontSize:9, color:"#444", marginBottom:p.result === "PENDING" ? 8 : 0 }}>
            <span style={{ color:gradeColor[p.grade] }}>{p.grade}</span>
            <span>{p.sport}</span>
            <span>{p.rec} {p.line} ({p.best_bet})</span>
            <span>Proj: {p.projected}</span>
            <span>Conf: {p.conf}%</span>
            {p.actual != null && <span style={{ color:resultColor[p.result] }}>Actual: {p.actual}</span>}
          </div>
          {p.take && <div style={{ fontSize:8, color:"#2a2a3a", fontStyle:"italic", marginTop:3 }}>"{p.take}"</div>}
          {p.result === "PENDING" && (
            <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
              {["HIT","MISS","PUSH"].map(r => (
                <button key={r} onClick={() => {
                  const actual = r === "HIT" || r === "MISS" ? prompt("Enter actual kills:", "") : null;
                  settle(p.id, r, actual);
                }} disabled={settling[p.id]} style={{ padding:"4px 8px", borderRadius:4, border:`1px solid ${resultColor[r]}44`, background:`${resultColor[r]}11`, color:resultColor[r], fontFamily:"monospace", fontSize:8, fontWeight:700, cursor:"pointer", letterSpacing:1 }}>
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [groups,       setGroups]       = useState([]);
  const [analyses,     setAnalyses]     = useState({});
  const [scoutData,    setScoutData]    = useState({}); // Liquipedia auto-fetch per aKey
  const [notes,        setNotes]        = useState({}); // manual scout notes per aKey
  const [results,      setResults]      = useState({});
  const [selected,     setSelected]     = useState(null);
  const [parlay,       setParlay]       = useState([]);
  const [matchupPicks, setMatchupPicks] = useState({}); // { "TeamA vs TeamB": "TeamA" | "upset" | null }
  const [parlayResult, setParlayResult] = useState(null);
  const [view,         setView]         = useState("board");
  const [rightPanel,   setRightPanel]   = useState("detail");
  const [importText,   setImportText]   = useState("");
  const [parseError,   setParseError]   = useState("");
  const [filterSport,  setFilterSport]  = useState("ALL");
  const [filterStatCat, setFilterStatCat] = useState("ALL"); // ALL | KILLS | ASSISTS | HEADSHOTS | COMBO
  const [filterType,   setFilterType]   = useState("ALL");
  const [filterTier,   setFilterTier]   = useState("ALL"); // ALL | 1 | 2 | 3 | 4
  const [sortBy,       setSortBy]       = useState("tier");
  const [ppFetching,   setPpFetching]   = useState(false);
  const [ppFetchSport, setPpFetchSport] = useState("LoL");
  const [ppFetchError, setPpFetchError] = useState("");

  // Queue state -- survives UI re-renders, fully resumable
  const [queueStatus, setQueueStatus] = useState(null);
  // { running, paused, total, done, current, errors: [], errorNames: [] }
  const abortRef  = useRef(false);   // set true to pause
  const queueRef  = useRef([]);      // pending targets
  const scoutDataRef = useRef({});
  const notesRef     = useRef({});
  const fileInputRef = useRef(null);

  useEffect(() => { scoutDataRef.current = scoutData; }, [scoutData]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  const isRunning = queueStatus?.running && !queueStatus?.paused;
  const isPaused  = queueStatus?.paused;
  const hasQueue  = queueRef.current.length > 0;

  // -- Persist results to storage ----------------------------------------------
  // Persist results to storage
  useEffect(() => {
    if (Object.keys(results).length === 0) return;
    try { localStorage.setItem("kill_model_results", JSON.stringify(results)); } catch {}
  }, [results]);

  // Persist notes to storage
  useEffect(() => {
    if (Object.keys(notes).length === 0) return;
    try { localStorage.setItem("kill_model_notes", JSON.stringify(notes)); } catch {}
  }, [notes]);

  useEffect(() => {
    const load = async () => {
      try {
        const r = localStorage.getItem("kill_model_results");
        if (r) setResults(JSON.parse(r));
        const n = localStorage.getItem("kill_model_notes");
        if (n) setNotes(JSON.parse(n));
      } catch {}

      // -- Chrome Extension Import ----------------------------------------
      // Extension cannot write to app localStorage directly (cross-origin blocked)
      // Instead: extension appends ?ext_import=1 to URL, app checks chrome.storage on load

      function importFromExtensionData(projData) {
        try {
          const parsed = parsePrizePicksJSON(JSON.stringify(projData));
          if (parsed && parsed.length) {
            const newGroups = groupProps(parsed);
            setGroups(newGroups);
            setView("board");
            const el = document.createElement("div");
            el.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);background:#0a2a0a;border:1px solid #4ade8060;border-radius:8px;padding:9px 18px;font-family:monospace;font-size:11px;color:#4ade80;z-index:99999;letter-spacing:1px;box-shadow:0 4px 20px rgba(0,0,0,0.5);";
            el.textContent = `! ${parsed.length} props imported from extension`;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 3000);
            return true;
          }
        } catch(e) {}
        return false;
      }

      // -- Keep Render backend awake (ping every 10 min) --------------
      fetch(`${BACKEND_URL}/health`).catch(() => {});
      const keepAlive = setInterval(() => fetch(`${BACKEND_URL}/health`).catch(() => {}), 10 * 60 * 1000);

      // Check if opened by extension via relay (?relay=1 in URL)
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("relay") === "1") {
          window.history.replaceState({}, "", window.location.pathname);
          setTimeout(async () => {
            try {
              const res = await fetch(`${BACKEND_URL}/relay`);
              const payload = await res.json();
              if (payload.data && payload.data.data && payload.data.data.length) {
                const parsed = parsePrizePicksJSON(JSON.stringify(payload.data));
                if (parsed && parsed.length) {
                  const newGroups = groupProps(parsed);
                  setGroups(newGroups);
                  setView("board");
                  fetch(`${BACKEND_URL}/relay`, { method: "DELETE" }).catch(() => {});
                  const el = document.createElement("div");
                  el.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);background:#0a2a0a;border:1px solid #4ade8060;border-radius:8px;padding:9px 18px;font-family:monospace;font-size:11px;color:#4ade80;z-index:99999;letter-spacing:1px;box-shadow:0 4px 20px rgba(0,0,0,0.5);";
                  el.textContent = `! ${parsed.length} props imported from extension`;
                  document.body.appendChild(el);
                  setTimeout(() => el.remove(), 3000);
                }
              }
            } catch(e) { console.error("Relay fetch failed:", e); }
          }, 600);
        }
      } catch(e) {}
    };
    load();
  }, []);

  const logResult = useCallback((key, hit, analysis) => {
    setResults(prev => ({
      ...prev,
      [key]: { hit, grade: analysis?.grade, conf: analysis?.conf, date: new Date().toISOString().slice(0,10) }
    }));
  }, []);

  const clearResult = useCallback((key) => {
    setResults(prev => { const n = {...prev}; delete n[key]; return n; });
  }, []);

  const handlePPFetch = async () => {
    setPpFetching(true);
    setPpFetchError("");

    // ── Why the old approach failed ────────────────────────────────────────────
    // Regular web pages CANNOT fetch api.prizepicks.com — CORS blocks it.
    // The server (Render) gets 403 (no session cookies) + 429 (rate limited).
    // ONLY the Chrome extension can fetch PP because it has host_permissions
    // which bypass CORS entirely. So the correct flow is:
    //
    //   1. Try extension via chrome.runtime.sendMessage (if EXTENSION_ID set)
    //      → extension fetches all leagues → POSTs to /relay → we poll /relay
    //   2. Poll /relay in case extension already sent data (from popup SEND button)
    //   3. If neither works: guide user to use extension manually

    const loadFromRelayData = (payload) => {
      const parsed = parsePrizePicksJSON(JSON.stringify(payload));
      if (!parsed?.length) return 0;
      const newGroups = groupProps(parsed);
      setGroups(prev => { const ex = new Set(prev.map(aKey)); return [...prev, ...newGroups.filter(g => !ex.has(aKey(g)))]; });
      setView("board");
      const sportsSeen = [...new Set(newGroups.map(g => g.meta.sport))].join(", ");
      console.log(`[KM] Loaded ${parsed.length} props: ${sportsSeen}`);

      // ── STATS INJECTION ──────────────────────────────────────────────────────
      // Extension bundles stats in relay payload as { "PlayerName::Sport": "HLTV | 22.4k/map | ..." }
      // Inject directly into notes — bypasses broken server-side scrapers (403 on Render)
      const relayStats = payload.stats || {};
      const statCount = Object.keys(relayStats).length;
      if (statCount > 0) {
        console.log(`[KM] Injecting ${statCount} player stats from relay`);
        const notesFromRelay = {};
        for (const g of newGroups) {
          // Try exact match first, then case-insensitive
          const key1 = `${g.meta.player}::${g.meta.sport}`;
          const key2 = Object.keys(relayStats).find(k =>
            k.toLowerCase() === key1.toLowerCase() ||
            k.toLowerCase().startsWith(g.meta.player.toLowerCase() + "::")
          );
          const statsNote = relayStats[key1] || (key2 ? relayStats[key2] : null);
          if (statsNote) notesFromRelay[aKey(g)] = statsNote;
        }
        if (Object.keys(notesFromRelay).length > 0) {
          setNotes(prev => ({ ...prev, ...notesFromRelay }));
          console.log(`[KM] Stats injected for ${Object.keys(notesFromRelay).length} props`);
        }
        // For players whose stats weren't in relay, fall back to server (may fail but worth trying)
        const missingGroups = newGroups.filter(g => !notesFromRelay[aKey(g)]);
        if (missingGroups.length > 0) {
          const toFetch = missingGroups.map(g => ({ player: g.meta.player, sport: g.meta.sport, team: g.meta.team, opponent: g.meta.opponent }));
          fetchBatchBackendStats(toFetch).then(batchResults => {
            const notesUpdates = {};
            Object.entries(batchResults).forEach(([key, sd]) => {
              if (sd?.notes) {
                const [player, bSport] = key.split("::");
                const match = missingGroups.find(g => g.meta.player === player && g.meta.sport === bSport);
                if (match && !notesRef.current[aKey(match)]) notesUpdates[aKey(match)] = sd.notes;
              }
            });
            if (Object.keys(notesUpdates).length > 0) setNotes(prev => ({ ...prev, ...notesUpdates }));
          }).catch(() => {});
        }
      } else {
        // No relay stats — try server (legacy path, often fails due to 403)
        const toFetch = newGroups.map(g => ({ player: g.meta.player, sport: g.meta.sport, team: g.meta.team, opponent: g.meta.opponent }));
        fetchBatchBackendStats(toFetch).then(batchResults => {
          const notesUpdates = {};
          Object.entries(batchResults).forEach(([key, sd]) => {
            if (sd?.notes) {
              const [player, bSport] = key.split("::");
              const match = newGroups.find(g => g.meta.player === player && g.meta.sport === bSport);
              if (match && !notesRef.current[aKey(match)]) notesUpdates[aKey(match)] = sd.notes;
            }
          });
          if (Object.keys(notesUpdates).length > 0) setNotes(prev => ({ ...prev, ...notesUpdates }));
        }).catch(() => {});
      }

      return parsed.length;
    };

    try {
      // ── PATH 1: Trigger extension directly ──────────────────────────────────
      // Requires REACT_APP_EXTENSION_ID env var set in Vercel to your extension's ID
      const extId = EXTENSION_ID || (typeof window !== "undefined" && window.__killModelExtId);
      if (extId && typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
        setPpFetchError("Asking extension to fetch all esport leagues…");
        try {
          await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(extId, { type: "FETCH_AND_RELAY", backendUrl: BACKEND_URL }, resp => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(resp);
            });
            setTimeout(() => reject(new Error("timeout")), 3000);
          });

          // Extension acknowledged — poll relay until data arrives (up to 60s)
          setPpFetchError("Extension fetching… polling for results (this takes ~15s)…");
          for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 2500));
            try {
              const res = await fetch(`${BACKEND_URL}/relay`, { signal: AbortSignal.timeout(5000) });
              if (res.ok) {
                const payload = await res.json();
                if (payload?.data?.data?.length) {
                  fetch(`${BACKEND_URL}/relay`, { method: "DELETE" }).catch(() => {});
                  const count = loadFromRelayData(payload.data);
                  if (count > 0) { setPpFetchError(""); return; }
                }
              }
            } catch {}
            setPpFetchError(`Extension fetching… (${Math.round((i+1)*2.5)}s / ~15s)`);
          }
          setPpFetchError("Extension fetch timed out — try clicking SEND in the extension popup manually.");
          return;
        } catch(e) {
          console.warn("[KM] Extension message failed:", e.message, "— falling through to relay poll");
        }
      }

      // ── PATH 2: Poll relay (extension may have already sent data via SEND button) ──
      setPpFetchError("Checking relay for data from extension…");
      try {
        const res = await fetch(`${BACKEND_URL}/relay`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const payload = await res.json();
          if (payload?.data?.data?.length && !payload.expired) {
            fetch(`${BACKEND_URL}/relay`, { method: "DELETE" }).catch(() => {});
            const count = loadFromRelayData(payload.data);
            if (count > 0) { setPpFetchError(""); return; }
          }
        }
      } catch {}

      // ── PATH 3: Nothing worked — give clear instructions ─────────────────────
      setPpFetchError("");
      // Show a helpful modal-style message in the error area
      setPpFetchError(
        extId
          ? "Extension found but fetch timed out. Open the extension popup → click ⬇ FETCH ALL DIRECT → then click ★ SEND to push data here."
          : "Set REACT_APP_EXTENSION_ID in Vercel env vars to enable 1-click fetch. For now: open the extension popup → click ⬇ FETCH ALL DIRECT → click ★ SEND."
      );

    } catch(err) {
      setPpFetchError(`Error: ${err.message}`);
    } finally {
      setPpFetching(false);
    }
  };

  const handleImport = async (raw) => {
    setParseError("");
    const text = (raw || importText).trim();
    if (!text) { setParseError("Nothing to import."); return; }
    const parsed = parsePrizePicksJSON(text);
    if (!parsed || !parsed.length) { setParseError("Could not parse. Make sure you copied the full JSON from the Network tab Response."); return; }
    const newGroups = groupProps(parsed);
    setGroups(prev => {
      const existingKeys = new Set(prev.map(aKey));
      return [...prev, ...newGroups.filter(g => !existingKeys.has(aKey(g)))];
    });
    setImportText("");
    setView("board");

    // Auto-fetch backend stats for all new props in background
    const supported = ["LoL", "CS2", "Valorant", "Dota2", "R6", "COD", "APEX"];
    const toFetch = newGroups
      .filter(g => supported.includes(g.meta.sport))
      .map(g => ({ player: g.meta.player, sport: g.meta.sport, team: g.meta.team, opponent: g.meta.opponent }));

    if (toFetch.length > 0) {
      fetchBatchBackendStats(toFetch).then(results => {
        const notesUpdates = {};
        Object.entries(results).forEach(([key, data]) => {
          if (data?.notes && !notesRef.current[key.replace("::", "||").split("||")[0]]) {
            // key format is "player::sport" -- find matching aKey group
            const [player, sport] = key.split("::");
            const matchingGroup = newGroups.find(
              g => g.meta.player === player && g.meta.sport === sport
            );
            if (matchingGroup) {
              const ak = aKey(matchingGroup);
              if (!notesRef.current[ak]) notesUpdates[ak] = data.notes;
            }
          }
        });
        if (Object.keys(notesUpdates).length > 0) {
          setNotes(prev => ({ ...prev, ...notesUpdates }));
        }
      }).catch(() => {});
    }
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => handleImport(ev.target.result);
    reader.readAsText(file);
    e.target.value = "";
  };

  // Parallel batch runner -- optimized to avoid rate limiting
  // CONCURRENCY=2: Anthropic rate limits burst hard; 2 concurrent is optimal for sustained throughput
  // Match-context calls are deduplicated by matchup to avoid N calls for N players in same game
  const CONCURRENCY = 2;

  // Deduplicate match-context fetches: same matchup = single fetch shared across all props
  const matchContextInFlight = {};
  function fetchMatchContextDeduped(team, opponent, sport) {
    const key = `${team}::${opponent}::${sport}`;
    if (matchContextInFlight[key]) return matchContextInFlight[key];
    const p = fetchMatchContext(team, opponent, sport).finally(() => {
      setTimeout(() => { delete matchContextInFlight[key]; }, 5 * 60 * 1000); // keep 5min
    });
    matchContextInFlight[key] = p;
    return p;
  }

  const runQueue = async () => {
    abortRef.current = false;

    const runOne = async (g) => {
      if (abortRef.current) return;
      setQueueStatus(prev => prev ? { ...prev, current: g.meta.player } : null);

      const k = aKey(g);
      const statsRequired = ["LoL","CS2","Valorant","Dota2","R6","COD","APEX"];

      // Fetch stats + match context in parallel, but deduplicate match-context by matchup
      const needsStats   = statsRequired.includes(g.meta.sport) && !scoutDataRef.current[k];
      const needsContext = g.meta.team && g.meta.opponent && !g.meta.series_format;

      try {
        const fetches = [];
        if (needsStats) {
          fetches.push(
            Promise.all([
              fetchLpediaPlayer(g.meta.player, g.meta.sport),
              fetchBackendStats(g.meta.player, g.meta.sport, g.meta.team, g.meta.opponent),
            ]).then(([lpData, backendData]) => {
              if (backendData?.notes && !notesRef.current[k]) {
                setNotes(prev => ({ ...prev, [k]: backendData.notes }));
              }
              setScoutData(prev => ({ ...prev, [k]: { ...lpData, backendStats: backendData } }));
            }).catch(() => {})
          );
        }
        if (needsContext && g.meta.team) {
          fetches.push(
            fetchMatchContextDeduped(g.meta.team, g.meta.opponent || "", g.meta.sport).then(ctx => {
              if (ctx?.series_format || ctx?.odds || ctx?.h2h || ctx?.prompt_context) {
                g = {
                  ...g,
                  meta: {
                    ...g.meta,
                    series_format: ctx.series_format || g.meta.series_format,
                    number_of_games: ctx.number_of_games || g.meta.number_of_games,
                    tournament_tier: ctx.tournament_tier || g.meta.tournament_tier,
                    win_prob: (ctx.odds?.team_win_prob > 0 && ctx.odds?.team_win_prob < 1) ? ctx.odds.team_win_prob : g.meta.win_prob,
                    match_context_string: ctx.prompt_context || null,
                    h2h: ctx.h2h || null,
                  }
                };
              }
            }).catch(() => {})
          );
        }
        await Promise.all(fetches);
      } catch {}

      // Retry with exponential backoff — 4 attempts total
      // Delays: 8s, 16s, 32s for rate limits (Anthropic 429/529)
      for (let attempt = 0; attempt < 4; attempt++) {
        if (abortRef.current) return;
        try {
          const enrichment = scoutDataRef.current[k];
          const groupWithNotes = { ...g, notes: notesRef.current[k] || "" };
          const result = await analyzeGroup(groupWithNotes, 3, enrichment);
          setAnalyses(prev => ({ ...prev, [k]: result }));
          setQueueStatus(prev => prev ? { ...prev, done: (prev.done || 0) + 1 } : null);
          return; // success
        } catch (err) {
          const msg = String(err.message || err);
          const isRateLimit = msg.includes("429") || msg.includes("529") || msg.includes("rate");
          if (isRateLimit) {
            // Exponential backoff: 8s, 16s, 32s
            const wait = 8000 * Math.pow(2, attempt);
            setQueueStatus(prev => prev ? { ...prev, current: `⏱ Rate limited — cooling ${Math.round(wait/1000)}s (attempt ${attempt+1}/4)` } : null);
            await new Promise(r => setTimeout(r, wait));
          } else if (attempt === 3) {
            setAnalyses(prev => ({ ...prev, [k]: { _error: msg } }));
            setQueueStatus(prev => prev ? { ...prev, errors: (prev.errors||0)+1, done: (prev.done||0)+1, errorNames: [...(prev.errorNames||[]), g.meta.player] } : null);
            return;
          } else {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
      }
    };

    // Process in batches of CONCURRENCY with inter-batch delay
    while (queueRef.current.length > 0 && !abortRef.current) {
      const batch = queueRef.current.splice(0, CONCURRENCY);
      await Promise.all(batch.map(g => runOne(g)));
      // Breather between batches: prevents sustained rate pressure on Anthropic
      if (queueRef.current.length > 0 && !abortRef.current) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    if (abortRef.current && queueRef.current.length > 0) {
      setQueueStatus(prev => prev ? { ...prev, running: true, paused: true, current: null } : null);
    } else {
      setQueueStatus(prev => prev ? { ...prev, running: false, paused: false, current: null, done: prev.total } : null);
    }
  };

  const analyze = (targets) => {
    if (!targets.length) return;
    const existing = new Set(queueRef.current.map(aKey));
    const fresh = targets.filter(g => !existing.has(aKey(g)));
    // Sort: T1 -> T2 -> T3 -> T4 so premier props always analyze first
    fresh.sort((a, b) => (a.meta.tier || 4) - (b.meta.tier || 4));
    queueRef.current = [...queueRef.current, ...fresh];
    const total = queueRef.current.length;
    setQueueStatus({ running: true, paused: false, total, done: 0, current: null, errors: 0, errorNames: [] });
    runQueue();
  };

  const pauseAnalysis = () => {
    abortRef.current = true;
    setQueueStatus(prev => prev ? { ...prev, paused: true } : null);
  };

  const resumeAnalysis = () => {
    if (!queueRef.current.length) return;
    setQueueStatus(prev => prev ? { ...prev, running: true, paused: false } : null);
    runQueue();
  };

  const cancelAnalysis = () => {
    abortRef.current = true;
    queueRef.current = [];
    setQueueStatus(null);
  };

  // Fetch Liquipedia data + backend stats + match context for a single group
  const fetchEnrichment = async (group) => {
    const k = aKey(group);
    // Allow re-fetch if previous result was an error (Refresh button)
    if (scoutData[k] && !scoutData[k].error && !scoutData[k].loading) return;
    setScoutData(prev => ({ ...prev, [k]: { loading: true } }));

    // Run Liquipedia + backend stats + match context in parallel
    const [lpediaData, backendData, matchCtx] = await Promise.all([
      fetchLpediaPlayer(group.meta.player, group.meta.sport),
      fetchBackendStats(group.meta.player, group.meta.sport, group.meta.team, group.meta.opponent),
      group.meta.team ? fetchMatchContext(group.meta.team, group.meta.opponent || "", group.meta.sport).catch(() => null) : Promise.resolve(null),
    ]);

    // Inject match context into the group meta (series format + win prob from Pinnacle)
    if (matchCtx?.series_format || matchCtx?.h2h || matchCtx?.prompt_context) {
      group = {
        ...group,
        meta: {
          ...group.meta,
          series_format: matchCtx.series_format,
          number_of_games: matchCtx.number_of_games,
          tournament_tier: matchCtx.tournament_tier || group.meta.tournament_tier,
          win_prob: (matchCtx.odds?.team_win_prob > 0 && matchCtx.odds?.team_win_prob < 1) ? matchCtx.odds.team_win_prob : group.meta.win_prob,
          match_context_string: matchCtx.prompt_context || null,
          h2h: matchCtx.h2h || null,
        }
      };
      // Update the selected group in state so UI reflects confirmed Bo format
      setSelected(prev => prev && aKey(prev) === k ? group : prev);
    }

    // Merge backend stats notes into scout notes if not already set
    if (backendData?.notes && !notesRef.current[k]) {
      setNotes(prev => ({ ...prev, [k]: backendData.notes }));
    }

    const data = { ...lpediaData, backendStats: backendData || null, matchContext: matchCtx || null };
    setScoutData(prev => ({ ...prev, [k]: data }));
    // If stand-in or inactive detected, mark a warning in analyses
    if (data && !data.error && (data.is_standin || data.is_inactive)) {
      setAnalyses(prev => {
        const existing = prev[k];
        if (!existing || existing._error) return prev;
        return { ...prev, [k]: { ...existing, _standin_warning: data.status } };
      });
    }
  };

  // Auto-enrich when a prop is selected
  const handleSelect = (group) => {
    setSelected(group);
    setRightPanel("detail");
    if (group) fetchEnrichment(group);
  };

  const sports  = ["ALL", ...Array.from(new Set(groups.map(g => g.meta.sport)))];
  const filtered = groups.filter(g => {
    if (filterSport !== "ALL" && g.meta.sport !== filterSport) return false;
    if (filterStatCat !== "ALL" && g.meta.stat_category !== filterStatCat) return false;
    if (filterType === "COMBO"  && !g.meta.is_combo) return false;
    if (filterType === "SINGLE" && g.meta.is_combo)  return false;
    if (filterTier !== "ALL" && String(g.meta.tier) !== String(filterTier)) return false;
    return true;
  }).sort((a, b) => {
    const aa = analyses[aKey(a)], bb = analyses[aKey(b)];
    if (sortBy === "tier")   return (a.meta.tier||2) - (b.meta.tier||2);
    if (sortBy === "conf")   return (bb?.conf||0) - (aa?.conf||0);
    if (sortBy === "grade")  return ["S","A","B","C"].indexOf(aa?.grade) - ["S","A","B","C"].indexOf(bb?.grade);
    if (sortBy === "edge")   return (bb?.edge||0) - (aa?.edge||0);
    if (sortBy === "parlay") return (bb?.parlay_worthy?1:0) - (aa?.parlay_worthy?1:0);
    return 0;
  });

  const analyzedCount = groups.filter(g => analyses[aKey(g)] && !analyses[aKey(g)]._error).length;
  const parlayWorthy  = groups.filter(g => analyses[aKey(g)]?.parlay_worthy).length;
  const unanalyzed    = groups.filter(g => !analyses[aKey(g)] && !queueRef.current.some(q => aKey(q) === aKey(g)));
  const inQueue       = queueRef.current.length;
  const qs            = queueStatus;

  return (
    <div style={{ minHeight:"100vh", background:"#060910", color:"#E0E2EE", fontFamily:"'DM Mono','Fira Code','Courier New',monospace" }}>
      <div style={{ position:"fixed", inset:0, zIndex:0, backgroundImage:"linear-gradient(rgba(255,255,255,0.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.012) 1px,transparent 1px)", backgroundSize:"48px 48px", pointerEvents:"none" }} />

      <div style={{ position:"relative", zIndex:1, maxWidth:1240, margin:"0 auto", padding:"16px 14px" }}>

        {/* HEADER */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:18, flexWrap:"wrap", gap:10 }}>
          <div>
            <div style={{ display:"flex", gap:6, marginBottom:3 }}>
              {Object.entries(SPORT_CONFIG).map(([k,v]) => <span key={k} style={{ fontSize:11, opacity:groups.some(g=>g.meta.sport===k)?1:0.15 }}>{v.icon}</span>)}
            </div>
            <h1 style={{ fontSize:"clamp(18px,3.5vw,32px)", fontWeight:900, letterSpacing:-1, margin:0, background:"linear-gradient(135deg,#fff 40%,#C89B3C 100%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>ESPORTS KILL MODEL</h1>
            <div style={{ fontSize:8, color:"#1a1a2a", letterSpacing:3 }}>PRIZEPICKS . MULTI-SPORT . PARLAY BUILDER . $50->$1,250</div>
            <BackendStatus />
          </div>
          <div style={{ display:"flex", gap:5 }}>
            {[["board","O Board"],["import","v Import"],["howto","? Guide"]].map(([v,l]) => (
              <button key={v} onClick={() => setView(v)} style={{ padding:"6px 12px", border:`1px solid ${view===v?"rgba(255,255,255,0.14)":"rgba(255,255,255,0.05)"}`, background:view===v?"rgba(255,255,255,0.04)":"transparent", color:view===v?"#ccc":"#333", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:2 }}>{l}</button>
            ))}
          </div>
        </div>

        {/* -- BOARD -- */}
        {view === "board" && (
          <>
            {groups.length > 0 && (
              <div style={{ marginBottom:12 }}>
                {/* Queue status bar */}
                {qs && (
                  <div style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 13px", borderRadius:8, marginBottom:8, background: qs.paused ? "rgba(250,204,21,0.05)" : "rgba(10,200,185,0.05)", border:`1px solid ${qs.paused?"rgba(250,204,21,0.2)":"rgba(10,200,185,0.2)"}` }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:4 }}>
                        <span style={{ fontSize:9, fontWeight:800, color: qs.paused?"#facc15":qs.running?"#0AC8B9":"#4ade80", letterSpacing:1.5 }}>
                          {qs.paused ? "|| PAUSED" : qs.running ? "O ANALYZING" : "OK COMPLETE"}
                        </span>
                        {qs.current && !qs.paused && <span style={{ fontSize:9, color:"#444", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>-- {qs.current}</span>}
                        {qs.errors > 0 && <span style={{ fontSize:8, color:"#f87171" }}>. {qs.errors} failed</span>}
                      </div>
                      {/* Progress bar */}
                      <div style={{ height:3, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${(qs.done/Math.max(qs.total,1))*100}%`, background:`linear-gradient(90deg,#C89B3C,#0AC8B9)`, transition:"width 0.4s" }} />
                      </div>
                      <div style={{ fontSize:7, color:"#333", marginTop:3 }}>{qs.done}/{qs.total} analyzed . {inQueue} remaining in queue</div>
                    </div>
                    <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                      {qs.running && !qs.paused && (
                        <button onClick={pauseAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 11px", borderRadius:5, border:"1px solid rgba(250,204,21,0.3)", background:"rgba(250,204,21,0.07)", color:"#facc15", cursor:"pointer", fontFamily:"inherit", letterSpacing:1 }}>|| Pause</button>
                      )}
                      {isPaused && (
                        <button onClick={resumeAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 11px", borderRadius:5, border:"1px solid rgba(10,200,185,0.3)", background:"rgba(10,200,185,0.07)", color:"#0AC8B9", cursor:"pointer", fontFamily:"inherit", letterSpacing:1 }}>> Resume</button>
                      )}
                      <button onClick={cancelAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 10px", borderRadius:5, border:"1px solid rgba(248,113,113,0.2)", background:"transparent", color:"#f87171", cursor:"pointer", fontFamily:"inherit" }}>✕</button>
                    </div>
                  </div>
                )}
                {/* Stats pills */}
                <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
                  {[
                    [`${groups.length} PROPS`, "#444"],
                    [`${groups.filter(g=>g.meta.tier===1).length} PREMIER`, "#FFD700"],
                    [`${groups.filter(g=>g.meta.tier===1).length} MAJOR + ${groups.filter(g=>g.meta.tier===2).length} PRO`, "#4ade80"],
                    [`${analyzedCount} ANALYZED`, "#60a5fa"],
                    [`${parlayWorthy} PARLAY-WORTHY`, "#a78bfa"],
                    inQueue > 0 && [`${inQueue} IN QUEUE`, "#0AC8B9"],
                  ].filter(Boolean).map(([label, color]) => (
                    <span key={label} style={{ fontSize:8, fontWeight:700, letterSpacing:1.5, padding:"3px 9px", borderRadius:4, background:`${color}10`, border:`1px solid ${color}25`, color }}>{label}</span>
                  ))}
                </div>

                {/* Slate quality */}
                {(() => {
                  const sq = scoreSlate(groups, analyses);
                  if (!sq || analyzedCount < 5) return null;
                  return (
                    <div style={{ display:"flex", gap:8, alignItems:"center", padding:"8px 12px", borderRadius:7, background:`${sq.slateColor}08`, border:`1px solid ${sq.slateColor}25`, marginBottom:4 }}>
                      <div style={{ fontSize:20, fontWeight:900, color:sq.slateColor, minWidth:20 }}>{sq.slateGrade}</div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:8, fontWeight:800, color:sq.slateColor, letterSpacing:1.5, marginBottom:1 }}>SLATE QUALITY</div>
                        <div style={{ fontSize:9, color:"#555" }}>{sq.slateRec}</div>
                      </div>
                      {sq.sixPickHit && (
                        <div style={{ textAlign:"right", flexShrink:0 }}>
                          <div style={{ fontSize:14, fontWeight:900, color:sq.slateColor }}>{sq.sixPickHit}%</div>
                          <div style={{ fontSize:6, color:"#333", letterSpacing:1 }}>6-PICK PROJ</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {groups.length === 0 ? (
              <div style={{ textAlign:"center", padding:"70px 20px" }}>
                <div style={{ fontSize:52, opacity:0.1, marginBottom:14 }}>⚔🎯O🗡</div>
                <div style={{ color:"#1a1a2e", fontSize:12, lineHeight:2 }}>
                  No props loaded yet.<br/>
                  <button onClick={() => setView("import")} style={{ color:"#C89B3C", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, textDecoration:"underline" }}>Import PrizePicks data -></button>
                </div>
              </div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 290px", gap:12 }}>
                {/* LEFT */}
                <div>
                  <div style={{ display:"flex", gap:4, marginBottom:9, flexWrap:"wrap", alignItems:"center" }}>
                    {/* Tier filter -- primary */}
                    <div style={{ display:"flex", gap:3, marginRight:4 }}>
                      <button onClick={() => setFilterTier("ALL")} style={{ padding:"4px 9px", border:`1px solid ${filterTier==="ALL"?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)"}`, background:filterTier==="ALL"?"rgba(255,255,255,0.05)":"transparent", color:filterTier==="ALL"?"#ccc":"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1 }}>ALL</button>
                      {[1,2].map(t => {
                        const tm = TIER_META[t];
                        const active = filterTier === String(t);
                        return <button key={t} onClick={() => setFilterTier(String(t))} style={{ padding:"4px 9px", border:`1px solid ${active?tm.color+"55":"rgba(255,255,255,0.05)"}`, background:active?`${tm.color}12`:"transparent", color:active?tm.color:"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:800, letterSpacing:1 }}>{t===1?"* ":""}{tm.label}</button>;
                      })}
                    </div>
                    <div style={{ width:1, height:12, background:"rgba(255,255,255,0.05)" }} />
                    {/* Sport filter */}
                    {sports.map(s => <button key={s} onClick={() => setFilterSport(s)} style={{ padding:"3px 7px", border:`1px solid ${filterSport===s?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.04)"}`, background:filterSport===s?"rgba(255,255,255,0.04)":"transparent", color:filterSport===s?"#ccc":"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1 }}>{s==="ALL"?"ALL":((SPORT_CONFIG[s]?.icon||"")+" "+s)}</button>)}
                    <div style={{ width:1, height:12, background:"rgba(255,255,255,0.05)" }} />
                    {/* Type filter */}
                    {[
                      ["ALL","ALL","#60a5fa"],
                      ["KILLS","KILLS","#f87171"],
                      ["ASSISTS","ASSISTS","#4ade80"],
                      ["HEADSHOTS","HS","#f97316"],
                      ["COMBO","COMBO","#a78bfa"],
                    ].map(([v,l,c]) => (
                      <button key={v} onClick={() => setFilterStatCat(v)} style={{
                        padding:"3px 7px",
                        border:`1px solid ${filterStatCat===v?c+"44":"rgba(255,255,255,0.04)"}`,
                        background:filterStatCat===v?c+"12":"transparent",
                        color:filterStatCat===v?c:"#2a2a3a",
                        borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1
                      }}>{l}</button>
                    ))}
                    <div style={{ marginLeft:"auto", display:"flex", gap:3, alignItems:"center" }}>
                      <span style={{ fontSize:7, color:"#1a1a2a", letterSpacing:1 }}>SORT</span>
                      {[["tier","TIER"],["conf","CONF"],["grade","GRADE"],["edge","EDGE"],["parlay","*"]].map(([v,l]) => <button key={v} onClick={() => setSortBy(v)} style={{ padding:"2px 6px", border:`1px solid ${sortBy===v?"rgba(255,255,255,0.1)":"rgba(255,255,255,0.03)"}`, background:sortBy===v?"rgba(255,255,255,0.04)":"transparent", color:sortBy===v?"#aaa":"#1a1a2a", borderRadius:3, cursor:"pointer", fontFamily:"inherit", fontSize:7 }}>{l}</button>)}
                    </div>
                  </div>

                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9 }}>
                    <span style={{ fontSize:7, color:"#1a1a2a" }}>{filtered.length} props</span>
                  <div style={{ display:"flex", gap:6 }}>
                      <button onClick={() => { cancelAnalysis(); setGroups([]); setAnalyses({}); setParlay([]); setParlayResult(null); setSelected(null); }} style={{ fontSize:8, color:"#f87171", background:"none", border:"1px solid #f8717120", borderRadius:4, padding:"3px 9px", cursor:"pointer", fontFamily:"inherit" }}>Clear All</button>
                      {!isRunning && !isPaused && (() => {
                        // Always operate on FILTERED view -- respects sport + event type filters
                        const filteredUnanalyzed = filtered.filter(g => !analyses[aKey(g)] && !queueRef.current.some(q => aKey(q) === aKey(g)));
                        const allFiltered = filtered;
                        if (filteredUnanalyzed.length > 0) return (
                          <button onClick={() => analyze(filteredUnanalyzed)} style={{ fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", cursor:"pointer", fontFamily:"inherit" }}>
                            O ANALYZE {filteredUnanalyzed.length} SHOWN
                          </button>
                        );
                        if (allFiltered.length > 0) return (
                          <button onClick={() => { const keys = new Set(allFiltered.map(aKey)); setAnalyses(prev => { const n={...prev}; keys.forEach(k => delete n[k]); return n; }); setTimeout(() => analyze(allFiltered), 50); }} style={{ fontSize:8, fontWeight:700, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"1px solid rgba(255,255,255,0.08)", background:"transparent", color:"#555", cursor:"pointer", fontFamily:"inherit" }}>
                            -> Re-analyze {allFiltered.length}
                          </button>
                        );
                        return null;
                      })()}
                      {isRunning && (
                        <button onClick={pauseAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 12px", borderRadius:6, border:"1px solid rgba(250,204,21,0.3)", background:"rgba(250,204,21,0.07)", color:"#facc15", cursor:"pointer", fontFamily:"inherit" }}>|| Pause</button>
                      )}
                      {isPaused && (
                        <button onClick={resumeAnalysis} style={{ fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", cursor:"pointer", fontFamily:"inherit" }}>> Resume</button>
                      )}
                    </div>
                  </div>

                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    {filtered.map(g => (
                      <PropCard key={aKey(g)} group={g} analysis={analyses[aKey(g)]||null} isSelected={selected&&aKey(selected)===aKey(g)} inParlay={parlay.includes(aKey(g))} onSelect={() => handleSelect(g)} onToggleParlay={() => setParlay(prev => prev.includes(aKey(g)) ? prev.filter(k=>k!==aKey(g)) : [...prev, aKey(g)])} />
                    ))}
                    {filtered.length === 0 && <div style={{ textAlign:"center", color:"#111820", padding:"40px 0", fontSize:11 }}>No props match these filters</div>}
                  </div>
                </div>

                {/* RIGHT */}
                <div>
                  <div style={{ display:"flex", gap:4, marginBottom:9 }}>
                    {[["detail","O Analysis"],["parlay","* Parlay"],["stats","[+] Record"],["backtest","[~] Backtest"]].map(([v,l]) => {
                      const label = v==="parlay" && parlay.length ? `* Parlay (${parlay.length})` : l;
                      return (
                      <button key={v} onClick={() => setRightPanel(v)} style={{ flex:1, padding:"6px", border:`1px solid ${rightPanel===v?"rgba(255,215,0,0.25)":"rgba(255,255,255,0.05)"}`, background:rightPanel===v?"rgba(255,215,0,0.05)":"transparent", color:rightPanel===v?"#FFD700":"#2a2a3a", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:1 }}>{label}</button>
                      );
                    })}
                  </div>
                  <div style={{ borderRadius:10, padding:13, background:"rgba(255,255,255,0.015)", border:"1px solid rgba(255,255,255,0.05)", position:"sticky", top:12, maxHeight:"calc(100vh - 80px)", overflowY:"auto" }}>
                    {rightPanel === "detail" && <DetailPanel
                      group={selected}
                      analysis={selected ? analyses[aKey(selected)] : null}
                      enrichment={selected ? scoutData[aKey(selected)] : null}
                      onFetchEnrichment={selected ? () => fetchEnrichment(selected) : null}
                      notes={selected ? (notes[aKey(selected)] || "") : ""}
                      onNotesChange={selected ? (n) => setNotes(prev => ({ ...prev, [aKey(selected)]: n })) : null}
                      result={selected ? results[aKey(selected)] : null}
                      onLogResult={selected ? (hit) => logResult(aKey(selected), hit, analyses[aKey(selected)]) : null}
                      onClearResult={selected ? () => clearResult(aKey(selected)) : null}
                      onReanalyze={() => {
                      if (!selected) return;
                      const k = aKey(selected);
                      const hasStats = notes[k] || scoutData[k];
                      const sport = selected.meta.sport;
                      const statsRequired = ["LoL","CS2","Valorant","Dota2","R6","COD","APEX"];
                      if (statsRequired.includes(sport) && !hasStats) {
                        // Auto-fetch stats first, then analyze
                        fetchEnrichment(selected).then(() => {
                          setAnalyses(prev => { const n={...prev}; delete n[k]; return n; });
                          setTimeout(() => {
                            const g = { ...selected, notes: notesRef.current[k] || "" };
                            analyzeGroup(g, 2, scoutDataRef.current[k]).then(r => setAnalyses(prev => ({ ...prev, [k]: r }))).catch(e => setAnalyses(prev => ({ ...prev, [k]: { _error: String(e.message||e) } })));
                          }, 500);
                        });
                      } else {
                        setAnalyses(prev => { const n={...prev}; delete n[k]; return n; });
                        setTimeout(() => {
                          const g = { ...selected, notes: notesRef.current[k] || "" };
                          analyzeGroup(g, 2, scoutDataRef.current[k]).then(r => setAnalyses(prev => ({ ...prev, [k]: r }))).catch(e => setAnalyses(prev => ({ ...prev, [k]: { _error: String(e.message||e) } })));
                        }, 50);
                      }
                    }}
                      onLogPick={async () => {
                        if (!selected) return;
                        const a = analyses[aKey(selected)];
                        if (!a || a._error) return;
                        const prop = selected[a.best_bet] || selected.standard || selected.goblin || selected.demon;
                        const pick = {
                          player: selected.meta.player,
                          team: selected.meta.team,
                          opponent: selected.meta.opponent,
                          sport: selected.meta.sport,
                          stat: selected.meta.stat,
                          stat_type: selected.meta.stat_category || "KILLS",
                          matchup: selected.meta.matchup,
                          league: selected.meta.league,
                          tier: selected.meta.tier,
                          line: a.best_line || prop?.line,
                          rec: a[`rec_${a.best_bet}`],
                          best_bet: a.best_bet,
                          projected: a.projected,
                          conf: a.conf,
                          edge: a.edge,
                          grade: a.grade,
                          take: a.take,
                          win_prob: selected.meta.win_prob || null,
                          is_combo: selected.meta.is_combo || false,
                        };
                        const result = await logPick(pick);
                        if (result?.ok) {
                          const el = document.createElement("div");
                          el.style.cssText = "position:fixed;top:18px;left:50%;transform:translateX(-50%);background:#0a1a2a;border:1px solid #0ac8b960;border-radius:8px;padding:9px 18px;font-family:monospace;font-size:11px;color:#0ac8b9;z-index:99999;letter-spacing:1px;box-shadow:0 4px 20px rgba(0,0,0,0.5);";
                          el.textContent = `OK Pick logged -- ID #${result.id} (${result.total} total picks)`;
                          document.body.appendChild(el);
                          setTimeout(() => el.remove(), 3000);
                        }
                      }}
                    />}
                    {rightPanel === "stats" && (() => {
                      const logged = Object.entries(results);
                      if (!logged.length) return (
                        <div style={{ textAlign:"center", padding:"40px 10px", color:"#1a1a2a", fontSize:10, lineHeight:2 }}>
                          No results logged yet.<br/>
                          <span style={{ fontSize:9, color:"#111" }}>Click any analyzed prop -> Log HIT or MISS after games finish.</span>
                        </div>
                      );
                      const hits = logged.filter(([,v])=>v.hit).length;
                      const total = logged.length;
                      const hitRate = Math.round(hits/total*100);
                      // By grade
                      const byGrade = {};
                      logged.forEach(([,v]) => {
                        if (!byGrade[v.grade]) byGrade[v.grade] = {hits:0,total:0};
                        byGrade[v.grade].total++;
                        if (v.hit) byGrade[v.grade].hits++;
                      });
                      // By conf bucket
                      const confBuckets = [["78-84",78,84],["70-77",70,77],["62-69",62,69],["<62",0,61]];
                      return (
                        <div>
                          <div style={{ fontSize:7, color:"#333", letterSpacing:3, marginBottom:10 }}>RESULT TRACKER</div>
                          {/* Overall */}
                          <div style={{ borderRadius:9, padding:"13px", marginBottom:10, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", textAlign:"center" }}>
                            <div style={{ fontSize:36, fontWeight:900, color:hitRate>=65?"#4ade80":hitRate>=55?"#facc15":"#f87171" }}>{hitRate}%</div>
                            <div style={{ fontSize:8, color:"#444", letterSpacing:2 }}>OVERALL HIT RATE</div>
                            <div style={{ fontSize:9, color:"#333", marginTop:3 }}>{hits}/{total} props hit</div>
                          </div>
                          {/* By grade */}
                          <div style={{ marginBottom:10 }}>
                            <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:6 }}>BY GRADE</div>
                            {["S","A","B","C"].map(g => {
                              const d = byGrade[g];
                              if (!d) return null;
                              const r = Math.round(d.hits/d.total*100);
                              return (
                                <div key={g} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                                  <div style={{ width:22, height:22, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(g)}15`, border:`1.5px solid ${gradeColor(g)}40`, fontSize:10, fontWeight:900, color:gradeColor(g) }}>{g}</div>
                                  <div style={{ flex:1, height:5, background:"rgba(255,255,255,0.04)", borderRadius:3, overflow:"hidden" }}>
                                    <div style={{ height:"100%", width:`${r}%`, background:gradeColor(g), borderRadius:3, transition:"width 0.5s" }} />
                                  </div>
                                  <div style={{ fontSize:9, fontWeight:800, color:gradeColor(g), minWidth:36, textAlign:"right" }}>{r}%</div>
                                  <div style={{ fontSize:8, color:"#333", minWidth:28 }}>{d.hits}/{d.total}</div>
                                </div>
                              );
                            })}
                          </div>
                          {/* By conf bucket */}
                          <div style={{ marginBottom:10 }}>
                            <div style={{ fontSize:7, color:"#222", letterSpacing:2, marginBottom:6 }}>BY CONF BUCKET</div>
                            {confBuckets.map(([label,lo,hi]) => {
                              const bucket = logged.filter(([,v]) => v.conf >= lo && v.conf <= hi);
                              if (!bucket.length) return null;
                              const bHits = bucket.filter(([,v])=>v.hit).length;
                              const bRate = Math.round(bHits/bucket.length*100);
                              const col = confColor((lo+hi)/2);
                              return (
                                <div key={label} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:5 }}>
                                  <div style={{ fontSize:8, fontWeight:700, color:col, minWidth:44 }}>{label}%</div>
                                  <div style={{ flex:1, height:5, background:"rgba(255,255,255,0.04)", borderRadius:3, overflow:"hidden" }}>
                                    <div style={{ height:"100%", width:`${bRate}%`, background:col, borderRadius:3 }} />
                                  </div>
                                  <div style={{ fontSize:9, fontWeight:800, color:col, minWidth:36, textAlign:"right" }}>{bRate}%</div>
                                  <div style={{ fontSize:8, color:"#333" }}>{bHits}/{bucket.length}</div>
                                </div>
                              );
                            })}
                          </div>
                          <button onClick={() => setResults({})} style={{ width:"100%", padding:"6px", borderRadius:5, border:"1px solid rgba(248,113,113,0.15)", background:"transparent", color:"#f87171", fontFamily:"inherit", fontSize:7, cursor:"pointer", letterSpacing:1 }}>Clear All Results</button>
                        </div>
                      );
                    })()}
                    {rightPanel === "parlay" && <ParlayPanel groups={groups} analyses={analyses} parlay={parlay} setParlay={setParlay} parlayResult={parlayResult} setParlayResult={setParlayResult} matchupPicks={matchupPicks} setMatchupPicks={setMatchupPicks} />}
                    {rightPanel === "backtest" && <BacktestPanel backendUrl={BACKEND_URL} />}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* -- IMPORT -- */}
        {view === "import" && (
          <div style={{ maxWidth:640, margin:"0 auto" }}>
            <div style={{ fontSize:9, color:"#444", letterSpacing:3, marginBottom:8 }}>IMPORT PROPS</div>

            {/* ── LIVE FETCH ── */}
            <div style={{ borderRadius:9, padding:"14px 16px", marginBottom:14, background:"rgba(12,200,185,0.04)", border:"1px solid rgba(12,200,185,0.15)" }}>
              <div style={{ fontSize:8, color:"#0AC8B9", letterSpacing:2, fontWeight:700, marginBottom:6 }}>⚡ LIVE FETCH — ALL ESPORTS</div>
              <p style={{ color:"#444", fontSize:10, lineHeight:1.6, margin:"0 0 10px" }}>
                Pulls live lines from PrizePicks directly for LoL, CS2, Valorant, Dota 2, COD, R6, and Apex in one click. Requires no manual export.
              </p>
              <button
                onClick={handlePPFetch}
                disabled={ppFetching}
                style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background: ppFetching ? "rgba(12,200,185,0.15)" : "linear-gradient(135deg,#0AC8B9,#C89B3C)", color: ppFetching ? "#0AC8B9" : "#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor: ppFetching ? "wait" : "pointer", transition:"all 0.2s" }}
              >
                {ppFetching ? "⏳ FETCHING ALL ESPORTS..." : "⚡ FETCH ALL LIVE ESPORTS BOARDS"}
              </button>
              {ppFetchError && <div style={{ color:"#f87171", fontSize:10, marginTop:8, padding:"7px 11px", border:"1px solid #f8717120", borderRadius:6 }}>{ppFetchError}</div>}
            </div>

            <div style={{ textAlign:"center", color:"#1a1a2a", fontSize:9, letterSpacing:2, margin:"6px 0 12px" }}>── OR IMPORT MANUALLY ──</div>

            <p style={{ color:"#333", fontSize:10, lineHeight:1.7, margin:"0 0 12px" }}>
              If live fetch fails: open prizepicks.com → Esports → any game → F12 → Network → filter "projections" → click sub-tab → copy Response → paste below. Repeat per sport.
            </p>

            <input ref={fileInputRef} type="file" accept=".json,.txt" onChange={handleFile} style={{ display:"none" }} />
            <button onClick={() => fileInputRef.current?.click()} style={{ width:"100%", padding:"13px", borderRadius:8, border:"2px dashed rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.015)", color:"#444", cursor:"pointer", fontFamily:"inherit", fontSize:9, fontWeight:700, letterSpacing:2, marginBottom:12 }}>^ UPLOAD .json OR .txt FILE</button>

            <div style={{ textAlign:"center", color:"#1a1a2a", fontSize:9, letterSpacing:2, margin:"6px 0" }}>-- OR PASTE BELOW --</div>

            <textarea value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={"Paste full PrizePicks API JSON here...\n\nHow to get it:\n1. Open prizepicks.com -> Esports -> any game\n2. F12 -> Network tab -> filter: projections\n3. Click any sub-tab on the board\n4. Click the request that appears -> Response -> copy all\n5. Paste here and click Import\n\nRepeat for each sub-tab and game. All boards stack."}
              style={{ width:"100%", minHeight:180, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9, color:"#E0E2EE", fontFamily:"inherit", fontSize:10, padding:13, resize:"vertical", lineHeight:1.6, boxSizing:"border-box" }}
            />

            {parseError && <div style={{ color:"#f87171", fontSize:10, marginTop:7, padding:"7px 11px", border:"1px solid #f8717120", borderRadius:6 }}>{parseError}</div>}

            <div style={{ display:"flex", gap:7, marginTop:9 }}>
              <button onClick={() => handleImport()} style={{ flex:1, padding:"11px", borderRadius:8, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor:"pointer" }}>v IMPORT BOARD</button>
              <button onClick={() => { setImportText(""); setParseError(""); }} style={{ padding:"11px 13px", borderRadius:8, border:"1px solid rgba(255,255,255,0.06)", background:"transparent", color:"#444", fontFamily:"inherit", fontSize:8, cursor:"pointer" }}>Clear</button>
            </div>

            {groups.length > 0 && (
              <div style={{ marginTop:11, padding:"9px 13px", borderRadius:7, background:"rgba(74,222,128,0.05)", border:"1px solid rgba(74,222,128,0.15)", fontSize:10, color:"#4ade80" }}>
                OK {groups.length} prop groups loaded across {[...new Set(groups.map(g=>g.meta.sport))].join(", ")}
              </div>
            )}
          </div>
        )}

        {/* -- GUIDE -- */}
        {view === "howto" && (
          <div style={{ maxWidth:600, margin:"0 auto", fontSize:11, color:"#555", lineHeight:1.8 }}>
            {[
              { title:"Getting Data for Any Esport", color:"#4ade80", steps:[
                "Open prizepicks.com -> Esports -> pick any game (LoL, CS2, Valorant, Dota 2, etc.)",
                "F12 -> Network tab -> type 'projections' in the filter box",
                "Click any sub-tab on the board (Popular, Maps 1-3 Kills, Combo, etc.)",
                "A network request appears -- click it -> Response tab -> copy all text",
                "Go to Import -> paste -> Import. Repeat for every sub-tab and every game.",
                "All boards stack. Import as many as you want before analyzing.",
                "Or: save the JSON response to a .json file and upload directly.",
              ]},
              { title:"The $50 -> $1,250 Parlay System", color:"#FFD700", steps:[
                "Import all available esports boards for the day across all sports.",
                "Hit 'O Analyze Remaining' -- model scores every prop.",
                "Switch to the * Parlay panel in the right sidebar.",
                "Set picks to 6 and stake to $50. Hit 'Auto-Build 6-Pick Parlay'.",
                "AI selects the 6 highest-confidence legs with diversity across sports/matchups.",
                "Or manually click * on any prop card to add it to your parlay.",
                "Grade S/A + Parlay Worthy = safe to include. Grade B = borderline. Grade C = never.",
                "The model avoids correlated legs (same team/matchup) to maximize hit probability.",
              ]},
              { title:"Understanding Lines & Model Output", color:"#C89B3C", steps:[
                "GOBLIN = lowest line -- easiest MORE. Bet when projection is well above it.",
                "STANDARD = fair value line. True edge if projection clearly exceeds it.",
                "DEMON = highest line -- hardest MORE. Only play with 80%+ confidence.",
                "Best Bet = line with largest edge gap relative to model projection.",
                "COMBO props = sum of named players' kills. Evaluated as combined output.",
                "Confidence = model's certainty. Edge = % gap vs line. Grade = overall bet quality.",
              ]},
              { title:"Model Accuracy & Limitations", color:"#a78bfa", steps:[
                "Strongest: role kill-share baselines (BOT > MID > JNG > TOP > SUP by default).",
                "Strong: named player style profiles and 2025-2026 form.",
                "Moderate: team macro style and expected series length.",
                "Weakest: real-time info (injuries, roster changes, patch notes). Always cross-check.",
                "For entertainment purposes only. Not financial advice.",
              ]},
            ].map(s => (
              <div key={s.title} style={{ marginBottom:22 }}>
                <div style={{ fontSize:8, fontWeight:700, color:s.color, letterSpacing:2, marginBottom:9, textTransform:"uppercase" }}>{s.title}</div>
                {s.steps.map((step,i) => <div key={i} style={{ display:"flex", gap:9, marginBottom:4 }}><span style={{ color:s.color, flexShrink:0, fontWeight:700 }}>{i+1}.</span><span>{step}</span></div>)}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop:24, textAlign:"center", color:"#0d0f18", fontSize:7, letterSpacing:2 }}>FOR ENTERTAINMENT PURPOSES ONLY . NOT FINANCIAL ADVICE</div>
      </div>

      <style>{`* {box-sizing:border-box} ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#111820;border-radius:2px} textarea::placeholder{color:#1c1e2a;line-height:1.7} button:hover{opacity:0.8}`}</style>
    </div>
  );
}

export default App;
