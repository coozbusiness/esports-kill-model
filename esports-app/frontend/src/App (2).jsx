import { useState, useRef, useEffect, useCallback } from "react";

// ─── BACKEND CONFIG ───────────────────────────────────────────────────────────
// Set this to your Railway backend URL after deployment
// During local dev: http://localhost:3001
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";

// ─── SPORT CONFIG ─────────────────────────────────────────────────────────────
const SPORT_CONFIG = {
  LoL:      { color: "#C89B3C", accent: "#0AC8B9", icon: "⚔", label: "League of Legends" },
  CS2:      { color: "#F4A836", accent: "#FF6B2B", icon: "🎯", label: "Counter-Strike 2"  },
  Valorant: { color: "#FF4655", accent: "#FF91A0", icon: "◈", label: "Valorant"           },
  Dota2:    { color: "#C23C2A", accent: "#FF6B47", icon: "🗡", label: "Dota 2"             },
  R6:       { color: "#0097D6", accent: "#00C4FF", icon: "🛡", label: "Rainbow Six"        },
  COD:      { color: "#A2FF00", accent: "#7FCC00", icon: "💥", label: "Call of Duty"       },
  APEX:     { color: "#DA292A", accent: "#FF6B35", icon: "⚡", label: "Apex Legends"       },
};

const PARLAY_SIZES = {
  3: { multiplier: 5,  label: "3-Pick"   },
  4: { multiplier: 10, label: "4-Pick"   },
  5: { multiplier: 20, label: "5-Pick"   },
  6: { multiplier: 25, label: "6-Pick ★" },
};

// ─── LIQUIPEDIA ENRICHMENT ───────────────────────────────────────────────────
// Free MediaWiki API — no key, CORS via origin=* — tested and working
// Rate limit: 1 parse req / 30s per ToS — we throttle to 8s between calls
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

// Session cache — never re-fetch the same player
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
      if (name && name.length > 2) recent.push(`${name} – ${place} [${date.slice(0,7)}]`);
    }
  }

  // Bail if nothing parsed — page exists but unrecognized structure
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

// ─── BACKEND STATS FETCH ──────────────────────────────────────────────────────
// Fetches real kill stats from the backend (gol.gg / HLTV / vlr.gg)
// Returns formatted scout notes string or null on failure

const backendStatsCache = {};

