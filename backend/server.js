const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

// ─── CACHE ────────────────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

// ─── HTTP FETCH (HTML pages) ───────────────────────────────────────────────────
function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        ...extraHeaders,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─── JSON API FETCH (OpenDota etc.) ──────────────────────────────────────────
function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KillModel/1.0)",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5",
        ...extraHeaders,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch(e) { reject(new Error("JSON parse failed")); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function extractTableRows(html) {
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const text = cellMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

function formTrend(recent, season, threshold = 0.08) {
  if (!recent || !season || season === 0) return "UNKNOWN";
  if (recent > season * (1 + threshold)) return "HOT";
  if (recent < season * (1 - threshold)) return "COLD";
  return "STABLE";
}

// ─── LoL: gol.gg ─────────────────────────────────────────────────────────────
// gol.gg is server-rendered HTML with stats tables — confirmed scrapeable
async function scrapeGolgg(playerName) {
  const cacheKey = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [seasonHtml, recentHtml] = await Promise.all([
    fetchPage("https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/"),
    fetchPage("https://gol.gg/players/list/season-S15/split-ALL/tournament-ALL/").catch(() => null),
  ]);

  function parseRow(html) {
    if (!html) return null;
    const rows = extractTableRows(html);
    for (const cells of rows) {
      if (cells.length < 8) continue;
      if (cells[0].toLowerCase().includes(playerName.toLowerCase())) {
        return {
          player: cells[0], team: cells[1] || null, role: cells[2] || null,
          kda: parseFloat(cells[3]) || null,
          kills_per_game: parseFloat(cells[4]) || null,
          deaths_per_game: parseFloat(cells[5]) || null,
          assists_per_game: parseFloat(cells[6]) || null,
          kill_participation: cells[8] || null,
          games: parseInt(cells[9]) || null,
        };
      }
    }
    return null;
  }

  const season = parseRow(seasonHtml);
  if (!season) return { error: "player_not_found", player: playerName, source: "gol.gg" };

  // Fetch last 7 games from player-specific match history
  const slug = playerName.toLowerCase().replace(/\s+/g, "-");
  let last10 = null;
  try {
    const matchHtml = await fetchPage(`https://gol.gg/players/player-stats/${slug}/`);
    const matchRows = extractTableRows(matchHtml);
    const killNums = [];
    for (const cells of matchRows) {
      if (cells.length >= 5) {
        const k = parseFloat(cells[2]); // K column in match history
        if (!isNaN(k) && k >= 0 && k <= 50) killNums.push(k);
        if (killNums.length >= 5) break;
      }
    }
    if (killNums.length >= 3) last10 = killNums.slice(0, 7);
  } catch(e) { /* best effort */ }

  const recent = parseRow(recentHtml);
  const result = {
    source: "gol.gg", ...season,
    recent_kills_per_game: (recent?.games >= 3) ? recent.kills_per_game : null,
    recent_kda: (recent?.games >= 3) ? recent.kda : null,
    recent_games: recent?.games || null,
    last10_kills: last10,
    last10_avg: avg(last10),
    form_trend: last10 && last10.length >= 3
      ? formTrend(avg(last10), season.kills_per_game)
      : (recent?.games >= 3 ? formTrend(recent.kills_per_game, season.kills_per_game) : "UNKNOWN"),
  };
  setCache(cacheKey, result);
  return result;
}

// ─── CS2: HLTV ───────────────────────────────────────────────────────────────
// HLTV is server-rendered, well-documented scraping target — confirmed scrapeable
async function scrapeHltv(playerName) {
  const cacheKey = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const twentyDaysAgo = new Date(Date.now() - 20*24*60*60*1000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  // Use sixMonthsAgo/sixtyDaysAgo aliases so existing URL refs work
  const sixMonthsAgo = thirtyDaysAgo;
  const sixtyDaysAgo = twentyDaysAgo;

  const html = await fetchPage(`https://www.hltv.org/stats/players?startDate=${sixMonthsAgo}&endDate=${today}&rankingFilter=Top50`);
  const linkRegex = /href="\/stats\/players\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)\s*</gi;
  let playerId = null, playerSlug = null, m;
  while ((m = linkRegex.exec(html)) !== null) {
    if (m[3].trim().toLowerCase() === playerName.toLowerCase()) {
      playerId = m[1]; playerSlug = m[2]; break;
    }
  }
  if (!playerId) return { error: "player_not_found", player: playerName, source: "HLTV" };

  const [seasonHtml, recentHtml, matchesHtml] = await Promise.all([
    fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${sixMonthsAgo}&endDate=${today}`),
    fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${sixtyDaysAgo}&endDate=${today}`).catch(() => null),
    fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}/matches?startDate=${sixtyDaysAgo}&endDate=${today}`).catch(() => null),
  ]);

  function parseHltvStats(html) {
    const stats = {};
    const r = /summaryStatBreakdownName[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+summaryStatBreakdownVal[^>]*>([^<]+)</gi;
    let m;
    while ((m = r.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();
    const kpr = parseFloat(stats["KPR"] || 0);
    return {
      rating: parseFloat(stats["Rating 2.0"] || stats["Rating"] || 0),
      kpr, kills_per_map: kpr > 0 ? Math.round(kpr * 25 * 10) / 10 : null,
      adr: parseFloat(stats["ADR"] || 0), kast: stats["KAST"] || null,
      impact: parseFloat(stats["Impact"] || 0),
    };
  }

  // Extract last 7 games from matches page
  let last10 = null;
  if (matchesHtml) {
    const matchRows = extractTableRows(matchesHtml);
    const killNums = [];
    for (const cells of matchRows) {
      if (cells.length >= 5) {
        const k = parseInt(cells[3]); // K column in HLTV matches table
        if (!isNaN(k) && k > 0 && k < 80) killNums.push(k);
        if (killNums.length >= 5) break;
      }
    }
    if (killNums.length >= 3) last10 = killNums.slice(0, 7);
  }

  const season = parseHltvStats(seasonHtml);
  const recent = recentHtml ? parseHltvStats(recentHtml) : null;

  const result = {
    source: "HLTV", player: playerName, ...season,
    recent_kills_per_map: recent?.kills_per_map || null,
    recent_rating: recent?.rating || null,
    last10_kills: last10,
    last10_avg: avg(last10),
    form_trend: last10 && last10.length >= 3
      ? formTrend(avg(last10), season.kills_per_map)
      : formTrend(recent?.rating, season.rating),
  };
  setCache(cacheKey, result);
  return result;
}

// ─── Valorant: vlr.gg ────────────────────────────────────────────────────────
// vlr.gg is server-rendered HTML — confirmed scrapeable, used by many projects
async function scrapeVlr(playerName) {
  const cacheKey = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const [html90, html30] = await Promise.all([
    fetchPage("https://www.vlr.gg/stats/?type=players&timespan=90d"),
    fetchPage("https://www.vlr.gg/stats/?type=players&timespan=60d").catch(() => null),
  ]);

  function parseVlrRow(html, name) {
    if (!html) return null;
    const rows = extractTableRows(html);
    for (const cells of rows) {
      if (cells.length < 8) continue;
      if (cells[0].toLowerCase().includes(name.toLowerCase()) || (cells[1] && cells[1].toLowerCase().includes(name.toLowerCase()))) {
        const o = cells[0].toLowerCase().includes(name.toLowerCase()) ? 0 : 1;
        return {
          rounds: parseInt(cells[2+o]) || null, rating: parseFloat(cells[3+o]) || null,
          acs: parseFloat(cells[4+o]) || null, kills_per_map: parseFloat(cells[5+o]) || null,
          deaths_per_map: parseFloat(cells[6+o]) || null, kast: cells[9+o] || null,
          adr: parseFloat(cells[10+o]) || null,
        };
      }
    }
    return null;
  }

  // Find player profile URL for last 7 games
  let profileUrl = null;
  const profileMatch = html90.match(new RegExp(`href="(/player/\\d+/${playerName.toLowerCase().replace(/\s+/g,'-')}[^"]*)"`, 'i'));
  if (profileMatch) profileUrl = `https://www.vlr.gg${profileMatch[1]}`;

  let last10 = null;
  if (profileUrl) {
    try {
      const profileHtml = await fetchPage(profileUrl);
      const matchRows = extractTableRows(profileHtml);
      const killNums = [];
      for (const cells of matchRows) {
        if (cells.length >= 6) {
          const k = parseFloat(cells[3]); // K column in vlr player page
          if (!isNaN(k) && k >= 0 && k <= 80) killNums.push(k);
          if (killNums.length >= 5) break;
        }
      }
      if (killNums.length >= 3) last10 = killNums.slice(0, 7);
    } catch(e) { /* best effort */ }
  }

  const season = parseVlrRow(html90, playerName);
  if (!season) return { error: "player_not_found", player: playerName, source: "vlr.gg" };
  const recent = parseVlrRow(html30, playerName);

  const result = {
    source: "vlr.gg", player: playerName, ...season,
    recent_acs: recent?.acs || null,
    recent_kills_per_map: recent?.kills_per_map || null,
    recent_rating: recent?.rating || null,
    last10_kills: last10,
    last10_avg: avg(last10),
    form_trend: last10 && last10.length >= 3
      ? formTrend(avg(last10), season.kills_per_map)
      : formTrend(recent?.acs, season.acs, 0.1),
  };
  setCache(cacheKey, result);
  return result;
}

// ─── Dota2: OpenDota PUBLIC API ───────────────────────────────────────────────
// 100% FREE, no auth required, no bot protection, returns JSON
// Endpoints: /proPlayers (all pro players) + /players/{id}/recentMatches (last 7 matches)
// Rate limit: 60 req/min free — we cache aggressively so this is fine
async function scrapeOpenDota(playerName) {
  const cacheKey = `opendota:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Step 1: Get list of all pro players (cached for 4h — same TTL)
  const proPlayersCacheKey = "opendota:pro_players_list";
  let proPlayers = getCached(proPlayersCacheKey);
  if (!proPlayers) {
    proPlayers = await fetchJSON("https://api.opendota.com/api/proPlayers");
    if (Array.isArray(proPlayers)) setCache(proPlayersCacheKey, proPlayers);
  }

  if (!Array.isArray(proPlayers)) {
    return { error: "api_error", player: playerName, source: "OpenDota" };
  }

  // Step 2: Find the player by name match
  const nameLower = playerName.toLowerCase();
  let proPlayer = proPlayers.find(p =>
    (p.name || "").toLowerCase() === nameLower ||
    (p.name || "").toLowerCase().includes(nameLower) ||
    (p.persona_name || "").toLowerCase() === nameLower
  );

  if (!proPlayer) {
    return { error: "player_not_found", player: playerName, source: "OpenDota" };
  }

  const accountId = proPlayer.account_id;
  if (!accountId) {
    return { error: "no_account_id", player: playerName, source: "OpenDota" };
  }

  // Step 3: Get recent matches — returns array with kills, deaths, assists per game
  const recentMatches = await fetchJSON(
    `https://api.opendota.com/api/players/${accountId}/recentMatches`
  );

  if (!Array.isArray(recentMatches) || recentMatches.length === 0) {
    return { error: "no_recent_matches", player: playerName, source: "OpenDota",
             team: proPlayer.team_name || null };
  }

  // Filter to pro matches only (lobby_type 1 = ranked, 5 = ranked party, 7 = tournament)
  // OpenDota: lobby_type 2 = tournament, game_mode 2 = CM (Captains Mode, standard pro)
  const proMatches = recentMatches.filter(m =>
    m.lobby_type === 2 || m.game_mode === 2 || (m.kills > 0 && m.duration > 1500)
  );
  const matchesToUse = (proMatches.length >= 3 ? proMatches : recentMatches).slice(0, 7);

  const allKills = matchesToUse.map(m => m.kills).filter(k => k !== undefined && k >= 0 && k <= 50);
  const last10Kills = allKills.slice(0, 7);
  const last10Avg = avg(last10Kills);
  const seasonAvg = avg(allKills);

  const result = {
    source: "OpenDota",
    player: proPlayer.name || playerName,
    team: proPlayer.team_name || null,
    account_id: accountId,
    kills_per_game: seasonAvg,
    games: allKills.length,
    last10_kills: last10Kills,
    last10_avg: last10Avg,
    deaths_per_game: avg(matchesToUse.slice(0, 7).map(m => m.deaths).filter(d => d !== undefined && d >= 0)),
    assists_per_game: avg(matchesToUse.slice(0, 7).map(m => m.assists).filter(a => a !== undefined && a >= 0)),
    form_trend: formTrend(last10Avg, seasonAvg),
  };
  setCache(cacheKey, result);
  return result;
}

// ─── R6: siege.gg ────────────────────────────────────────────────────────────
// siege.gg is a dedicated R6 esports site with server-rendered player pages
async function scrapeSiegeGG(playerName) {
  const cacheKey = `siegegg:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const slug = playerName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const url = `https://siege.gg/players/${slug}`;
  const html = await fetchPage(url).catch(() => null);

  if (!html || html.includes("Player not found") || html.includes("404")) {
    return { error: "player_not_found", player: playerName, source: "siege.gg" };
  }

  const result = { source: "siege.gg", player: playerName };

  // Extract team — handles both anchor-as-element and child-anchor patterns
  const teamMatch = html.match(/class="[^"]*team[^"]*"[^>]*>(?:\s*<[^>]+>)?([^<\n]+?)(?:<|\/)/i);
  if (teamMatch) result.team = teamMatch[1].trim();

  // KPR — siege.gg primary stat (Kills Per Round)
  const kprMatch = html.match(/KPR[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i);
  if (kprMatch) result.kills_per_round = parseFloat(kprMatch[1]);

  const kdMatch = html.match(/K\/D[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i);
  if (kdMatch) result.kd = parseFloat(kdMatch[1]);

  const kostMatch = html.match(/KOST[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+%?)/i);
  if (kostMatch) result.kost = kostMatch[1];

  const roundsMatch = html.match(/Rounds[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9,]+)/i);
  if (roundsMatch) result.rounds = parseInt(roundsMatch[1].replace(/,/g, ""));

  // Kills per map ≈ KPR * ~12 rounds/map (standard R6 map length)
  if (result.kills_per_round) {
    result.kills_per_map = Math.round(result.kills_per_round * 12 * 10) / 10;
  }

  // Extract last 7 games from match history if available
  const matchRows = extractTableRows(html);
  const killNums = [];
  for (const cells of matchRows) {
    if (cells.length >= 4) {
      const k = parseFloat(cells[2]); // kills column in R6 match rows
      if (!isNaN(k) && k >= 0 && k <= 30) killNums.push(k);
      if (killNums.length >= 5) break;
    }
  }
  if (killNums.length >= 3) {
    result.last10_kills = killNums;
    result.last10_avg = avg(killNums);
    result.form_trend = formTrend(avg(killNums), result.kills_per_map);
  }

  if (!result.kd && !result.kills_per_round) {
    return { error: "parse_failed", player: playerName, source: "siege.gg" };
  }

  setCache(cacheKey, result);
  return result;
}

// ─── COD: breakingpoint.gg ───────────────────────────────────────────────────
// breakingpoint.gg is the CDL stats hub — dedicated esports site
async function scrapeBreakingPoint(playerName) {
  const cacheKey = `bp:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `https://www.breakingpoint.gg/players/${encodeURIComponent(playerName)}`;
  const html = await fetchPage(url).catch(() => null);

  if (!html || html.includes("Page not found") || html.includes("404")) {
    return { error: "player_not_found", player: playerName, source: "breakingpoint.gg" };
  }

  const result = { source: "breakingpoint.gg", player: playerName };

  // Team
  const teamMatch = html.match(/class="[^"]*team[^"]*"[^>]*>([^<]+)</i);
  if (teamMatch) result.team = teamMatch[1].trim();

  const kdMatch = html.match(/K\/D[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i);
  if (kdMatch) result.kd = parseFloat(kdMatch[1]);

  const killsMatch = html.match(/Kills[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i);
  if (killsMatch) result.kills_per_map = parseFloat(killsMatch[1]);

  const kostMatch = html.match(/KOST[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+%?)/i);
  if (kostMatch) result.kost = kostMatch[1];

  const damageMatch = html.match(/Damage[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i);
  if (damageMatch) result.damage_per_round = parseFloat(damageMatch[1]);

  // Last 5 games from match history table
  const matchRows = extractTableRows(html);
  const killNums = [];
  for (const cells of matchRows) {
    if (cells.length >= 4) {
      const k = parseFloat(cells[2]);
      if (!isNaN(k) && k >= 0 && k <= 50) killNums.push(k);
      if (killNums.length >= 5) break;
    }
  }
  if (killNums.length >= 3) {
    result.last10_kills = killNums;
    result.last10_avg = avg(killNums);
    result.form_trend = formTrend(avg(killNums), result.kills_per_map);
  }

  if (!result.kd && !result.kills_per_map) {
    return { error: "parse_failed", player: playerName, source: "breakingpoint.gg" };
  }

  setCache(cacheKey, result);
  return result;
}

// ─── FORMAT NOTES ─────────────────────────────────────────────────────────────
function formatNotes(data) {
  if (!data || data.error) return null;

  function last10Str(d) {
    if (!d.last10_kills || d.last10_kills.length === 0) return null;
    return `L7: [${d.last10_kills.slice(0,10).join(",")}] avg ${d.last10_avg}`;
  }
  const trend = data.form_trend && data.form_trend !== "UNKNOWN" ? ` | ${data.form_trend}` : "";

  if (data.source === "gol.gg") {
    const recent = data.recent_kills_per_game != null ? ` | L7: ${data.recent_kills_per_game}k/g` : "";
    return [`gol.gg(${data.games||"?"}g)`, `${data.kills_per_game}k/g`, data.kda ? `KDA ${data.kda}` : null, data.kill_participation ? `KP ${data.kill_participation}` : null, recent||null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  if (data.source === "HLTV") {
    const recent = data.recent_kills_per_map != null ? ` | L7: ${data.recent_kills_per_map}k/map` : "";
    return [`HLTV`, `Rtg ${data.rating}`, data.kills_per_map ? `${data.kills_per_map}k/map` : null, data.adr ? `ADR ${data.adr}` : null, data.kast ? `KAST ${data.kast}` : null, recent||null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  if (data.source === "vlr.gg") {
    const recent = data.recent_kills_per_map != null ? ` | L7: ${data.recent_kills_per_map}k/map` : "";
    return [`vlr.gg(${data.rounds||"?"}rnd)`, data.acs ? `ACS ${data.acs}` : null, data.kills_per_map ? `${data.kills_per_map}k/map` : null, data.kast ? `KAST ${data.kast}` : null, recent||null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  if (data.source === "OpenDota") {
    return [`OpenDota(${data.games||"?"}g)`, data.kills_per_game ? `${data.kills_per_game}k/g` : null, data.deaths_per_game ? `${data.deaths_per_game}d/g` : null, data.assists_per_game ? `${data.assists_per_game}a/g` : null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  if (data.source === "siege.gg") {
    return [`siege.gg`, data.kills_per_round ? `KPR ${data.kills_per_round}` : null, data.kd ? `K/D ${data.kd}` : null, data.kost ? `KOST ${data.kost}` : null, data.rounds ? `${data.rounds}rnd` : null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  if (data.source === "breakingpoint.gg") {
    return [`BP.gg`, data.kills_per_map ? `${data.kills_per_map}k/map` : null, data.kd ? `K/D ${data.kd}` : null, data.kost ? `KOST ${data.kost}` : null, data.damage_per_round ? `DMG ${data.damage_per_round}` : null, last10Str(data)||null, trend||null].filter(Boolean).join(" · ");
  }
  return null;
}

// ─── STAT ROUTING ─────────────────────────────────────────────────────────────
async function getStats(player, sport) {
  switch (sport) {
    case "LoL":
      return scrapeGolgg(player);
    case "CS2":
      return scrapeHltv(player);
    case "Valorant":
      return scrapeVlr(player);
    case "Dota2":
      return scrapeOpenDota(player);
    case "R6":
      return scrapeSiegeGG(player);
    case "COD":
      return scrapeBreakingPoint(player);
    case "APEX":
      // APEX has no freely scrapeable pro stats site — return structured empty
      return { source: "N/A", player, sport: "APEX", note: "No public APEX pro stats available" };
    default:
      return { error: "unsupported_sport", player, sport };
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/stats", async (req, res) => {
  const { player, sport } = req.query;
  if (!player || !sport) return res.status(400).json({ error: "player and sport required" });
  try {
    const data = await getStats(player, sport);
    res.json({ ...data, notes: formatNotes(data) });
  } catch (err) {
    res.status(500).json({ error: "scrape_failed", message: err.message, player, sport });
  }
});

app.post("/stats/batch", async (req, res) => {
  const props = req.body;
  if (!Array.isArray(props) || !props.length) return res.status(400).json({ error: "body must be array" });
  const seen = new Set();
  const unique = props.filter(p => { const k = `${p.player}::${p.sport}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const results = {};
  for (const { player, sport } of unique) {
    try {
      const data = await getStats(player, sport);
      results[`${player}::${sport}`] = { ...data, notes: formatNotes(data) };
    } catch (err) {
      results[`${player}::${sport}`] = { error: "scrape_failed", message: err.message };
    }
    await new Promise(r => setTimeout(r, 800));
  }
  res.json(results);
});

app.post("/cache/clear", (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ cleared: count });
});

// ─── ANALYZE (Anthropic proxy) ────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  try {
    const payload = JSON.stringify(req.body);
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": process.env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
    };
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (r) => {
        const chunks = [];
        r.on("data", chunk => chunks.push(chunk));
        r.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { reject(new Error("Failed to parse Anthropic response")); }
        });
        r.on("error", reject);
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ODDS API ─────────────────────────────────────────────────────────────────
const ODDS_CACHE = {};
const ODDS_TTL = 30 * 60 * 1000;

async function fetchOddsAPI() {
  if (!process.env.ODDS_API_KEY) return null;
  const cached = ODDS_CACHE["odds"];
  if (cached && Date.now() - cached.ts < ODDS_TTL) return cached.data;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/esports/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=pinnacle,draftkings&oddsFormat=decimal`;
    const data = JSON.parse(await fetchPage(url));
    ODDS_CACHE["odds"] = { data, ts: Date.now() };
    return data;
  } catch(e) { return null; }
}

function findMatchOdds(oddsData, teamA, teamB) {
  if (!oddsData || !Array.isArray(oddsData)) return null;
  const n = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tA = n(teamA), tB = n(teamB);
  for (const game of oddsData) {
    const h = n(game.home_team), a = n(game.away_team);
    if ((h.includes(tA)||tA.includes(h)) && (a.includes(tB)||tB.includes(a)) ||
        (h.includes(tB)||tB.includes(h)) && (a.includes(tA)||tA.includes(a))) {
      const bk = game.bookmakers?.find(b => b.key === "pinnacle") || game.bookmakers?.[0];
      if (!bk) return null;
      const h2h = bk.markets?.find(m => m.key === "h2h");
      if (!h2h) return null;
      const hO = h2h.outcomes?.find(o => n(o.name) === h)?.price;
      const aO = h2h.outcomes?.find(o => n(o.name) === a)?.price;
      if (!hO || !aO) return null;
      const rH = 1/hO, rA = 1/aO, tot = rH+rA;
      return { home_team: game.home_team, away_team: game.away_team, home_prob: Math.round(rH/tot*100)/100, away_prob: Math.round(rA/tot*100)/100, bookmaker: bk.key };
    }
  }
  return null;
}

app.get("/odds", async (req, res) => {
  const { team, opponent } = req.query;
  if (!team || !opponent) return res.status(400).json({ error: "team and opponent required" });
  try {
    const oddsData = await fetchOddsAPI();
    if (!oddsData) return res.json({ available: false, reason: "no_api_key" });
    const match = findMatchOdds(oddsData, team, opponent);
    if (!match) return res.json({ available: false, reason: "match_not_found", team, opponent });
    const n = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g, "");
    const isHome = n(match.home_team).includes(n(team)) || n(team).includes(n(match.home_team));
    res.json({ available: true, team, opponent, win_prob: isHome ? match.home_prob : match.away_prob, opp_prob: isHome ? match.away_prob : match.home_prob, bookmaker: match.bookmaker });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── RELAY ────────────────────────────────────────────────────────────────────
let relayData = null, relayTs = 0;

app.post("/relay", (req, res) => {
  relayData = req.body;
  relayTs = Date.now();
  const count = req.body?.data?.length || 0;
  console.log(`Relay received ${count} props`);
  res.json({ ok: true, count });
});

app.get("/relay", (req, res) => {
  if (!relayData || Date.now() - relayTs > 300000) return res.json({ data: null, expired: true });
  res.json({ data: relayData, ts: relayTs });
});

app.delete("/relay", (req, res) => { relayData = null; res.json({ ok: true }); });

// ─── PICK LOGGER ──────────────────────────────────────────────────────────────
const pickLog = [];

app.post("/picks/log", (req, res) => {
  const pick = { id: Date.now(), logged_at: new Date().toISOString(), ...req.body, result: "PENDING", settled_at: null };
  pickLog.push(pick);
  res.json({ ok: true, id: pick.id, total: pickLog.length });
});

app.get("/picks/log", (req, res) => {
  const { sport, result, limit = 200 } = req.query;
  let log = [...pickLog].reverse();
  if (sport) log = log.filter(p => p.sport === sport);
  if (result) log = log.filter(p => p.result === result);
  log = log.slice(0, parseInt(limit));
  const settled = pickLog.filter(p => p.result !== "PENDING");
  const hits = settled.filter(p => p.result === "HIT").length;
  const stats = {
    total: pickLog.length, settled: settled.length, pending: pickLog.filter(p => p.result === "PENDING").length,
    hits, misses: settled.filter(p => p.result === "MISS").length,
    hit_rate: settled.length > 0 ? Math.round(hits/settled.length*100) : null,
    by_grade: {}, by_sport: {},
  };
  for (const grade of ["S","A","B","C"]) {
    const g = settled.filter(p => p.grade === grade);
    const gh = g.filter(p => p.result === "HIT").length;
    stats.by_grade[grade] = { total: g.length, hits: gh, hit_rate: g.length > 0 ? Math.round(gh/g.length*100) : null };
  }
  for (const p of settled) {
    if (!stats.by_sport[p.sport]) stats.by_sport[p.sport] = { total: 0, hits: 0 };
    stats.by_sport[p.sport].total++;
    if (p.result === "HIT") stats.by_sport[p.sport].hits++;
  }
  res.json({ log, stats });
});

app.patch("/picks/log/:id", (req, res) => {
  const pick = pickLog.find(p => p.id === parseInt(req.params.id));
  if (!pick) return res.status(404).json({ error: "not found" });
  pick.result = req.body.result || pick.result;
  pick.actual = req.body.actual ?? pick.actual;
  pick.settled_at = new Date().toISOString();
  res.json({ ok: true, pick });
});

app.delete("/picks/log", (req, res) => {
  const count = pickLog.length;
  pickLog.length = 0;
  res.json({ ok: true, cleared: count });
});

app.listen(PORT, () => console.log(`Kill Model backend running on port ${PORT}`));