async function fetchBackendStats(playerName, sport) {
  const key = `${playerName}::${sport}`;
  if (backendStatsCache[key]) return backendStatsCache[key];

  try {
    const res = await fetch(
      `${BACKEND_URL}/stats?player=${encodeURIComponent(playerName)}&sport=${encodeURIComponent(sport)}`,
      { signal: AbortSignal.timeout(12000) }
    );
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
  // props = [{ player, sport }, ...]
  try {
    const res = await fetch(`${BACKEND_URL}/stats/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.REACT_APP_ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(props),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return {};
    return res.json();
  } catch (e) {
    return {};
  }
}

// ─── TIER CLASSIFICATION ──────────────────────────────────────────────────────
// T1 = Premier/Major/World Championship level
// T2 = Regional top league (LPL, LEC, LCS, VCT etc.)
// T3 = Qualifier / Minor / Challenger / Academy
// T4 = Everything else (show leagues, open quals, amateur)

const TIER_META = {
  1: { label: "PREMIER",    color: "#FFD700", badge: "#3a2e00", desc: "World/Major/Premier events" },
  2: { label: "TIER 1 PRO", color: "#4ade80", badge: "#0f2a15", desc: "Top regional leagues"       },
  3: { label: "TIER 2",     color: "#60a5fa", badge: "#0a1a30", desc: "Qualifiers & Challengers"   },
  4: { label: "FLUFF",      color: "#444",    badge: "#111",    desc: "Show leagues & amateur"     },
};

function classifyTier(leagueName, matchup) {
  const s = (leagueName + " " + matchup).toLowerCase();

  // T1 — Premier / Major / World Championship
  if (
    s.includes("world championship") || s.includes("worlds") ||
    s.includes("msi") || s.includes("mid-season invitational") ||
    s.includes("major") || s.includes("blast premier") ||
    s.includes("esl pro league") || s.includes("iem cologne") ||
    s.includes("iem katowice") || s.includes("pgl") ||
    s.includes("champions") && (s.includes("val") || s.includes("valorant")) ||
    s.includes("vct masters") || s.includes("vct champions") ||
    s.includes("the international") || s.includes("ti ") ||
    s.includes("dpc major") ||
    s.includes("six invitational") ||
    s.includes("cdl major") || s.includes("champs")
  ) return 1;

  // T2 — Top regional pro leagues
  if (
    s.includes("lpl") || s.includes("lck") || s.includes("lec") || s.includes("lcs") ||
    s.includes("cblol") || s.includes("ljl") || s.includes("lcl") || s.includes("lco") ||
    s.includes("vct") || s.includes("valo") ||
    s.includes("blast") || s.includes("esl pro") || s.includes("faceit") ||
    s.includes("epl") || s.includes("iem") ||
    s.includes("dpc") || s.includes("dota pro circuit") ||
    s.includes("six league") || s.includes("si league") ||
    s.includes("cdl") || s.includes("call of duty league") ||
    s.includes("algs") || s.includes("apex legends global") ||
    s.includes("spring split") || s.includes("summer split") ||
    s.includes("season finals") || s.includes("playoffs")
  ) return 2;

  // T3 — Qualifiers, challengers, second-tier
  // Note: "playoff" without "s" excluded — T2 catches "playoffs" already
  if (
    s.includes("qualifier") || s.includes("qual") ||
    s.includes("challenger") || s.includes("challengers") ||
    s.includes("open qualifier") || s.includes("open qual") ||
    s.includes("academy") || s.includes("proving grounds") ||
    s.includes("minor") || s.includes("promotion") ||
    s.includes("relegation") || s.includes("road to") ||
    s.includes("last chance") || s.includes("regional qualifier")
  ) return 3;

  // T4 — everything else
  return 4;
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

// Trending count → contrarian signal
// >50k picks: line has been hammered by public, prob moved against you. Mild LESS lean.
// >100k: strong fade signal
function trendingSignal(count) {
  if (count > 100000) return "FADE_STRONG";
  if (count > 50000)  return "FADE_MILD";
  if (count > 10000)  return "NEUTRAL_HIGH";
  return "NEUTRAL";
}

function detectSport(leagueName, statType) {
  const s = (leagueName + " " + statType).toLowerCase();
  // CS2 first — "csgo" and "counter-strike" before generic "league" check
  if (s.includes("cs2") || s.includes("counter-strike") || s.includes("csgo") ||
      s.includes("blast") || s.includes("hltv") || s.includes("iem") || s.includes("esl pro"))
                                                                                   return "CS2";
  if (s.includes("valorant") || s.includes("vct") || s.includes("val esports"))   return "Valorant";
  if (s.includes("dota") || s.includes("the international") || s.includes("dpc")) return "Dota2";
  if (s.includes("r6") || s.includes("rainbow") || s.includes("siege"))           return "R6";
  if (s.includes("cod") || s.includes("call of duty") || s.includes("cdl"))       return "COD";
  if (s.includes("apex") || s.includes("algs"))                                   return "APEX";
  // LoL last — broadest patterns to avoid false matches
  if (s.includes("lol") || s.includes("league of legends") || s.includes("lpl") ||
      s.includes("lck") || s.includes("lec") || s.includes("lcs") ||
      s.includes("maps 1-3 kills") || s.includes("league"))                        return "LoL";
  return "LoL"; // fallback
}

function parsePrizePicksJSON(raw) {
  try {
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!d?.data || !Array.isArray(d.data)) return null;

    const players = {}, games = {}, leagues = {};
    (d.included || []).forEach(item => {
      if (item.type === "new_player") players[item.id] = item.attributes;
      if (item.type === "game")       games[item.id]   = item.attributes;
      if (item.type === "league")     leagues[item.id] = item.attributes;
    });

    const props = [];
    d.data.forEach(proj => {
      const a   = proj.attributes || {};
      const pid = proj.relationships?.new_player?.data?.id;
      const gid = proj.relationships?.game?.data?.id;
      const lid = proj.relationships?.league?.data?.id;
      const pl  = players[pid] || {};
      const gm  = games[gid]   || {};
      const lg  = leagues[lid] || {};

      const teams   = gm.metadata?.game_info?.teams;
      const away    = teams?.away?.abbreviation || "";
      const home    = teams?.home?.abbreviation || "";
      const matchup = away && home ? `${away} vs ${home}` : (a.description || "?");
      const plTeam  = pl.team || (a.description || "").split(" ")[0] || "?";
      const opponent = plTeam === away ? home : plTeam === home ? away : (home || away || "?");
      const leagueName = lg.name || "";
      const sport = detectSport(leagueName, a.stat_type || "");
      const tier  = classifyTier(leagueName, matchup);
      const stage = detectStage(leagueName);

      props.push({
        id: proj.id, player: pl.name || "?", team: plTeam,
        position: pl.position || "?", sport, league: leagueName, league_id: lid,
        tier, stage,
        stat: a.stat_display_name || a.stat_type || "Kills",
        line: parseFloat(a.line_score) || 0, odds_type: a.odds_type || "standard",
        is_combo: !!(pl.combo || a.event_type === "combo" || (a.stat_type||"").includes("Combo")),
        matchup, opponent, start_time: a.start_time, trending: a.trending_count || 0,
        trending_signal: trendingSignal(a.trending_count || 0),
        image_url: pl.image_url || null, adjusted_odds: a.adjusted_odds || false,
      });
    });

    return props.filter(p => p.player && p.player !== "?" && p.line > 0);
  } catch (e) {
    console.error("Parse error:", e);
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

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────────────────
function buildSystemPrompt(sport) {
  const base = `You are a sharp, unsentimental esports prop analyst. Your job is to output CALIBRATED, HONEST projections — not optimistic ones. Today: ${new Date().toDateString()}.

═══════════════════════════════════════════════
CONFIDENCE CALIBRATION — THIS IS YOUR MOST IMPORTANT RULE
═══════════════════════════════════════════════
Confidence (conf) represents your TRUE estimated probability this bet hits.
Kill props are HIGH VARIANCE events. Calibrate ruthlessly:

  55% — Near coin flip. Slight lean, minimal data or contradicting factors.
  60% — Soft lean. One or two supporting factors but real uncertainty.
  65% — Moderate edge. Multiple supporting factors, but opponent/meta unknown.
  68% — Clear edge. Role baseline strongly supports it, player form consistent.
  72% — Strong edge. All major factors aligned, low variance matchup.
  75% — Very strong. Near-locked role/style advantage, predictable series.
  78% — Max realistic confidence for most props.

HARD CEILING RULES — NEVER EXCEED THESE:
  - NEVER output conf > 78 for any single-player kill prop
  - NEVER output conf > 72 for SUP or TOP props (too volatile)
  - NEVER output conf > 75 for any COMBO prop (compounded variance)
  - NEVER output conf > 68 on any prop where the matchup is competitive/even
  - If you feel like writing 80+, write 72 instead and increase edge instead

WHY: A PrizePicks player hitting 60% on a 6-pick parlay wins long-term. 
Inflated confidence destroys bankroll management. Be the sharp line, not the hype.

═══════════════════════════════════════════════
GRADE RUBRIC — SCARCE GRADES MEAN SOMETHING
═══════════════════════════════════════════════
  S  — conf ≥ 72 AND edge ≥ 15% AND role baseline clearly supports direction. RARE. Max 1-2 per full board.
  A  — conf ≥ 68 AND edge ≥ 10%. Solid prop with clear edge. Maybe 3-5 per board.
  B  — conf 62-67 OR edge 5-9%. Playable but not parlay-worthy. Most props land here.
  C  — conf < 62 OR edge < 5% OR high variance/unknown matchup. SKIP or fade.

parlay_worthy = true ONLY if grade is S or A. B and C props DO NOT belong in a 6-pick parlay targeting 25x.

═══════════════════════════════════════════════
EDGE CALCULATION
═══════════════════════════════════════════════
Edge = ((projected - line) / line) × 100, then adjust for variance:
  - Deduct 5 edge points for SUP/TOP (positional volatility)
  - Deduct 3 edge points for competitive matchups
  - Deduct 5 edge points for any COMBO prop (compounded variance)
  - Add 3 edge points for goblin line (line is already discounted)
  - Deduct 5 edge points for demon line (line is already inflated)

═══════════════════════════════════════════════
LINE TIER LOGIC
═══════════════════════════════════════════════
  GOBLIN  = line set below true EV. Easier MORE. Recommend MORE if proj > goblin by meaningful margin.
  STANDARD = fair value. Rec MORE only if projected clearly exceeds it.
  DEMON   = line set above true EV. Do NOT rec MORE unless projected is well above demon AND conf ≥ 70.
            Reccing MORE on demon with weak confidence is the single most common losing bet.

Best bet = largest (projected - line) gap AFTER variance deductions. Factor in tier discounts above.

═══════════════════════════════════════════════
VARIANCE FLAGS — AUTOMATIC CONF DEDUCTIONS
═══════════════════════════════════════════════
Apply these automatically before outputting conf:
  -5 if series could end 2-0 (short series = fewer kill opportunities)
  -4 if player role is support/anchor/healer (SUP, enchanter, Pos5, Sentinel, IGL)
  -4 if player role is island top/offlane tank (low kill-share role)
  -3 if teams are evenly matched (kills distributed unpredictably)
  -3 if player is a newcomer or has volatile recent form
  -3 if COMBO prop (each additional player compounds variance)
  -3 if Bo1 format (single map = single data point)
  -3 if draft/agent/hero pick heavily contradicts the kill prop direction
  -2 if matchup opponent is defensively strong / low-kill-pace team
  -2 if map pool favors low-kill maps (Nuke/Vertigo in CS2, Lotus in Val)
  -8 if APEX Legends (zone RNG alone justifies this across all APEX props)
  +3 if player is primary carry in the highest kill-share role (BOT/ADC/Duelist/Star Fragger)
  +2 if team is known aggressive/skirmish/kill-race style
  +2 if goblin line (line is already discounted below EV)
  +2 if map pool strongly favors high-kill maps
  +2 if teamfight draft confirmed (Dota2)
Start from 65 as a neutral baseline and apply modifiers.

═══════════════════════════════════════════════
PROJECTION MATH — SHOW YOUR WORK INTERNALLY
═══════════════════════════════════════════════
Always compute: team_kill_avg × role_share × expected_maps = raw projection
Then adjust for opponent, style, form. Round to 1 decimal.
Do NOT round up to flatter the bet.

COMBO: Sum each player's individual projection. Apply -10% variance haircut to the total.

Return ONLY valid JSON. No markdown. No preamble. No explanation outside the JSON.`;

  const sports = {

// ─────────────────────────────────────────────────────────────────────────────
LoL: `
SPORT: League of Legends — Bo3 (Maps 1-3)

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. CHAMPION PICK (highest kill variance driver — ~35% of outcome)
   Assassins/carries (Zed, Katarina, Fizz, Draven, Jinx, Caitlyn): +25-40% to role kill-share
   Utility/control (Orianna, Azir, Lulu, Karma, Zilean): -20-35% vs baseline
   Tank supports (Leona, Nautilus, Alistar): 1-3 kill avg, occasionally steal kills
   Enchanter supports (Soraka, Nami, Lulu): 0-1 kill avg — always LESS
   Engage junglers (Lee Sin, Vi, Jarvan, Hecarim carry): +15%
   Farm junglers (Graves, Karthus, Belveth PVE): -15%
   → Patch champion tier matters. Dominant meta picks inflate that role's kill-share.

2. TEAM KILL PACE (affects all player projections equally)
   High kill-pace teams (BLG, T1, Gen.G aggressive): avg 28-35 kills/map
   Standard pace (WBG, most LEC): avg 22-27 kills/map
   Passive/scaling teams (early 2024 JDG style, some KR teams): avg 18-22 kills/map
   → Use team avg as denominator. Inflates or deflates every player on that team.

3. MATCHUP PACE INTERACTION
   Aggressive vs Aggressive: kill totals spike (30-40/map)
   Aggressive vs Passive: moderate total (20-28/map), win team inflates
   Passive vs Passive: low total (15-22/map), compress all props downward
   → If both teams are passive, LESS on everyone is profitable.

4. SERIES LENGTH PROBABILITY
   Expected maps = P(2-0) × 2 + P(2-1) × 3
   Heavy favorite series: ~55% chance 2-0, so expected maps ≈ 2.45
   Even series: ~25% chance 2-0, expected maps ≈ 2.75
   → Props are live for MORE maps = more kill opportunities.
   → 2-0 risk is the #1 reason to lower projection and conf.

5. STOMP FACTOR
   Stomps (>15 kill differential) inflate winning team and DEFLATE losing team.
   Losing team BOT/MID in a stomp often ends 2-3 kills vs 7-10 projected.
   → Factor expected win probability. Favored team's carries MORE, underdog carries LESS.

6. FIRST BLOOD & EARLY GAME RATE
   Teams with high first blood rate (BLG, T1) inflate JNG/MID early kills.
   Lane swap metas reduce early kill variance.
   → JNG props are most sensitive to early game pace.

7. PATCH CONTEXT
   Kill-inflated patches (assassin buffs, ADC items): all kill props trend MORE
   Defensive patches (tank/support buffs): compress kill counts league-wide
   → Always note current patch direction.

ROLE KILL-SHARE BASELINES (apply after pace and pick adjustments):
  BOT:  25-35% team kills/map. Most consistent floor regardless of meta.
  MID:  20-30%. Highest variance — hero-dependent. Assassin MID = 28-30%, utility = 18-22%.
  JNG:  16-24%. Ganking style = upper range. Farm path = lower. Most patch-sensitive role.
  TOP:  10-18%. Island tops (Fiora, Camille) = 10-13%. TP fighters = 15-18%.
  SUP:  3-8%. Engage = 4-8%. Enchanter = 0-3%. Never parlay a SUP kill prop.

Bo3 PROJECTION FORMULA:
  raw = team_kill_avg × role_share × expected_maps
  Adjust: ×1.15 for aggressive team, ×0.85 for passive team
  Adjust: ×0.80 for stomp underdog, ×1.10 for stomp favorite
  Adjust for champion pick tier (see above)

PLAYER PROFILES — LCK (2025-2026):
  T1:
    Faker    (T1 MID)  — GOAT, consistent 5-8 kills/map, utility-first but spikes on assassins
    Gumayusi (T1 BOT)  — top ADC, 7-10 kills/map on carry picks, very reliable floor
    Keria    (T1 SUP)  — elite support, 1-3 kills, never play kill props
    Oner     (T1 JNG)  — kill-hungry jungler, 4-7 kills/map
    Zeus     (T1 TOP)  — strong fighter top, 4-6 kills/map
  Gen.G:
    Chovy    (GEN MID) — one of best mids in world, consistent 7-10 kills/map
    Peyz     (GEN BOT) — elite ADC, 7-9 kills/map, reliable MORE props
    Peanut   (GEN JNG) — proactive, 4-6 kills/map
    Doran    (GEN TOP) — above avg for role, 3-5 kills/map
  KT Rolster:
    Kiin     (KT TOP)  — fighter top, 4-7 kills/map on carry picks
    Pyosik   (KT JNG)  — aggressive, 4-7 kills/map
    BDD      (KT MID)  — veteran carry, 6-8 kills/map
    Aiming   (KT BOT)  — top ADC, 7-10 kills/map, very consistent

PLAYER PROFILES — LCS (2025-2026):
  Cloud9, TL, 100T rosters volatile — use role baselines + team pace.
  Note: LCS is T2 but kill counts run ~15-20% lower than LCK/LPL (slower meta).

TEAM STYLE REFERENCE (2025-2026):
  BLG:  Aggressive, high kill pace (~30/map). All carries inflate.
  WBG:  Balanced, moderate pace (~24/map).
  LYON: Aggressive EU, Berserker-led (~27/map).
  KC, GX: Standard LEC pace (~22-25/map).
  TL:   Developing, moderate, volatile (~20-24/map).

PLAYER PROFILES (2025-2026):
  LPL:
    knight   (BLG MID) — elite carry mid, top kill-share, roamer, assassin/carry pool
    Viper    (BLG BOT) — prolific ADC, consistent 7-10 kills/map on carry picks
    Bin      (BLG TOP) — above avg for TOP, TP fighter style, 4-6 kills/map
    Xun      (BLG JNG) — kill-hungry, early invades, ganking jungler
    Xiaohu   (WBG MID) — veteran, consistent 5-7, not explosive
    Elk      (WBG BOT) — strong laner, 6-8 kills/map
    Zika     (WBG TOP) — skirmish top, above avg role share
  LEC:
    Berserker (LYON BOT) — elite ADC, highest kill-share BOT in LEC, 7-9/map
    Saint    (LYON MID) — aggressive, high kill-share, carry-oriented
    Inspired (LYON JNG) — proactive, inflates early kills
    Canna    (KC TOP)   — avg TOP, 3-5/map
    kyeahoo  (KC MID)   — capable carry, 5-7/map
    Caliste  (KC BOT)   — skilled ADC, 6-8/map
    Jackies  (GX MID)   — experienced carry, reliable 5-7/map
    Noah     (GX BOT)   — consistent ADC, 5-7/map
    Morgan   (TL TOP)   — consistent import, avg 3-5/map
    Quid     (TL MID)   — newcomer, volatile, cap at 65% conf
    Yeon     (TL BOT)   — developing ADC, inconsistent`,

// ─────────────────────────────────────────────────────────────────────────────
CS2: `
SPORT: Counter-Strike 2

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. MAP POOL (single highest predictor of kill count — ~40% of outcome)
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
   → Map pool determines 35-40% of kill count. Always factor veto preferences.

2. PLAYER ROLE / IN-GAME FUNCTION
   Star Fragger / Primary AWP: 22-30 kills/map avg. Most consistent kill floor.
   Entry Fragger: 18-25 kills/map. High ceiling, dies often — volatile.
   Secondary AWP/Rifler: 18-24 kills/map. Consistent but not spectacular.
   IGL (in-game leader): 14-20 kills/map. Takes safe positions, calls over fragging.
   Support (throw flashes, trade): 12-18 kills/map. Lowest floor.
   Lurk: 15-22 kills/map. Timing-dependent, round-economy sensitive.

3. RATING / KILL EFFICIENCY
   HLTV Rating 1.20+: Top-tier fragger, consistently exceeds lines.
   HLTV Rating 1.05-1.19: Reliable, hits standard lines.
   HLTV Rating 0.95-1.04: Mediocre fragger, lines often too high.
   HLTV Rating <0.95: Support/IGL profile — fade kill props.
   → Rating is the #2 predictor after map pool.

4. CT vs T SIDE DYNAMICS
   CT-sided maps (Nuke, Vertigo): T-side fragging reduced, CT AWPers inflate.
   T-sided maps (Inferno, Overpass): Entry fraggers spike on attack.
   → Players with dominant CT-side on CT-heavy maps = kill inflation.

5. SERIES LENGTH & FORMAT
   Bo3: Expected maps = 2.4. Each map ~28-32 rounds (avg with pistol rounds).
   Short series risk (Bo1): single-map = single data point, highest variance.
   Bo3 expected total kills per player: role_avg × 2.4 maps.
   → Bo1 gets -6 conf automatically vs Bo3.

6. OPPONENT DEFENSIVE STYLE
   Passive CT teams (anchor heavy, no aggression): reduce entry fragger kills.
   Aggressive CT teams (wide peeks, take duels): inflate entry fragger kills.
   AWP-heavy opponents: reduce star rifler kills (more passive positioning required).

7. ECONOMY STATE / ECO ROUND RATE
   Teams with frequent pistol/eco rounds reduce per-round kills for the winning team.
   Anti-eco rounds inflate kill counts for stars (+3-5 kills/series).
   → Factor average round count and economic patterns.

8. SERIES STAKES / ELIMINATION PRESSURE
   Elimination games: teams play aggressive, total kills spike.
   Group stage with seeding locked: conservative play, kill counts compress.

KILL PROJECTION FORMULA:
  raw = role_avg_per_map × expected_maps
  Adjust: ×1.2 for high kill maps, ×0.8 for low kill maps
  Adjust: ×1.1 for Rating > 1.15, ×0.9 for Rating < 1.0
  Adjust: ×0.85 for IGL/Support role
  Adjust: ×0.92 for Bo3 short series risk

PLAYER PROFILES — CS2 (2025-2026):
  Team Vitality:
    ZywOo    (Vitality) — best AWPer in world, Rating ~1.35+, 22-30 kills/map. Elite.
    apEX     (Vitality IGL) — ~14-18 kills/map. Fade kill props vs star fraggers.
    flameZ   (Vitality) — star rifler, Rating ~1.15, 18-24 kills/map.
  NAVI:
    s1mple   (NAVI, if active) — legendary AWP, Rating 1.3+, 22-32 kills/map.
    iM       (NAVI) — solid fragger, 18-22 kills/map.
  FaZe Clan:
    karrigan (FaZe IGL) — low kill floor (~12-16/map). Always LESS on kill props.
    ropz     (FaZe) — elite rifler, Rating ~1.2, 20-27 kills/map.
    rain     (FaZe) — entry fragger, volatile, 18-25 kills/map.
  G2:
    NiKo     (G2) — elite rifler, Rating ~1.25, 22-29 kills/map. Reliable.
    huNter   (G2) — secondary star, Rating ~1.1, 18-23 kills/map.
    m0NESY   (G2) — AWP/hybrid, Rating ~1.2+, 20-27 kills/map.`,

// ─────────────────────────────────────────────────────────────────────────────
Valorant: `
SPORT: Valorant

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. AGENT PICK (highest kill predictor — ~38% of outcome)
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
     Clove: newer duelist-adjacent controller — slightly higher kill rate.
   SENTINEL (lowest kill rate):
     Killjoy/Cypher: anchoring, trap kills only.
     Deadlock: similar floor.
   → Never parlay Killjoy/Cypher props on kill counts. Almost always LESS.

2. ACS (AVERAGE COMBAT SCORE) — most reliable player-level metric
   ACS 250+: Elite fragger, consistently over lines.
   ACS 200-249: Solid, hits standard lines.
   ACS 160-199: Utility/support player — lines often too high.
   ACS <160: Lean LESS on any kill prop.

3. MAP CHARACTERISTICS
   HIGH kill rate maps: Haven (3 sites = more fights), Split (vertical, many duels), Breeze (long angles, AWP festival)
   LOW kill rate maps: Lotus (triple site = spread kills), Fracture (attacker spawn control), Pearl (slow pace)
   → Attacking half produces more kills than defending (attackers force duels to plant).

4. FIRST BLOOD RATE
   High FB rate players = early kill access = more total kills/map.
   Duelists with high FB% spike kill counts on aggressive maps.
   → FB rate is the #3 predictor for duelist props.

5. ATTACKING VS DEFENDING HALF WIN RATE
   Attacker-dominant teams produce more duelist kills (force duels to plant).
   Defender-dominant teams: kills distributed — sentinel/controller kills spike relatively.
   → Player's attacking half performance matters more for kill props.

6. SERIES FORMAT & OVERTIME
   Bo3. Expected maps: 2.4. Overtime (13-13) adds 4-8 rounds = +3-5 kills.
   Overtime probability ~15% on even matchups. Factor as small upside.
   Valorant map avg: 25-30 kills/player over full map.

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
  raw = role_avg × expected_maps
  Adjust: ×1.25 if playing Jett/Reyna, ×0.75 if playing Killjoy/Cypher
  Adjust: ×1.15 for high-kill maps, ×0.85 for low-kill maps
  Adjust: ×1.1 for ACS 250+, ×0.9 for ACS <175

PLAYER PROFILES — VCT (2025-2026):
  Sentinels:
    TenZ     (SEN Duelist) — top mechanical fragger, ACS 250+, 22-30 kills/map on Jett/Reyna
    Zellsis  (SEN Flex) — solid fragger, ACS ~210, 18-24 kills/map
  NRG:
    Victor   (NRG Duelist) — aggressive, ACS ~230, 20-26 kills/map
    crashies (NRG Initiator) — consistent, ACS ~195, 16-22 kills/map
  Cloud9:
    yay      (C9 Duelist/Op) — elite aim, ACS ~240, 20-28 kills/map when playing Jett
    xeppaa   (C9 Flex) — solid, ACS ~210, 17-23 kills/map
  Note: VCT agent picks vary week-to-week. ALWAYS check current agent assignment.
  Killjoy/Cypher players: ACS often 160-185, kills 12-18/map. Lean LESS always.`,

// ─────────────────────────────────────────────────────────────────────────────
Dota2: `
SPORT: Dota 2

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. HERO DRAFT / GAME PLAN (highest predictor — ~42% of outcome)
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
   → Teamfight vs splitpush is the single most important Dota factor.

2. GAME LENGTH (directly determines kill count — 35% weight)
   <30 min (stomp/fast push): 15-25 total kills. COMPRESSES ALL props.
   30-45 min (standard): 30-50 total kills. Most props set around this.
   45-60 min (long/contested): 50-75 total kills. INFLATES carry/mid props dramatically.
   60+ min (ultra-late): 70-100+ kills. Carry kill-share explodes (Pos 1 can have 20+ kills).
   → Game length is the single biggest swing factor in Dota kill props.
   → Bo3 expected maps 2.4. Each game is independent — no carry-over.

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
     Short games: 2-4 kills. Very low — protected, farming.
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
  base = position_avg × expected_games
  Adjust: ×1.5 for teamfight draft, ×0.7 for splitpush draft
  Adjust: ×0.6 for expected short game (<30 min), ×1.4 for expected long game (45+ min)
  Adjust: ×0.8 for Pos1 if team is likely to stomp (hero avoidance compresses kills)`,

// ─────────────────────────────────────────────────────────────────────────────
COD: `
SPORT: Call of Duty (CDL format)

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. GAME MODE (most important single factor — determines kill rate entirely)
   HARDPOINT (HP):
     Highest kill mode. 250 points to win. ~90-110 kills/team/map.
     Per-player avg: 22-30 kills. Primary fragger role = 25-35.
     Kill props are most reliable in HP — consistent pace.
   SEARCH AND DESTROY (SnD):
     LOWEST kill mode. 6v6, one life, best of 11 rounds.
     Per-player avg: 4-9 kills/map. Lines set very low (2.5, 3.5, etc.)
     Opener fragger role: 6-9 kills. Support/IGL: 3-5 kills.
     Variance: HIGH. One round can end with 0 kills.
   CONTROL:
     Medium kill mode. Zones contested, 3 rounds max.
     Per-player avg: 14-22 kills.
     Fragger role: 18-25. Objective player: 12-17.
   → ALWAYS identify which mode the prop is for. Lines differ massively.
   → If mode unknown, apply medium variance and reduce conf -5.

2. PLAYER ROLE / FUNCTION
   Primary Fragger (Flex): 25-35 kills in HP, 6-9 in SnD. Most consistent.
   Secondary Fragger (AR): 20-28 HP, 5-8 SnD.
   SMG / Rush: 22-30 HP (objective-based kills), 4-7 SnD.
   Anchor / Support: 14-20 HP, 3-6 SnD.
   IGL: Usually secondary fragger stats. Lower kill floor.
   Sniper: High skill variance. 18-28 HP on sniper-friendly maps.

3. MAP POOL
   HIGH kill maps: Raid, Terminal, Highrise, Estate — open sightlines, many engagements.
   LOW kill maps: Tuscan, Karachi — methodical, cover-heavy.
   → Map pool affects kill count by 15-25%. Know which maps teams prefer/veto.

4. SPAWN TRAP POTENTIAL
   Teams that dominate spawns (especially in HP) can run up kill counts dramatically.
   Strong spawn trappers: historically OpTic, Rokkr aggressive rotations.
   → Spawn trap = fragger kill counts spike to 30-40 in HP.

5. SERIES FORMAT
   CDL Majors: Bo5 series. More maps = more kill opportunities.
   Pool play: Bo3. Expected maps 2.4.
   → Always confirm format and multiply role avg accordingly.

6. OPPONENT DEFENSIVE QUALITY
   Passive opponents (hold sightlines, minimal aggression): reduce fragger kills.
   Aggressive opponents (chase kills, trade): inflate fragger kill counts both ways.

ROLE KILL-SHARE:
  Primary Fragger:   28-35% total team kills per map (HP)
  Secondary Fragger: 22-27%
  SMG/Flex:          20-25%
  Anchor/Support:    15-20%
  → SnD: all shares compress dramatically, flat 4-9 kills per player per map.

PROJECTION FORMULA (HP):
  raw = role_avg_per_map × expected_maps (2.4 for Bo3)
  Adjust: ×1.2 for high kill maps, ×0.85 for low kill maps
  Adjust: ×1.15 for spawn trap potential, ×0.9 for balanced matchup`,

// ─────────────────────────────────────────────────────────────────────────────
R6: `
SPORT: Rainbow Six Siege

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. MAP POOL (highest predictor — maps have wildly different kill rates)
   HIGH kill maps (contested, many angles):
     Villa: large map, many entry points, kill rate high.
     Oregon: tight hallways, aggressive entries = kills.
     Chalet: kitchen area = constant duels.
     Consulate: front yard aggression = many early picks.
   LOW kill maps:
     Bank: vault-heavy, methodical, anchor-friendly.
     Coastline: roamers avoided, kills compressed.
     Theme Park: large site, spreads kills.
   → Map preference/veto history is critical for R6 kill props.

2. ATTACKER vs DEFENDER ROLE
   Attack:
     Hard breachers (Thermite, Hibana): push sites, get kills in site entry.
     Flankers (Ash, Sledge, Zofia): mobile, get picks before site entry.
     Intel fraggers (Lion, Zero): secondary fragger role.
   Defense:
     Roamers (Jäger, Bandit, Vigil): aggressive, chase kills outside site = 2-5 kills/map.
     Anchor (Echo, Maestro, Pulse): passive, 0-2 kills/map.
     Flex (Valkyrie, Doc): support, 1-3 kills/map.
   → Roam-heavy defenders spike kills. Anchor defenders: always LESS.

3. ROUND FORMAT
   Pro League: Bo1 maps in a series (first to X wins). Each map 12 rounds max.
   Per-player avg: 3-8 kills per map. Stars: 5-10.
   Total series kills: (role_avg × maps_played).
   → Very low absolute numbers. Lines often 3.5-6.5.

4. OPENING DUEL WIN RATE
   High opening win rate players (Necrox, Canadian historically): kill spikes.
   Players known for 1v1 clutch: elevated kill props.
   → Opening duel rate is the best individual metric for R6 fraggers.

5. SERIES STAKES
   Elimination rounds: aggressive play, more duels, kills inflate.
   Already qualified/eliminated: passive play, conservative, kills compress.

KILL AVERAGES PER MAP:
  Star Fragger:     5-9 kills/map
  Secondary:        3-6 kills/map
  Roamer:           3-5 kills/map
  Anchor/Utility:   1-3 kills/map
  → Apply ×maps_expected for series total.`,

// ─────────────────────────────────────────────────────────────────────────────
APEX: `
SPORT: Apex Legends (ALGS format)

━━━ KILL CORRELATION FACTORS — ranked by predictive weight ━━━

1. MATCH FORMAT (determines kill ceiling entirely)
   ALGS: 6 matches per day, 20 teams. Points = placement + kills.
   Kill points: 1 per kill. Max kills per game: theoretically 59 but realistically 10-20 for top fragger.
   Per-player avg across 6 games: 8-18 kills (3-6 stars). Elite fraggers: 15-25.
   → Multi-game format means props usually set across 6 matches combined.

2. SQUAD COMPOSITION / LEGEND PICKS (major kill driver)
   AGGRESSIVE compositions:
     Wraith + Pathfinder/Horizon + Octane/Catalyst: rotate aggressively, take duels early.
     Kill-based comps: +30-40% kill upside vs passive comps.
   PASSIVE/POINT FARM compositions:
     Gibraltar + Bangalore + Lifeline: third-party resistant, wait for end zones.
     These teams prioritize placement over kills — props trend LESS.
   FRAGGER LEGENDS:
     Wraith, Horizon, Valkyrie: high mobility = more skirmish opportunities.
     Newcastle, Gibraltar, Caustic: zone defensive = fewer proactive kills.

3. LANDING ZONE (directly determines early kill access)
   HOT DROP zones: fragments (Kings Canyon), ring console (WE), market (Olympus).
     Hot drops: +4-8 kills/game potential but death risk = inconsistency.
   SAFE zones: far from pack, loot and rotate.
     Safe landings: 0-2 kills early, rely on late-game zone duels.
   → Teams that hot-drop consistently spike kill props but with high variance.

4. ZONE RNG & ROUTING
   Favorable zone routing (team's preferred landing near final rings): less movement = more stable positioning = more duels = kills.
   Unfavorable routing (running into squads during rotations): unpredictable kill distribution.
   → Zone luck is the highest variance factor. Reduce conf -5 for any APEX prop vs other games.

5. PLAYER ROLE
   FRAGGER / IGL-FRAGGER: Primary kill engine. 4-8 kills/game avg. Series total 20-40.
   SUPPORT (healer/rez): 1-4 kills/game. Focused on keeping team alive.
   IGL (pure IGL): 2-5 kills/game, prioritizes zone/rotation calls.
   → Always identify role. Support props on kills: almost always LESS.

6. TEAM KILL-RACE TENDENCY
   Kill-race teams (NRG historically, LOUD): actively hunt squads for points.
   Placement teams (TSM passive eras): avoid fights, streak placements.
   → Kill-race teams inflate ALL player kill props.

7. RING CLOSURE PACE
   Fast ring = squads forced together early = more fights = kills.
   Slow ring = extended rotations = fewer fights = lower kills.
   → Map rotation plays influence kill rate significantly.

KILL AVERAGES (across 6 ALGS games):
  Elite Fragger:    18-28 total kills
  Star Player:      12-20 total kills
  Support/IGL:      5-12 total kills
  → APEX has the HIGHEST variance of all esports. Apply -8 conf vs LoL/CS2 baseline.
  → Never recommend APEX props above 70% conf. Zone RNG alone justifies this.

PROJECTION FORMULA:
  raw = role_avg_per_game × 6 games
  Adjust: ×1.3 for kill-race team, ×0.7 for placement team
  Adjust: ×1.2 for hot-drop landing, ×0.8 for safe landing
  Apply -8 to all APEX conf values (zone variance premium)`,

  };

  return base + (sports[sport] || sports.LoL);
}

async function analyzeGroup(group, retries = 2, enrichment = null) {
  const { standard, goblin, demon, meta, notes } = group;
  const lines = [
    goblin   && `goblin: ${goblin.line}`,
    standard && `standard: ${standard.line}`,
    demon    && `demon: ${demon.line}`,
  ].filter(Boolean).join(" | ");

  const stageContext = {
    GRAND_FINALS: "GRAND FINALS — teams play execute-heavy, calculated. Kill counts compress 15-20% vs group stage. Both teams prepared. Reduce projection slightly.",
    FINALS:       "FINALS — high stakes, methodical play. Slight kill compression vs regular season.",
    SEMIFINALS:   "SEMIFINALS — pressure game. Teams may open up or lock down depending on style.",
    QUARTERFINALS:"QUARTERFINALS — bracket play begins. Stakes elevated, slight aggression uptick.",
    PLAYOFFS:     "PLAYOFFS — elimination pressure. Aggressive play slightly elevated vs group stage.",
    GROUPS:       "GROUP STAGE — baseline stats apply. Standard kill rates.",
    REGULAR:      "REGULAR SEASON — standard kill rates.",
  };

  const trendingContext = {
    FADE_STRONG:  "TRENDING WARNING: 100k+ public picks. Line has been hammered by public money. PrizePicks has almost certainly moved this line against bettors. Treat as a mild LESS signal — public steam on PrizePicks typically means the easy side has been priced out. Reduce edge by 8% and note as contrarian fade.",
    FADE_MILD:    "TRENDING CAUTION: 50k+ picks. Public is heavy on this prop. Line may be stale or moved. Reduce edge by 4%.",
    NEUTRAL_HIGH: "Moderate public interest. Monitor but no fade signal.",
    NEUTRAL:      "Low public interest. No trending bias.",
  };

  // Build Liquipedia context string
  let lpediaContext = "";
  if (enrichment && !enrichment.error && !enrichment.loading) {
    lpediaContext = `\nLIQUIPEDIA DATA (verified ${enrichment.fetched_at}):
  Status: ${enrichment.status}${enrichment.is_standin ? " ⚠ STAND-IN — APPLY -12 CONF, HIGH RISK" : ""}${enrichment.is_inactive ? " ⚠ INACTIVE — DO NOT RECOMMEND, GRADE C" : ""}
  Team confirmed: ${enrichment.current_team || "unconfirmed"}
  Role confirmed: ${enrichment.role || "unconfirmed"}
  Recent tournaments: ${enrichment.recent_tournaments?.join(", ") || "none found"}`;
  }

  const prompt = `Analyze this ${meta.sport} PrizePicks prop:

Player: ${meta.player}
Team: ${meta.team} | Opponent: ${meta.opponent} | Position/Role: ${meta.position}
League: ${meta.league || "Unknown"} | Tier: ${TIER_META[meta.tier||4]?.label}
Stage: ${stageContext[meta.stage] || stageContext.REGULAR}
Stat: ${meta.stat}${meta.is_combo ? " (COMBO — line is combined kills of ALL named players across full series)" : ""}
Lines — ${lines}
Trending: ${meta.trending?.toLocaleString() || 0} picks — ${trendingContext[meta.trending_signal] || trendingContext.NEUTRAL}
${lpediaContext}
${notes ? `\nSCOUT NOTES (treat as highest-priority context, overrides baselines):\n${notes}` : ""}

REQUIRED ANALYSIS STEPS (do this internally before outputting):
1. Read scout notes first if present — they override role baselines
2. Apply stage context kill compression/inflation before computing projection
3. Apply trending signal edge adjustment if public steam detected
4. Compute raw projection: team_kill_avg × role_share × expected_maps
5. Apply ALL relevant variance deductions from calibration rules
6. Compute edge = ((projected - best_line) / best_line) × 100, apply tier adjustments
7. Assign grade strictly per rubric — S is rare, max 1-2 per board
8. NEVER output conf > 78. NEVER output conf > 72 for support/anchor roles. NEVER conf > 75 for COMBO.
9. If no clear edge exists on any line, grade = C, rec = SKIP
10. If a line type (goblin/standard/demon) was not provided (null), output "SKIP" for that rec — never invent a recommendation for a line that does not exist

Return ONLY this JSON (no markdown, no explanation):
{
  "rec_goblin":      "MORE" or "LESS" or "SKIP",
  "rec_standard":    "MORE" or "LESS" or "SKIP",
  "rec_demon":       "MORE" or "LESS" or "SKIP",
  "projected":       <decimal>,
  "conf":            <integer 50-78>,
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
  "variance_flags":  ["<specific flag>", ...],
  "insights":        ["<insight 1>", "<insight 2>", "<insight 3>"],
  "matchup_note":    "<one sharp sentence — specific, no generic filler>",
  "take":            "<EXACTLY 10 WORDS OR FEWER. Count them. Cut if over.>"
}`;

  // Single attempt — retry logic handled by caller (runOne in queue)
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 900,
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
    if (words.length > 10) parsed.take = words.slice(0, 10).join(" ") + "…";
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
    ).map(d => `${c.player} & ${d.player} share matchup — correlated risk`)
  ).flat();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1200,
      system: `You are a sharp DFS parlay optimizer. Your job is to maximize the TRUE combined hit probability of a ${picks}-pick Power Play.

CRITICAL MATH:
- Independent legs: P(all hit) = P1 × P2 × ... × Pn
- Correlated legs (same team/matchup): their failure is linked. If BLG loses, ALL BLG props lose together. This is WORSE than the math suggests.
- Correlated legs MUST be penalized — treat two props from the same matchup as if their combined conf is (conf1 × conf2 × 0.75) not (conf1 × conf2).

CORRELATION PENALTY RULES:
- Same team in same series: -15% to combined conf
- Same matchup (different teams): -8% to combined conf
- Different sports/matchups: no penalty (true independence)

TRENDING FADE: Disqualify any leg with trending_fade=true UNLESS no replacements exist.

KELLY CRITERION: After selecting legs, compute Kelly fraction = (p × b - q) / b where p = hit prob, b = net odds (24 for 25x), q = 1-p. Recommend stake as Kelly fraction × $1000 (assume $1000 bankroll), capped at $${stake * 2} max.

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
  "expected_value": <EV = true_conf/100 × payout - (1-true_conf/100) × stake>,
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

// ─── SLATE QUALITY SCORER ────────────────────────────────────────────────────
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
    slateRec = `STRONG SLATE — play 6-pick. ${sGrades}S + ${aGrades}A grades available.`;
  } else if ((sGrades >= 1 || aGrades >= 4) && avgConf >= 67) {
    slateGrade = "B"; slateColor = "#facc15";
    slateRec = `SOLID SLATE — 6-pick playable, consider 5-pick if conservative.`;
  } else if (aGrades >= 3 && avgConf >= 64) {
    slateGrade = "C"; slateColor = "#f97316";
    slateRec = `THIN SLATE — consider 4-pick or smaller. Limited high-conf props.`;
  } else {
    slateGrade = "D"; slateColor = "#f87171";
    slateRec = `WEAK SLATE — sit out or 3-pick only. Negative EV on 6-pick today.`;
  }

  return { slateGrade, slateColor, slateRec, parlayWorthy: parlayWorthy.length, sGrades, aGrades, avgConf: Math.round(avgConf), sixPickHit: sixPickHit ? sixPickHit.toFixed(1) : null };
}

// ─── SAME-EVENT CORRELATION DETECTOR ─────────────────────────────────────────
// Detects when two props in a parlay are from the same underlying game event
// (e.g. a player's solo kills + their combo kills — same event, not independent)
function detectSameEventConflicts(parlayGroups) {
  const conflicts = [];
  for (let i = 0; i < parlayGroups.length; i++) {
    for (let j = i + 1; j < parlayGroups.length; j++) {
      const a = parlayGroups[i].meta;
      const b = parlayGroups[j].meta;
      // Same player, same matchup = same game, different stat type
      if (a.player === b.player && a.matchup === b.matchup) {
        conflicts.push(`⚠ ${a.player} has TWO props in same game — not independent events`);
      }
      // Same team, same matchup = correlated game outcome
      if (a.team === b.team && a.matchup === b.matchup && a.player !== b.player) {
        conflicts.push(`⚡ ${a.player} + ${b.player} same team/series — correlated`);
      }
    }
  }
  return [...new Set(conflicts)];
}

// ─── STALENESS DETECTOR ───────────────────────────────────────────────────────
function isPropStale(startTime) {
  if (!startTime) return false;
  try {
    const t = new Date(startTime);
    return t < new Date();
  } catch { return false; }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const ODDS_COLORS = {
  goblin:   { bg:"#071a0f", border:"#22c55e55", text:"#22c55e", label:"GOBLIN",   badge:"#14532d" },
  standard: { bg:"#070f1f", border:"#60a5fa55", text:"#60a5fa", label:"STANDARD", badge:"#1e3a5f" },
  demon:    { bg:"#1a0707", border:"#f8717155", text:"#f87171", label:"DEMON",     badge:"#5f1e1e" },
};
const gradeColor = g => ({ S:"#FFD700", A:"#4ade80", B:"#60a5fa", C:"#f87171" })[g] || "#555";
const confColor  = c => c >= 72 ? "#4ade80" : c >= 66 ? "#facc15" : c >= 60 ? "#f97316" : "#f87171";
const riskColor  = r => ({ LOW:"#4ade80", MEDIUM:"#facc15", HIGH:"#f87171" })[r] || "#888";
const metaColor  = m => ({ FAVORABLE:"#4ade80", NEUTRAL:"#facc15", UNFAVORABLE:"#f87171" })[m] || "#888";
const trendIcon  = t => ({ UP:"↑", DOWN:"↓", STABLE:"→" })[t] || "→";
const aKey       = g => `${g.meta.player}||${g.meta.matchup}||${g.meta.stat}`;

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
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
        <div onClick={e => { e.stopPropagation(); onToggleParlay(); }} style={{ position:"absolute", top:9, right:9, width:22, height:22, borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", background:inParlay?"#FFD70022":"rgba(255,255,255,0.03)", border:`1.5px solid ${inParlay?"#FFD700":"rgba(255,255,255,0.07)"}`, fontSize:11, cursor:"pointer", color:inParlay?"#FFD700":"#2a2a3a", zIndex:2 }}>★</div>
      )}

      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:8 }}>
        <div style={{ minWidth:0, flex:1, paddingRight:26 }}>
          <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap", marginBottom:2 }}>
            <span style={{ fontSize:14, fontWeight:900, color:"#F0F2F8" }}>{meta.player}</span>
            {ok && <div style={{ width:20, height:20, borderRadius:4, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(analysis.grade)}15`, border:`1.5px solid ${gradeColor(analysis.grade)}50`, fontSize:9, fontWeight:900, color:gradeColor(analysis.grade) }}>{analysis.grade}</div>}
            {meta.is_combo && <span style={{ fontSize:8, color:"#a78bfa", fontWeight:700, padding:"1px 5px", border:"1px solid #a78bfa30", borderRadius:3 }}>COMBO</span>}
          </div>
          <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap" }}>
            <SportBadge sport={meta.sport} />
            {(() => { const tm = TIER_META[meta.tier||4]; return <span style={{ fontSize:7, fontWeight:800, padding:"1px 6px", borderRadius:3, background:`${tm.color}15`, border:`1px solid ${tm.color}35`, color:tm.color, letterSpacing:1 }}>{meta.tier===1?"★ ":""}{tm.label}</span>; })()}
            <span style={{ fontSize:9, color:"#333" }}>{meta.team} vs {meta.opponent}</span>
            {meta.position && meta.position !== "?" && <span style={{ fontSize:8, color:"#2a2a3a", padding:"1px 5px", border:"1px solid rgba(255,255,255,0.04)", borderRadius:3 }}>{meta.position}</span>}
          </div>
        </div>
        {ok ? (
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{ fontSize:18, fontWeight:900, color:"#F0F2F8", lineHeight:1 }}>{analysis.projected}</div>
            <div style={{ fontSize:7, color:"#2a2a3a", letterSpacing:1 }}>PROJ</div>
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
              <div style={{ fontSize:7, color:oc.text, letterSpacing:1, fontWeight:700 }}>{isBest?"★ "+oc.label:oc.label}</div>
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

function DetailPanel({ group, analysis, onReanalyze, notes, onNotesChange, onFetchEnrichment, enrichment, result, onLogResult, onClearResult }) {
  if (!group) return (
    <div style={{ height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:10 }}>
      <div style={{ fontSize:36, opacity:0.15 }}>◎</div>
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
          {(() => { const tm = TIER_META[meta.tier||4]; return <span style={{ fontSize:7, fontWeight:800, padding:"1px 6px", borderRadius:3, background:`${tm.color}15`, border:`1px solid ${tm.color}35`, color:tm.color, letterSpacing:1 }}>{meta.tier===1?"★ ":""}{tm.label}</span>; })()}
          <span style={{ fontSize:9, color:"#333" }}>{meta.team} vs {meta.opponent}</span>
          {meta.is_combo && <span style={{ fontSize:8, color:"#a78bfa" }}>COMBO</span>}
        </div>
        {stale && (
          <div style={{ marginTop:5, fontSize:8, color:"#f87171", padding:"3px 8px", background:"rgba(248,113,113,0.07)", border:"1px solid rgba(248,113,113,0.2)", borderRadius:4, display:"inline-block" }}>
            ⚠ GAME MAY HAVE STARTED — verify prop is still live
          </div>
        )}
        {meta.trending > 0 && (
          <div style={{ marginTop:4, fontSize:8, color: meta.trending_signal==="FADE_STRONG"?"#f87171":meta.trending_signal==="FADE_MILD"?"#f97316":"#facc15" }}>
            {meta.trending_signal==="FADE_STRONG"?"🔴":meta.trending_signal==="FADE_MILD"?"🟠":"🔥"} {meta.trending?.toLocaleString()} picks
            {meta.trending_signal==="FADE_STRONG" && " — PUBLIC FADE SIGNAL"}
            {meta.trending_signal==="FADE_MILD" && " — line likely moved"}
          </div>
        )}
      </div>

      {/* ── SCOUT DATA PANEL ── */}
      <div style={{ marginBottom:10 }}>

        {/* Liquipedia enrichment block */}
        <div style={{ marginBottom:7 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:5 }}>
            <div style={{ fontSize:7, color:"#0AC8B9", letterSpacing:2 }}>LIQUIPEDIA DATA</div>
            <div style={{ display:"flex", gap:4 }}>
              {enrichment && !enrichment.loading && enrichment.error && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#0AC8B9", background:"rgba(10,200,185,0.06)", border:"1px solid rgba(10,200,185,0.2)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>↻ Retry</button>
              )}
              {!enrichment?.loading && enrichment && !enrichment.error && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#555", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>↻ Refresh</button>
              )}
              {!enrichment?.loading && (!enrichment || enrichment.error) && (
                <button onClick={onFetchEnrichment} style={{ fontSize:7, color:"#0AC8B9", background:"rgba(10,200,185,0.06)", border:"1px solid rgba(10,200,185,0.2)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>⬇ Fetch</button>
              )}
            </div>
          </div>

          {!enrichment && (
            <div style={{ fontSize:8, color:"#1a3a3a", padding:"7px 9px", borderRadius:5, border:"1px dashed rgba(10,200,185,0.12)", lineHeight:1.6 }}>
              Click Fetch to pull live data from Liquipedia — team status, role, tournament history, stand-in flags.
            </div>
          )}
          {enrichment?.loading && (
            <div style={{ fontSize:8, color:"#0AC8B9", padding:"7px 9px", borderRadius:5, border:"1px solid rgba(10,200,185,0.15)" }}>◌ Fetching from Liquipedia…</div>
          )}
          {enrichment?.error && (
            <div style={{ fontSize:8, color:"#f87171", padding:"6px 9px", borderRadius:5, border:"1px solid rgba(248,113,113,0.15)" }}>
              ⚠ {enrichment.error === "not_found" ? "Player page not found on Liquipedia" : enrichment.error}
            </div>
          )}
          {enrichment && !enrichment.error && !enrichment.loading && (
            <div style={{ borderRadius:6, overflow:"hidden", border:"1px solid rgba(10,200,185,0.15)" }}>
              {/* Status row — most important */}
              <div style={{ padding:"6px 9px", background: enrichment.is_standin || enrichment.is_inactive ? "rgba(248,113,113,0.07)" : "rgba(10,200,185,0.05)", borderBottom:"1px solid rgba(10,200,185,0.08)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5 }}>STATUS</span>
                <span style={{ fontSize:9, fontWeight:900, color: enrichment.is_standin || enrichment.is_inactive ? "#f87171" : "#4ade80" }}>
                  {enrichment.is_standin && "⚠ "}{enrichment.is_inactive && "⚠ "}{enrichment.status}
                </span>
              </div>
              {(enrichment.is_standin || enrichment.is_inactive) && (
                <div style={{ padding:"5px 9px", background:"rgba(248,113,113,0.06)", borderBottom:"1px solid rgba(248,113,113,0.1)", fontSize:8, color:"#f87171", fontWeight:700 }}>
                  {enrichment.is_standin ? "STAND-IN DETECTED — conf auto-penalized -12pts" : "INACTIVE — recommend SKIP/grade C"}
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
                    {enrichment.backendStats.rating != null && ` · R${enrichment.backendStats.rating}`}
                    {enrichment.backendStats.acs != null && ` · ACS${enrichment.backendStats.acs}`}
                  </span>
                </div>
              )}
              {enrichment.recent_tournaments?.length > 0 && (
                <div style={{ padding:"5px 9px" }}>
                  <div style={{ fontSize:7, color:"#2a5a5a", letterSpacing:1.5, marginBottom:3 }}>RECENT EVENTS</div>
                  {enrichment.recent_tournaments.map((t,i) => (
                    <div key={i} style={{ fontSize:8, color:"#444", marginBottom:1 }}>▸ {t}</div>
                  ))}
                </div>
              )}
              <div style={{ padding:"3px 9px 5px", fontSize:6, color:"#0a2a2a" }}>Source: Liquipedia (CC-BY-SA 3.0) · {enrichment.fetched_at}</div>
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
          <div style={{ fontSize:7, color:"#C89B3C", marginTop:2 }}>✓ Notes included in next analysis</div>
        )}
      </div>

      {!analysis ? (
        <button onClick={onReanalyze} style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background:`linear-gradient(135deg,${cfg.color},${cfg.accent})`, color:"#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor:"pointer" }}>
          ◉ ANALYZE THIS PROP
        </button>
      ) : (
        <button onClick={onReanalyze} style={{ width:"100%", padding:"7px", borderRadius:7, border:"1px solid rgba(255,255,255,0.07)", background:"transparent", color:"#444", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:2, cursor:"pointer", marginBottom:10 }}>
          ↻ RE-ANALYZE
        </button>
      )}

      {analysis?._error && (
        <div style={{ textAlign:"center", padding:"18px 0" }}>
          <div style={{ color:"#f87171", fontSize:11, marginBottom:6 }}>⚠ {analysis._error}</div>
          <button onClick={onReanalyze} style={{ fontSize:8, color:"#f87171", background:"rgba(248,113,113,0.08)", border:"1px solid #f8717130", padding:"5px 12px", borderRadius:5, cursor:"pointer", fontFamily:"inherit" }}>↻ Retry</button>
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
                  {isBest && <div style={{ position:"absolute", top:-7, right:7, fontSize:7, fontWeight:900, background:oc.badge, color:oc.text, padding:"1px 6px", borderRadius:3, letterSpacing:1.5 }}>★ BEST BET</div>}
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
                <span style={{ color:cfg.color, fontSize:8, flexShrink:0, marginTop:2 }}>▸</span>
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
                  <div style={{ fontSize:16, fontWeight:900, color: result.hit ? "#4ade80" : "#f87171" }}>{result.hit ? "✓ HIT" : "✗ MISS"}</div>
                  <div style={{ fontSize:8, color:"#333" }}>{result.date} · Grade {result.grade} · {result.conf}% conf</div>
                </div>
                <button onClick={onClearResult} style={{ fontSize:7, color:"#333", background:"none", border:"1px solid rgba(255,255,255,0.05)", borderRadius:3, padding:"2px 7px", cursor:"pointer", fontFamily:"inherit" }}>clear</button>
              </div>
            ) : (
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={() => onLogResult && onLogResult(true)} style={{ flex:1, padding:"7px", borderRadius:6, border:"1px solid rgba(74,222,128,0.25)", background:"rgba(74,222,128,0.06)", color:"#4ade80", fontFamily:"inherit", fontSize:9, fontWeight:800, cursor:"pointer", letterSpacing:1 }}>✓ HIT</button>
                <button onClick={() => onLogResult && onLogResult(false)} style={{ flex:1, padding:"7px", borderRadius:6, border:"1px solid rgba(248,113,113,0.25)", background:"rgba(248,113,113,0.06)", color:"#f87171", fontFamily:"inherit", fontSize:9, fontWeight:800, cursor:"pointer", letterSpacing:1 }}>✗ MISS</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ParlayPanel({ groups, analyses, parlay, setParlay, parlayResult, setParlayResult }) {
  const [picks,      setPicks]     = useState(6);
  const [stake,      setStake]     = useState(50);
  const [building,   setBuilding]  = useState(false);
  const [buildError, setBuildError]= useState("");

  const parlaySet    = new Set(parlay);
  const parlayGroups = groups.filter(g => parlaySet.has(aKey(g)));
  const payout       = (PARLAY_SIZES[picks]?.multiplier || 25) * stake;

  const confProduct = parlayGroups.reduce((acc, g) => {
    const a = analyses[aKey(g)];
    return a?.conf ? acc * (a.conf / 100) : acc;
  }, 1);
  const estHitPct = Math.round(confProduct * 100);

  const handleBuild = async () => {
    setBuilding(true);
    setBuildError("");
    setParlayResult(null);
    try {
      const result = await buildParlayAI(groups, analyses, picks, stake);
      if (result.error) setBuildError(result.error);
      else {
        setParlayResult(result);
        setParlay(result.legs.map(l => `${l.player}||${l.matchup}||${l.stat}`));
      }
    } catch (e) { setBuildError(String(e.message||e)); }
    setBuilding(false);
  };

  return (
    <div>
      <div style={{ fontSize:7, color:"#333", letterSpacing:3, marginBottom:10 }}>PARLAY BUILDER</div>

      {/* Conf legend */}
      <div style={{ display:"flex", gap:5, marginBottom:12, flexWrap:"wrap" }}>
        {[["≥72%","STRONG","#4ade80"],["66-71%","SOLID","#facc15"],["60-65%","LEAN","#f97316"],["<60%","SKIP","#f87171"]].map(([range,label,color]) => (
          <div key={label} style={{ flex:1, minWidth:52, padding:"4px 5px", borderRadius:4, textAlign:"center", background:`${color}08`, border:`1px solid ${color}20` }}>
            <div style={{ fontSize:8, fontWeight:800, color }}>{range}</div>
            <div style={{ fontSize:6, color:"#333", letterSpacing:1 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Target */}
      <div style={{ borderRadius:9, padding:"13px", marginBottom:11, background:"linear-gradient(135deg,rgba(255,215,0,0.07),rgba(255,215,0,0.02))", border:"1px solid rgba(255,215,0,0.2)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
          <div>
            <div style={{ fontSize:7, color:"#7a6800", letterSpacing:2, marginBottom:1 }}>WEEKLY TARGET</div>
            <div style={{ fontSize:26, fontWeight:900, color:"#FFD700" }}>${payout.toLocaleString()}</div>
            <div style={{ fontSize:8, color:"#5a4800" }}>${stake} × {PARLAY_SIZES[picks]?.multiplier}x</div>
          </div>
          {parlayGroups.length > 0 && (
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:18, fontWeight:900, color:estHitPct>=15?"#4ade80":estHitPct>=8?"#facc15":"#f87171" }}>{estHitPct}%</div>
              <div style={{ fontSize:7, color:"#333", letterSpacing:1 }}>PARLAY HIT</div>
              <div style={{ fontSize:6, color:"#1a1a2a", marginTop:1 }}>legs × compounded</div>
            </div>
          )}
        </div>
      </div>

      {/* Picks + stake */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7, marginBottom:11 }}>
        <div>
          <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:4 }}>PICKS</div>
          <div style={{ display:"flex", gap:3 }}>
            {[3,4,5,6].map(n => (
              <button key={n} onClick={() => setPicks(n)} style={{ flex:1, padding:"5px 0", borderRadius:4, border:`1px solid ${picks===n?"#FFD70055":"rgba(255,255,255,0.05)"}`, background:picks===n?"rgba(255,215,0,0.07)":"transparent", color:picks===n?"#FFD700":"#333", fontFamily:"inherit", fontSize:8, fontWeight:800, cursor:"pointer" }}>{n}{n===6?"★":""}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:4 }}>STAKE ($)</div>
          <div style={{ display:"flex", gap:3 }}>
            {[25,50,100,200].map(s => (
              <button key={s} onClick={() => setStake(s)} style={{ flex:1, padding:"5px 0", borderRadius:4, border:`1px solid ${stake===s?"#FFD70055":"rgba(255,255,255,0.05)"}`, background:stake===s?"rgba(255,215,0,0.07)":"transparent", color:stake===s?"#FFD700":"#333", fontFamily:"inherit", fontSize:8, fontWeight:800, cursor:"pointer" }}>${s}</button>
            ))}
          </div>
        </div>
      </div>

      <button onClick={handleBuild} disabled={building} style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background:building?"rgba(255,255,255,0.04)":"linear-gradient(135deg,#FFD700,#F4A836)", color:building?"#333":"#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor:building?"not-allowed":"pointer", marginBottom:7 }}>
        {building ? "◌ BUILDING OPTIMAL PARLAY…" : `★ AUTO-BUILD ${picks}-PICK PARLAY`}
      </button>

      {buildError && <div style={{ fontSize:9, color:"#f87171", marginBottom:7, padding:"7px 10px", border:"1px solid #f8717125", borderRadius:6 }}>{buildError}</div>}

      {parlayResult && (
        <div style={{ borderRadius:7, padding:"9px 11px", marginBottom:9, background:"rgba(255,215,0,0.04)", border:"1px solid rgba(255,215,0,0.14)" }}>
          <div style={{ fontSize:7, color:"#FFD700", letterSpacing:2, marginBottom:4 }}>AI ANALYSIS</div>
          <div style={{ fontSize:9, color:"#777", lineHeight:1.6, marginBottom:7 }}>{parlayResult.reasoning}</div>
          {/* Kelly stake */}
          {parlayResult.kelly_stake != null && (
            <div style={{ display:"flex", gap:8, marginBottom:6 }}>
              <div style={{ flex:1, padding:"7px 8px", borderRadius:5, background:"rgba(74,222,128,0.05)", border:"1px solid rgba(74,222,128,0.15)", textAlign:"center" }}>
                <div style={{ fontSize:7, color:"#4ade80", letterSpacing:1.5, marginBottom:2 }}>KELLY STAKE</div>
                <div style={{ fontSize:14, fontWeight:900, color:"#4ade80" }}>${parlayResult.kelly_stake}</div>
                <div style={{ fontSize:6, color:"#1a3a1a" }}>optimal bet size</div>
              </div>
              <div style={{ flex:1, padding:"7px 8px", borderRadius:5, background:"rgba(96,165,250,0.05)", border:"1px solid rgba(96,165,250,0.15)", textAlign:"center" }}>
                <div style={{ fontSize:7, color:"#60a5fa", letterSpacing:1.5, marginBottom:2 }}>EV / BET</div>
                <div style={{ fontSize:14, fontWeight:900, color: (parlayResult.expected_value||0) >= 0 ? "#4ade80" : "#f87171" }}>
                  {(parlayResult.expected_value||0) >= 0 ? "+" : ""}${Math.abs(parlayResult.expected_value||0).toFixed(0)}
                </div>
                <div style={{ fontSize:6, color:"#1a2a3a" }}>expected value</div>
              </div>
            </div>
          )}
          {/* Correlation warnings */}
          {parlayResult.correlation_warnings?.length > 0 && (
            <div style={{ marginBottom:6 }}>
              {parlayResult.correlation_warnings.map((w,i) => (
                <div key={i} style={{ fontSize:8, color:"#facc15", padding:"3px 7px", background:"rgba(250,204,21,0.04)", borderRadius:4, border:"1px solid rgba(250,204,21,0.12)", marginBottom:3 }}>⚡ {w}</div>
              ))}
            </div>
          )}
          {parlayResult.warning && (
            <div style={{ fontSize:8, color:"#f97316", padding:"4px 7px", background:"rgba(249,115,22,0.05)", borderRadius:4, border:"1px solid rgba(249,115,22,0.15)" }}>⚠ {parlayResult.warning}</div>
          )}
        </div>
      )}

      <div style={{ fontSize:8, color:"#1a1a2a", textAlign:"center", marginBottom:9 }}>or click ★ on prop cards to add manually</div>

      {parlayGroups.length > 0 && (
        <div>
          {/* Same-event conflict warnings */}
          {(() => {
            const conflicts = detectSameEventConflicts(parlayGroups);
            if (!conflicts.length) return null;
            return (
              <div style={{ marginBottom:8 }}>
                {conflicts.map((c,i) => (
                  <div key={i} style={{ fontSize:8, color:"#f87171", padding:"4px 8px", background:"rgba(248,113,113,0.05)", border:"1px solid rgba(248,113,113,0.18)", borderRadius:5, marginBottom:3 }}>{c}</div>
                ))}
              </div>
            );
          })()}

          <div style={{ fontSize:7, color:"#333", letterSpacing:2, marginBottom:6 }}>LEGS ({parlayGroups.length}/{picks})</div>
          {parlayGroups.map(g => {
            const a = analyses[aKey(g)];
            const bestProp = g[a?.best_bet] || g.standard || g.goblin || g.demon;
            const cfg = SPORT_CONFIG[g.meta.sport] || SPORT_CONFIG.LoL;
            return (
              <div key={aKey(g)} style={{ display:"flex", alignItems:"center", gap:7, padding:"7px 9px", borderRadius:6, marginBottom:4, background:"rgba(255,215,0,0.04)", border:"1px solid rgba(255,215,0,0.12)" }}>
                <div style={{ width:18, height:18, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", background:`${gradeColor(a?.grade)}15`, border:`1px solid ${gradeColor(a?.grade)}40`, fontSize:8, fontWeight:900, color:gradeColor(a?.grade) }}>{a?.grade||"?"}</div>
                <span style={{ fontSize:8, color:cfg.color }}>{cfg.icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:10, fontWeight:800, color:"#E0E2EE", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{g.meta.player}</div>
                  <div style={{ fontSize:8, color:"#333" }}>{(ODDS_COLORS[a?.best_bet]||ODDS_COLORS.standard).label} {bestProp?.line} — {a?.[`rec_${a?.best_bet}`]||"?"}</div>
                </div>
                <div style={{ fontSize:11, fontWeight:900, color:confColor(a?.conf||0) }}>{a?.conf||"?"}%</div>
                <button onClick={() => setParlay(prev => prev.filter(k=>k!==aKey(g)))} style={{ fontSize:11, color:"#222", background:"none", border:"none", cursor:"pointer", padding:"2px 4px" }}>✕</button>
              </div>
            );
          })}

          {parlayGroups.length === picks && (
            <div style={{ marginTop:9, padding:"11px", borderRadius:8, background:"linear-gradient(135deg,rgba(255,215,0,0.08),rgba(255,215,0,0.03))", border:"1px solid rgba(255,215,0,0.25)", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#7a6800", letterSpacing:2, marginBottom:2 }}>{picks}-PICK POWER PLAY</div>
              <div style={{ fontSize:24, fontWeight:900, color:"#FFD700" }}>${stake} → ${payout.toLocaleString()}</div>
              <div style={{ fontSize:8, color:"#5a4800", marginTop:2 }}>~{estHitPct}% hit rate · {picks} legs compounded</div>
              <div style={{ fontSize:7, color:"#3a3000", marginTop:1 }}>EV = ${(payout * estHitPct / 100).toFixed(0)} expected per attempt</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── BACKEND STATUS ──────────────────────────────────────────────────────────
function BackendStatus() {
  const [status, setStatus] = useState("checking");

  useEffect(() => {
    fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => r.ok ? setStatus("online") : setStatus("offline"))
      .catch(() => setStatus("offline"));
  }, []);

  const color = status === "online" ? "#4ade80" : status === "offline" ? "#f87171" : "#facc15";
  const label = status === "online" ? "● STATS SERVER ONLINE" : status === "offline" ? "○ STATS SERVER OFFLINE" : "◌ CONNECTING…";
  return (
    <div style={{ fontSize:7, color, letterSpacing:1.5, marginTop:2 }}>{label}</div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [groups,       setGroups]       = useState([]);
  const [analyses,     setAnalyses]     = useState({});
  const [scoutData,    setScoutData]    = useState({}); // Liquipedia auto-fetch per aKey
  const [notes,        setNotes]        = useState({}); // manual scout notes per aKey
  const [results,      setResults]      = useState({});
  const [selected,     setSelected]     = useState(null);
  const [parlay,       setParlay]       = useState([]);
  const [parlayResult, setParlayResult] = useState(null);
  const [view,         setView]         = useState("board");
  const [rightPanel,   setRightPanel]   = useState("detail");
  const [importText,   setImportText]   = useState("");
  const [parseError,   setParseError]   = useState("");
  const [filterSport,  setFilterSport]  = useState("ALL");
  const [filterType,   setFilterType]   = useState("ALL");
  const [filterTier,   setFilterTier]   = useState("ALL"); // ALL | 1 | 2 | 3 | 4
  const [sortBy,       setSortBy]       = useState("tier");

  // Queue state — survives UI re-renders, fully resumable
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

  // ── Persist results to storage ──────────────────────────────────────────────
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
    const supported = ["LoL", "CS2", "Valorant"];
    const toFetch = newGroups
      .filter(g => supported.includes(g.meta.sport))
      .map(g => ({ player: g.meta.player, sport: g.meta.sport }));

    if (toFetch.length > 0) {
      fetchBatchBackendStats(toFetch).then(results => {
        const notesUpdates = {};
        Object.entries(results).forEach(([key, data]) => {
          if (data?.notes && !notesRef.current[key.replace("::", "||").split("||")[0]]) {
            // key format is "player::sport" — find matching aKey group
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

  // Parallel batch runner — CONCURRENCY concurrent calls at once
  const CONCURRENCY = 5;

  const runQueue = async () => {
    abortRef.current = false;

    const runOne = async (g) => {
      if (abortRef.current) return;
      setQueueStatus(prev => prev ? { ...prev, current: g.meta.player } : null);

      for (let attempt = 0; attempt < 4; attempt++) {
        if (abortRef.current) return;
        try {
          const enrichment = scoutDataRef.current[aKey(g)];
          const groupWithNotes = { ...g, notes: notesRef.current[aKey(g)] || "" };
          const result = await analyzeGroup(groupWithNotes, 3, enrichment);
          setAnalyses(prev => ({ ...prev, [aKey(g)]: result }));
          setQueueStatus(prev => prev ? { ...prev, done: (prev.done || 0) + 1 } : null);
          return; // success
        } catch (err) {
          const msg = String(err.message || err);
          const isRateLimit = msg.includes("429") || msg.includes("529") || msg.includes("rate");
          if (isRateLimit) {
            const wait = 6000 * Math.pow(2, attempt);
            setQueueStatus(prev => prev ? { ...prev, current: `Rate limited — cooling ${wait/1000}s…` } : null);
            await new Promise(r => setTimeout(r, wait));
          } else if (attempt === 3) {
            setAnalyses(prev => ({ ...prev, [aKey(g)]: { _error: msg } }));
            setQueueStatus(prev => prev ? { ...prev, errors: (prev.errors||0) + 1, done: (prev.done||0) + 1, errorNames: [...(prev.errorNames||[]), g.meta.player] } : null);
            return;
          } else {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
      }
    };

    // Process queue in parallel batches
    while (queueRef.current.length > 0 && !abortRef.current) {
      const batch = queueRef.current.splice(0, CONCURRENCY);
      await Promise.all(batch.map(g => runOne(g)));
      // Short breather between batches to avoid sustained rate pressure
      if (queueRef.current.length > 0 && !abortRef.current) {
        await new Promise(r => setTimeout(r, 800));
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
    // Sort: T1 → T2 → T3 → T4 so premier props always analyze first
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

  // Fetch Liquipedia data + backend stats for a single group
  const fetchEnrichment = async (group) => {
    const k = aKey(group);
    // Allow re-fetch if previous result was an error (Refresh button)
    if (scoutData[k] && !scoutData[k].error && !scoutData[k].loading) return;
    setScoutData(prev => ({ ...prev, [k]: { loading: true } }));

    // Run Liquipedia + backend stats in parallel
    const [lpediaData, backendData] = await Promise.all([
      fetchLpediaPlayer(group.meta.player, group.meta.sport),
      fetchBackendStats(group.meta.player, group.meta.sport),
    ]);

    // Merge backend stats notes into scout notes if not already set
    if (backendData?.notes && !notesRef.current[k]) {
      setNotes(prev => ({ ...prev, [k]: backendData.notes }));
    }

    const data = { ...lpediaData, backendStats: backendData || null };
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
    if (filterType === "COMBO"  && !g.meta.is_combo) return false;
    if (filterType === "SINGLE" && g.meta.is_combo)  return false;
    if (filterTier !== "ALL" && String(g.meta.tier) !== String(filterTier)) return false;
    return true;
  }).sort((a, b) => {
    const aa = analyses[aKey(a)], bb = analyses[aKey(b)];
    if (sortBy === "tier")   return (a.meta.tier||4) - (b.meta.tier||4);
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
            <div style={{ fontSize:8, color:"#1a1a2a", letterSpacing:3 }}>PRIZEPICKS · MULTI-SPORT · PARLAY BUILDER · $50→$1,250</div>
            <BackendStatus />
          </div>
          <div style={{ display:"flex", gap:5 }}>
            {[["board","◉ Board"],["import","↓ Import"],["howto","? Guide"]].map(([v,l]) => (
              <button key={v} onClick={() => setView(v)} style={{ padding:"6px 12px", border:`1px solid ${view===v?"rgba(255,255,255,0.14)":"rgba(255,255,255,0.05)"}`, background:view===v?"rgba(255,255,255,0.04)":"transparent", color:view===v?"#ccc":"#333", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:2 }}>{l}</button>
            ))}
          </div>
        </div>

        {/* ── BOARD ── */}
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
                          {qs.paused ? "⏸ PAUSED" : qs.running ? "◉ ANALYZING" : "✓ COMPLETE"}
                        </span>
                        {qs.current && !qs.paused && <span style={{ fontSize:9, color:"#444", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>— {qs.current}</span>}
                        {qs.errors > 0 && <span style={{ fontSize:8, color:"#f87171" }}>· {qs.errors} failed</span>}
                      </div>
                      {/* Progress bar */}
                      <div style={{ height:3, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${(qs.done/Math.max(qs.total,1))*100}%`, background:`linear-gradient(90deg,#C89B3C,#0AC8B9)`, transition:"width 0.4s" }} />
                      </div>
                      <div style={{ fontSize:7, color:"#333", marginTop:3 }}>{qs.done}/{qs.total} analyzed · {inQueue} remaining in queue</div>
                    </div>
                    <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                      {qs.running && !qs.paused && (
                        <button onClick={pauseAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 11px", borderRadius:5, border:"1px solid rgba(250,204,21,0.3)", background:"rgba(250,204,21,0.07)", color:"#facc15", cursor:"pointer", fontFamily:"inherit", letterSpacing:1 }}>⏸ Pause</button>
                      )}
                      {isPaused && (
                        <button onClick={resumeAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 11px", borderRadius:5, border:"1px solid rgba(10,200,185,0.3)", background:"rgba(10,200,185,0.07)", color:"#0AC8B9", cursor:"pointer", fontFamily:"inherit", letterSpacing:1 }}>▶ Resume</button>
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
                    [`${groups.filter(g=>g.meta.tier===2).length} TIER 1`, "#4ade80"],
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
                <div style={{ fontSize:52, opacity:0.1, marginBottom:14 }}>⚔🎯◈🗡</div>
                <div style={{ color:"#1a1a2e", fontSize:12, lineHeight:2 }}>
                  No props loaded yet.<br/>
                  <button onClick={() => setView("import")} style={{ color:"#C89B3C", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, textDecoration:"underline" }}>Import PrizePicks data →</button>
                </div>
              </div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:"1fr 290px", gap:12 }}>
                {/* LEFT */}
                <div>
                  <div style={{ display:"flex", gap:4, marginBottom:9, flexWrap:"wrap", alignItems:"center" }}>
                    {/* Tier filter — primary */}
                    <div style={{ display:"flex", gap:3, marginRight:4 }}>
                      <button onClick={() => setFilterTier("ALL")} style={{ padding:"4px 9px", border:`1px solid ${filterTier==="ALL"?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.05)"}`, background:filterTier==="ALL"?"rgba(255,255,255,0.05)":"transparent", color:filterTier==="ALL"?"#ccc":"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1 }}>ALL TIERS</button>
                      {[1,2,3,4].map(t => {
                        const tm = TIER_META[t];
                        const active = filterTier === String(t);
                        return <button key={t} onClick={() => setFilterTier(String(t))} style={{ padding:"4px 9px", border:`1px solid ${active?tm.color+"55":"rgba(255,255,255,0.05)"}`, background:active?`${tm.color}12`:"transparent", color:active?tm.color:"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:800, letterSpacing:1 }}>{t===1?"★ ":""}{tm.label}</button>;
                      })}
                    </div>
                    <div style={{ width:1, height:12, background:"rgba(255,255,255,0.05)" }} />
                    {/* Sport filter */}
                    {sports.map(s => <button key={s} onClick={() => setFilterSport(s)} style={{ padding:"3px 7px", border:`1px solid ${filterSport===s?"rgba(255,255,255,0.18)":"rgba(255,255,255,0.04)"}`, background:filterSport===s?"rgba(255,255,255,0.04)":"transparent", color:filterSport===s?"#ccc":"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1 }}>{s==="ALL"?"ALL":((SPORT_CONFIG[s]?.icon||"")+" "+s)}</button>)}
                    <div style={{ width:1, height:12, background:"rgba(255,255,255,0.05)" }} />
                    {/* Type filter */}
                    {["ALL","SINGLE","COMBO"].map(t => <button key={t} onClick={() => setFilterType(t)} style={{ padding:"3px 7px", border:`1px solid ${filterType===t?"#a78bfa44":"rgba(255,255,255,0.04)"}`, background:filterType===t?"rgba(167,139,250,0.07)":"transparent", color:filterType===t?"#a78bfa":"#2a2a3a", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:7, fontWeight:700, letterSpacing:1 }}>{t}</button>)}
                    <div style={{ marginLeft:"auto", display:"flex", gap:3, alignItems:"center" }}>
                      <span style={{ fontSize:7, color:"#1a1a2a", letterSpacing:1 }}>SORT</span>
                      {[["tier","TIER"],["conf","CONF"],["grade","GRADE"],["edge","EDGE"],["parlay","★"]].map(([v,l]) => <button key={v} onClick={() => setSortBy(v)} style={{ padding:"2px 6px", border:`1px solid ${sortBy===v?"rgba(255,255,255,0.1)":"rgba(255,255,255,0.03)"}`, background:sortBy===v?"rgba(255,255,255,0.04)":"transparent", color:sortBy===v?"#aaa":"#1a1a2a", borderRadius:3, cursor:"pointer", fontFamily:"inherit", fontSize:7 }}>{l}</button>)}
                    </div>
                  </div>

                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:9 }}>
                    <span style={{ fontSize:7, color:"#1a1a2a" }}>{filtered.length} props</span>
                  <div style={{ display:"flex", gap:6 }}>
                      <button onClick={() => { cancelAnalysis(); setGroups([]); setAnalyses({}); setParlay([]); setParlayResult(null); setSelected(null); }} style={{ fontSize:8, color:"#f87171", background:"none", border:"1px solid #f8717120", borderRadius:4, padding:"3px 9px", cursor:"pointer", fontFamily:"inherit" }}>Clear All</button>
                      {!isRunning && !isPaused && (() => {
                        const premierOnly = unanalyzed.filter(g => g.meta.tier <= 2);
                        const allRemaining = unanalyzed;
                        if (premierOnly.length > 0 && premierOnly.length < allRemaining.length) return (
                          <>
                            <button onClick={() => analyze(premierOnly)} style={{ fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"none", background:"linear-gradient(135deg,#FFD700,#4ade80)", color:"#000", cursor:"pointer", fontFamily:"inherit" }}>
                              ★ {premierOnly.length} PREMIER + T1
                            </button>
                            <button onClick={() => analyze(allRemaining)} style={{ fontSize:8, fontWeight:700, letterSpacing:1, padding:"5px 12px", borderRadius:6, border:"1px solid rgba(255,255,255,0.08)", background:"transparent", color:"#555", cursor:"pointer", fontFamily:"inherit" }}>
                              ALL {allRemaining.length}
                            </button>
                          </>
                        );
                        if (allRemaining.length > 0) return (
                          <button onClick={() => analyze(allRemaining)} style={{ fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", cursor:"pointer", fontFamily:"inherit" }}>
                            ◉ ANALYZE {allRemaining.length} REMAINING
                          </button>
                        );
                        return (
                          <button onClick={() => { setAnalyses({}); setTimeout(() => analyze(filtered), 50); }} style={{ fontSize:8, fontWeight:700, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"1px solid rgba(255,255,255,0.08)", background:"transparent", color:"#555", cursor:"pointer", fontFamily:"inherit" }}>
                            ↻ Re-analyze All
                          </button>
                        );
                      })()}
                      {isRunning && (
                        <button onClick={pauseAnalysis} style={{ fontSize:8, fontWeight:700, padding:"5px 12px", borderRadius:6, border:"1px solid rgba(250,204,21,0.3)", background:"rgba(250,204,21,0.07)", color:"#facc15", cursor:"pointer", fontFamily:"inherit" }}>⏸ Pause</button>
                      )}
                      {isPaused && (
                        <button onClick={resumeAnalysis} style={{ fontSize:8, fontWeight:900, letterSpacing:1.5, padding:"5px 12px", borderRadius:6, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", cursor:"pointer", fontFamily:"inherit" }}>▶ Resume</button>
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
                    {[["detail","◉ Analysis"],["parlay",`★ Parlay${parlay.length?` (${parlay.length})`:""}`],["stats","📊 Record"]].map(([v,l]) => (
                      <button key={v} onClick={() => setRightPanel(v)} style={{ flex:1, padding:"6px", border:`1px solid ${rightPanel===v?"rgba(255,215,0,0.25)":"rgba(255,255,255,0.05)"}`, background:rightPanel===v?"rgba(255,215,0,0.05)":"transparent", color:rightPanel===v?"#FFD700":"#2a2a3a", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:8, fontWeight:700, letterSpacing:1 }}>{l}</button>
                    ))}
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
                      onReanalyze={() => { if (!selected) return; setAnalyses(prev => { const n={...prev}; delete n[aKey(selected)]; return n; }); setTimeout(() => { const g = { ...selected, notes: notesRef.current[aKey(selected)] || "" }; analyzeGroup(g, 2, scoutDataRef.current[aKey(selected)]).then(r => setAnalyses(prev => ({ ...prev, [aKey(selected)]: r }))).catch(e => setAnalyses(prev => ({ ...prev, [aKey(selected)]: { _error: String(e.message||e) } }))); }, 50); }}
                    />}
                    {rightPanel === "stats" && (() => {
                      const logged = Object.entries(results);
                      if (!logged.length) return (
                        <div style={{ textAlign:"center", padding:"40px 10px", color:"#1a1a2a", fontSize:10, lineHeight:2 }}>
                          No results logged yet.<br/>
                          <span style={{ fontSize:9, color:"#111" }}>Click any analyzed prop → Log HIT or MISS after games finish.</span>
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
                      const confBuckets = [["72-78",72,78],["66-71",66,71],["60-65",60,65],["<60",0,59]];
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
                    {rightPanel === "parlay" && <ParlayPanel groups={groups} analyses={analyses} parlay={parlay} setParlay={setParlay} parlayResult={parlayResult} setParlayResult={setParlayResult} />}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── IMPORT ── */}
        {view === "import" && (
          <div style={{ maxWidth:640, margin:"0 auto" }}>
            <div style={{ fontSize:9, color:"#444", letterSpacing:3, marginBottom:8 }}>IMPORT PROPS</div>
            <p style={{ color:"#444", fontSize:11, lineHeight:1.8, margin:"0 0 14px" }}>
              Supports all esports: LoL, CS2, Valorant, Dota 2, R6, COD, Apex. Upload a saved JSON file or paste raw JSON from the PrizePicks Network tab. Import each game board and sub-tab separately — they all stack.
            </p>

            <input ref={fileInputRef} type="file" accept=".json,.txt" onChange={handleFile} style={{ display:"none" }} />
            <button onClick={() => fileInputRef.current?.click()} style={{ width:"100%", padding:"13px", borderRadius:8, border:"2px dashed rgba(255,255,255,0.08)", background:"rgba(255,255,255,0.015)", color:"#444", cursor:"pointer", fontFamily:"inherit", fontSize:9, fontWeight:700, letterSpacing:2, marginBottom:12 }}>⬆ UPLOAD .json OR .txt FILE</button>

            <div style={{ textAlign:"center", color:"#1a1a2a", fontSize:9, letterSpacing:2, margin:"6px 0" }}>— OR PASTE BELOW —</div>

            <textarea value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={"Paste full PrizePicks API JSON here...\n\nHow to get it:\n1. Open prizepicks.com → Esports → any game\n2. F12 → Network tab → filter: projections\n3. Click any sub-tab on the board\n4. Click the request that appears → Response → copy all\n5. Paste here and click Import\n\nRepeat for each sub-tab and game. All boards stack."}
              style={{ width:"100%", minHeight:180, background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:9, color:"#E0E2EE", fontFamily:"inherit", fontSize:10, padding:13, resize:"vertical", lineHeight:1.6, boxSizing:"border-box" }}
            />

            {parseError && <div style={{ color:"#f87171", fontSize:10, marginTop:7, padding:"7px 11px", border:"1px solid #f8717120", borderRadius:6 }}>{parseError}</div>}

            <div style={{ display:"flex", gap:7, marginTop:9 }}>
              <button onClick={() => handleImport()} style={{ flex:1, padding:"11px", borderRadius:8, border:"none", background:"linear-gradient(135deg,#C89B3C,#0AC8B9)", color:"#000", fontFamily:"inherit", fontSize:9, fontWeight:900, letterSpacing:2, cursor:"pointer" }}>↓ IMPORT BOARD</button>
              <button onClick={() => { setImportText(""); setParseError(""); }} style={{ padding:"11px 13px", borderRadius:8, border:"1px solid rgba(255,255,255,0.06)", background:"transparent", color:"#444", fontFamily:"inherit", fontSize:8, cursor:"pointer" }}>Clear</button>
            </div>

            {groups.length > 0 && (
              <div style={{ marginTop:11, padding:"9px 13px", borderRadius:7, background:"rgba(74,222,128,0.05)", border:"1px solid rgba(74,222,128,0.15)", fontSize:10, color:"#4ade80" }}>
                ✓ {groups.length} prop groups loaded across {[...new Set(groups.map(g=>g.meta.sport))].join(", ")}
              </div>
            )}
          </div>
        )}

        {/* ── GUIDE ── */}
        {view === "howto" && (
          <div style={{ maxWidth:600, margin:"0 auto", fontSize:11, color:"#555", lineHeight:1.8 }}>
            {[
              { title:"Getting Data for Any Esport", color:"#4ade80", steps:[
                "Open prizepicks.com → Esports → pick any game (LoL, CS2, Valorant, Dota 2, etc.)",
                "F12 → Network tab → type 'projections' in the filter box",
                "Click any sub-tab on the board (Popular, Maps 1-3 Kills, Combo, etc.)",
                "A network request appears — click it → Response tab → copy all text",
                "Go to Import → paste → Import. Repeat for every sub-tab and every game.",
                "All boards stack. Import as many as you want before analyzing.",
                "Or: save the JSON response to a .json file and upload directly.",
              ]},
              { title:"The $50 → $1,250 Parlay System", color:"#FFD700", steps:[
                "Import all available esports boards for the day across all sports.",
                "Hit '◉ Analyze Remaining' — model scores every prop.",
                "Switch to the ★ Parlay panel in the right sidebar.",
                "Set picks to 6 and stake to $50. Hit 'Auto-Build 6-Pick Parlay'.",
                "AI selects the 6 highest-confidence legs with diversity across sports/matchups.",
                "Or manually click ★ on any prop card to add it to your parlay.",
                "Grade S/A + Parlay Worthy = safe to include. Grade B = borderline. Grade C = never.",
                "The model avoids correlated legs (same team/matchup) to maximize hit probability.",
              ]},
              { title:"Understanding Lines & Model Output", color:"#C89B3C", steps:[
                "GOBLIN = lowest line — easiest MORE. Bet when projection is well above it.",
                "STANDARD = fair value line. True edge if projection clearly exceeds it.",
                "DEMON = highest line — hardest MORE. Only play with 80%+ confidence.",
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

        <div style={{ marginTop:24, textAlign:"center", color:"#0d0f18", fontSize:7, letterSpacing:2 }}>FOR ENTERTAINMENT PURPOSES ONLY · NOT FINANCIAL ADVICE</div>
      </div>

      <style>{`* {box-sizing:border-box} ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-thumb{background:#111820;border-radius:2px} textarea::placeholder{color:#1c1e2a;line-height:1.7} button:hover{opacity:0.8}`}</style>
    </div>
  );
}
