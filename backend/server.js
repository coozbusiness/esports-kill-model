const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

const cache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
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
      const text = cellMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ─── RECENT FORM SCRAPERS ─────────────────────────────────────────────────────
// Each scraper returns BOTH season avg AND last-30d form where available

async function scrapeGolgg(playerName) {
  const cacheKey = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  // Fetch season avg AND recent 30d form in parallel
  const [seasonHtml, recentHtml] = await Promise.all([
    fetchPage("https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/"),
    fetchPage("https://gol.gg/players/list/season-S15/split-ALL/tournament-ALL/").catch(() => null),
  ]);

  let seasonResult = null, recentResult = null;

  for (const [html, label] of [[seasonHtml, "season"], [recentHtml, "recent"]]) {
    if (!html) continue;
    const rows = extractTableRows(html);
    for (const cells of rows) {
      if (cells.length < 8) continue;
      if (cells[0].toLowerCase().includes(playerName.toLowerCase())) {
        const r = {
          player: cells[0], team: cells[1] || null, role: cells[2] || null,
          kda: parseFloat(cells[3]) || null, kills_per_game: parseFloat(cells[4]) || null,
          deaths_per_game: parseFloat(cells[5]) || null, assists_per_game: parseFloat(cells[6]) || null,
          kill_participation: cells[8] || null, games: parseInt(cells[9]) || null,
        };
        if (label === "season") seasonResult = r;
        else recentResult = r;
        break;
      }
    }
  }

  if (!seasonResult) return { error: "player_not_found", player: playerName, source: "gol.gg" };

  const result = {
    source: "gol.gg",
    ...seasonResult,
    // Recent form overlay — if available and meaningful sample (3+ games)
    recent_kills_per_game: (recentResult?.games >= 3) ? recentResult.kills_per_game : null,
    recent_kda: (recentResult?.games >= 3) ? recentResult.kda : null,
    recent_games: recentResult?.games || null,
    form_trend: recentResult?.games >= 3 && seasonResult.kills_per_game
      ? recentResult.kills_per_game > seasonResult.kills_per_game * 1.1 ? "HOT"
      : recentResult.kills_per_game < seasonResult.kills_per_game * 0.9 ? "COLD"
      : "STABLE"
      : "UNKNOWN",
  };
  setCache(cacheKey, result);
  return result;
}

async function scrapeHltv(playerName) {
  const cacheKey = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const sixMonthsAgo = new Date(Date.now() - 180*24*60*60*1000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);

  // Find player ID from 6-month list
  const html = await fetchPage(`https://www.hltv.org/stats/players?startDate=${sixMonthsAgo}&endDate=${today}&rankingFilter=Top50`);
  const linkRegex = /href="\/stats\/players\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)\s*</gi;
  let playerId = null, playerSlug = null, m;
  while ((m = linkRegex.exec(html)) !== null) {
    if (m[3].trim().toLowerCase() === playerName.toLowerCase()) {
      playerId = m[1]; playerSlug = m[2]; break;
    }
  }
  if (!playerId) return { error: "player_not_found", player: playerName, source: "HLTV" };

  // Fetch both 6-month and 30-day stats in parallel
  const [seasonHtml, recentHtml] = await Promise.all([
    fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${sixMonthsAgo}&endDate=${today}`),
    fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${thirtyDaysAgo}&endDate=${today}`).catch(() => null),
  ]);

  function parseHltvStats(html) {
    const stats = {};
    const statRowRegex = /summaryStatBreakdownName[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+summaryStatBreakdownVal[^>]*>([^<]+)</gi;
    let m;
    while ((m = statRowRegex.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();
    const kpr = parseFloat(stats["KPR"] || 0);
    return {
      rating: parseFloat(stats["Rating 2.0"] || stats["Rating"] || 0),
      kpr, kills_per_map: kpr > 0 ? Math.round(kpr * 25 * 10) / 10 : null,
      adr: parseFloat(stats["ADR"] || 0), kast: stats["KAST"] || null,
      impact: parseFloat(stats["Impact"] || 0),
    };
  }

  const season = parseHltvStats(seasonHtml);
  const recent = recentHtml ? parseHltvStats(recentHtml) : null;

  const result = {
    source: "HLTV", player: playerName,
    ...season,
    recent_kills_per_map: recent?.kills_per_map || null,
    recent_rating: recent?.rating || null,
    form_trend: recent?.rating && season.rating
      ? recent.rating > season.rating * 1.08 ? "HOT"
      : recent.rating < season.rating * 0.92 ? "COLD"
      : "STABLE"
      : "UNKNOWN",
  };
  setCache(cacheKey, result);
  return result;
}

async function scrapeVlr(playerName) {
  const cacheKey = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  // Fetch 90d (season) and 30d (recent form) in parallel
  const [html90, html30] = await Promise.all([
    fetchPage("https://www.vlr.gg/stats/?type=players&timespan=90d"),
    fetchPage("https://www.vlr.gg/stats/?type=players&timespan=30d").catch(() => null),
  ]);

  function parseVlrRow(html, playerName) {
    if (!html) return null;
    const rows = extractTableRows(html);
    for (const cells of rows) {
      if (cells.length < 8) continue;
      const match0 = cells[0].toLowerCase().includes(playerName.toLowerCase());
      const match1 = cells[1] && cells[1].toLowerCase().includes(playerName.toLowerCase());
      if (match0 || match1) {
        const o = match0 ? 0 : 1;
        return {
          rounds: parseInt(cells[2+o]) || null,
          rating: parseFloat(cells[3+o]) || null,
          acs: parseFloat(cells[4+o]) || null,
          kills_per_map: parseFloat(cells[5+o]) || null,
          deaths_per_map: parseFloat(cells[6+o]) || null,
          kast: cells[9+o] || null,
          adr: parseFloat(cells[10+o]) || null,
        };
      }
    }
    return null;
  }

  const season = parseVlrRow(html90, playerName);
  const recent = parseVlrRow(html30, playerName);

  if (!season) return { error: "player_not_found", player: playerName, source: "vlr.gg" };

  const result = {
    source: "vlr.gg", player: playerName,
    ...season,
    recent_acs: recent?.acs || null,
    recent_kills_per_map: recent?.kills_per_map || null,
    recent_rating: recent?.rating || null,
    form_trend: recent?.acs && season.acs
      ? recent.acs > season.acs * 1.1 ? "HOT"
      : recent.acs < season.acs * 0.9 ? "COLD"
      : "STABLE"
      : "UNKNOWN",
  };
  setCache(cacheKey, result);
  return result;
}

// ─── LIQUIPEDIA UNIVERSAL FALLBACK ───────────────────────────────────────────
// Used for R6, COD, APEX, Dota2 — Liquipedia covers all esports
async function scrapeLiquipedia(playerName, wiki) {
  const cacheKey = `liquipedia:${wiki}:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const slug = playerName.toLowerCase().replace(/\s+/g, '_');
  const html = await fetchPage(`https://liquipedia.net/${wiki}/${slug}`);
  // Extract basic stats from infobox
  const result = { source: `liquipedia/${wiki}`, player: playerName };
  // Try to get team
  const teamMatch = html.match(/Team[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]+)<\/a>/i);
  if (teamMatch) result.team = teamMatch[1].trim();
  // Try to get role
  const roleMatch = html.match(/Role[^<]*<\/[^>]+>[^<]*<[^>]+>([^<]+)</i);
  if (roleMatch) result.role = roleMatch[1].trim();
  setCache(cacheKey, result);
  return result;
}

// Wiki mapping per sport
const LIQUIPEDIA_WIKI = {
  Dota2: "dota2",
  R6: "rainbowsix",
  COD: "callofduty",
  APEX: "apexlegends",
  LoL: "leagueoflegends",
  CS2: "counterstrike",
  Valorant: "valorant",
};

function formatNotes(data) {
  if (!data || data.error) return null;
  const trend = data.form_trend && data.form_trend !== "UNKNOWN" ? ` | Form: ${data.form_trend}` : "";
  if (data.source === "gol.gg") {
    const recent = data.recent_kills_per_game != null ? ` | Last 30d: ${data.recent_kills_per_game} kills/g (${data.recent_games}g)` : "";
    return [`gol.gg (${data.games||"?"}g):`, `${data.kills_per_game} kills/g season avg`, data.kda != null ? `KDA ${data.kda}` : null, data.kill_participation ? `KP ${data.kill_participation}` : null, recent || null, trend || null].filter(Boolean).join(", ");
  }
  if (data.source === "HLTV") {
    const recent = data.recent_kills_per_map != null ? ` | Last 30d: ${data.recent_kills_per_map} kills/map (Rating ${data.recent_rating})` : "";
    return [`HLTV:`, `Rating ${data.rating}`, data.kills_per_map != null ? `${data.kills_per_map} kills/map` : null, data.adr ? `ADR ${data.adr}` : null, data.kast ? `KAST ${data.kast}` : null, recent || null, trend || null].filter(Boolean).join(", ");
  }
  if (data.source === "vlr.gg") {
    const recent = data.recent_kills_per_map != null ? ` | Last 30d: ${data.recent_kills_per_map} kills/map (ACS ${data.recent_acs})` : "";
    return [`vlr.gg (${data.rounds||"?"}rnd):`, data.acs != null ? `ACS ${data.acs}` : null, data.kills_per_map != null ? `${data.kills_per_map} kills/map` : null, data.kast ? `KAST ${data.kast}` : null, data.adr ? `ADR ${data.adr}` : null, recent || null, trend || null].filter(Boolean).join(", ");
  }
  if (data.source && data.source.includes("liquipedia")) return [data.source + ":", data.team ? `Team: ${data.team}` : null, data.role ? `Role: ${data.role}` : null].filter(Boolean).join(", ");
  return null;
}

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/stats", async (req, res) => {
  const { player, sport } = req.query;
  if (!player || !sport) return res.status(400).json({ error: "player and sport required" });
  try {
    let data;
    if (sport === "LoL") data = await scrapeGolgg(player).catch(() => scrapeLiquipedia(player, "leagueoflegends"));
    else if (sport === "CS2") data = await scrapeHltv(player).catch(() => scrapeLiquipedia(player, "counterstrike"));
    else if (sport === "Valorant") data = await scrapeVlr(player).catch(() => scrapeLiquipedia(player, "valorant"));
    else if (sport === "Dota2") data = await scrapeLiquipedia(player, "dota2");
    else if (sport === "R6") data = await scrapeLiquipedia(player, "rainbowsix");
    else if (sport === "COD") data = await scrapeLiquipedia(player, "callofduty");
    else if (sport === "APEX") data = await scrapeLiquipedia(player, "apexlegends");
    else data = await scrapeLiquipedia(player, "commons");
    res.json({ ...data, notes: formatNotes(data) });
  } catch (err) { res.status(500).json({ error: "scrape_failed", message: err.message, player, sport }); }
});

app.post("/stats/batch", async (req, res) => {
  const props = req.body;
  if (!Array.isArray(props) || !props.length) return res.status(400).json({ error: "body must be array" });
  const seen = new Set();
  const unique = props.filter(p => { const k = `${p.player}::${p.sport}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const results = {};
  for (const { player, sport } of unique) {
    try {
      let data;
      if (sport === "LoL") data = await scrapeGolgg(player).catch(() => scrapeLiquipedia(player, "leagueoflegends"));
      else if (sport === "CS2") data = await scrapeHltv(player).catch(() => scrapeLiquipedia(player, "counterstrike"));
      else if (sport === "Valorant") data = await scrapeVlr(player).catch(() => scrapeLiquipedia(player, "valorant"));
      else if (sport === "Dota2") data = await scrapeLiquipedia(player, "dota2");
      else if (sport === "R6") data = await scrapeLiquipedia(player, "rainbowsix");
      else if (sport === "COD") data = await scrapeLiquipedia(player, "callofduty");
      else if (sport === "APEX") data = await scrapeLiquipedia(player, "apexlegends");
      else data = { error: "unsupported_sport" };
      results[`${player}::${sport}`] = { ...data, notes: formatNotes(data) };
    } catch (err) { results[`${player}::${sport}`] = { error: "scrape_failed", message: err.message }; }
    await new Promise(r => setTimeout(r, 1000));
  }
  res.json(results);
});

app.post("/cache/clear", (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ cleared: count });
});

app.post("/analyze", async (req, res) => {
  try {
    const payload = JSON.stringify(req.body);
    console.log("Analyze called, payload size:", payload.length);
    console.log("API key present:", !!process.env.ANTHROPIC_KEY);
    console.log("API key prefix:", process.env.ANTHROPIC_KEY ? process.env.ANTHROPIC_KEY.slice(0, 15) : "MISSING");
    
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
        console.log("Anthropic response status:", r.statusCode);
        const chunks = [];
        r.on("data", chunk => chunks.push(chunk));
        r.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          console.log("Anthropic response body:", body.slice(0, 200));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Failed to parse Anthropic response: " + body.slice(0, 100)));
          }
        });
        r.on("error", reject);
      });
      req2.on("error", (e) => {
        console.error("Request error:", e.message);
        reject(e);
      });
      req2.write(payload);
      req2.end();
    });
    res.json(result);
  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ODDS API — PINNACLE WIN PROBABILITIES ───────────────────────────────────
// The Odds API: free tier, 500 req/month, aggregates Pinnacle + sharp books
// Sign up at the-odds-api.com for a free key — add as ODDS_API_KEY env var

const ODDS_CACHE = {};
const ODDS_TTL   = 30 * 60 * 1000; // 30 min cache

// Esports sport keys on The Odds API
const ESPORTS_ODDS_KEYS = {
  LoL:      "esports",
  CS2:      "esports",
  Valorant: "esports",
  Dota2:    "esports",
  R6:       "esports",
  COD:      "esports",
  APEX:     "esports",
};

async function fetchOddsAPI(sport) {
  if (!process.env.ODDS_API_KEY) return null;
  const cacheKey = `odds:${sport}`;
  const cached = ODDS_CACHE[cacheKey];
  if (cached && Date.now() - cached.ts < ODDS_TTL) return cached.data;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/esports/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=pinnacle,draftkings&oddsFormat=decimal`;
    const html = await fetchPage(url);
    const data = JSON.parse(html);
    ODDS_CACHE[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch(e) {
    console.log("Odds API error:", e.message);
    return null;
  }
}

function decimalToProb(decimal) {
  return decimal > 0 ? Math.round((1 / decimal) * 100) / 100 : null;
}

function findMatchOdds(oddsData, teamA, teamB) {
  if (!oddsData || !Array.isArray(oddsData)) return null;
  const normalize = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tA = normalize(teamA);
  const tB = normalize(teamB);
  for (const game of oddsData) {
    const h = normalize(game.home_team);
    const a = normalize(game.away_team);
    if ((h.includes(tA) || tA.includes(h)) && (a.includes(tB) || tB.includes(a)) ||
        (h.includes(tB) || tB.includes(h)) && (a.includes(tA) || tA.includes(a))) {
      // Find Pinnacle bookmaker
      const pinnacle = game.bookmakers?.find(b => b.key === "pinnacle") || game.bookmakers?.[0];
      if (!pinnacle) return null;
      const h2h = pinnacle.markets?.find(m => m.key === "h2h");
      if (!h2h) return null;
      const homeOdds = h2h.outcomes?.find(o => normalize(o.name) === h)?.price;
      const awayOdds = h2h.outcomes?.find(o => normalize(o.name) === a)?.price;
      if (!homeOdds || !awayOdds) return null;
      // Remove vig — normalize probabilities
      const rawHome = 1 / homeOdds;
      const rawAway = 1 / awayOdds;
      const total = rawHome + rawAway;
      return {
        home_team: game.home_team,
        away_team: game.away_team,
        home_prob: Math.round((rawHome / total) * 100) / 100,
        away_prob: Math.round((rawAway / total) * 100) / 100,
        bookmaker: pinnacle.key,
        commence_time: game.commence_time,
      };
    }
  }
  return null;
}

// GET /odds?team=TeamA&opponent=TeamB&sport=LoL
app.get("/odds", async (req, res) => {
  const { team, opponent, sport } = req.query;
  if (!team || !opponent) return res.status(400).json({ error: "team and opponent required" });
  try {
    const oddsData = await fetchOddsAPI(sport || "LoL");
    if (!oddsData) return res.json({ available: false, reason: "no_api_key" });
    const match = findMatchOdds(oddsData, team, opponent);
    if (!match) return res.json({ available: false, reason: "match_not_found", team, opponent });
    // Return win prob for the requested team
    const normalize = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g, "");
    const isHome = normalize(match.home_team).includes(normalize(team)) ||
                   normalize(team).includes(normalize(match.home_team));
    res.json({
      available: true,
      team, opponent,
      win_prob: isHome ? match.home_prob : match.away_prob,
      opp_prob: isHome ? match.away_prob : match.home_prob,
      bookmaker: match.bookmaker,
      match_time: match.commence_time,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── RELAY ENDPOINT ──────────────────────────────────────────────────────────
// Extension POSTs captured PrizePicks data here
// App GETs it from here — no cross-origin issues

let relayData = null;
let relayTs = 0;

app.post('/relay', (req, res) => {
  relayData = req.body;
  relayTs = Date.now();
  const count = req.body?.data?.length || 0;
  console.log(`Relay received ${count} props`);
  res.json({ ok: true, count });
});

app.get('/relay', (req, res) => {
  if (!relayData || Date.now() - relayTs > 300000) { // expire after 5 min
    return res.json({ data: null, expired: true });
  }
  res.json({ data: relayData, ts: relayTs });
});

app.delete('/relay', (req, res) => {
  relayData = null;
  res.json({ ok: true });
});

// ─── PRIZEPICKS PROXY ─────────────────────────────────────────────────────────
// Fetches directly from PrizePicks public API and returns esports props
// No auth needed — PrizePicks API is public

const ESPORTS_KEYWORDS = [
  'league of legends', 'lol', 'counter-strike', 'cs2', 'valorant', 'val',
  'dota', 'rainbow six', 'r6', 'call of duty', 'cod', 'apex legends',
  'esports', 'e-sports', 'overwatch', 'rocket league'
];

// Known esports league IDs (cached, updated dynamically)
let leagueCache = null;
let leagueCacheTs = 0;
const LEAGUE_CACHE_TTL = 30 * 60 * 1000; // 30 min

function fetchPrizePicksURL(url) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.prizepicks.com',
      path: url.replace('https://api.prizepicks.com', ''),
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://app.prizepicks.com',
        'Referer': 'https://app.prizepicks.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'Connection': 'keep-alive',
      }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      // Handle gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'br') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createBrotliDecompress());
      }
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchPrizePicksLeagues() {
  if (leagueCache && Date.now() - leagueCacheTs < LEAGUE_CACHE_TTL) {
    return leagueCache;
  }
  const html = await fetchPrizePicksURL('https://api.prizepicks.com/leagues');
  const data = JSON.parse(html);
  const esportsLeagues = (data.data || []).filter(league => {
    const name = (league.attributes?.name || league.attributes?.sport || '').toLowerCase();
    return ESPORTS_KEYWORDS.some(kw => name.includes(kw));
  });
  leagueCache = esportsLeagues;
  leagueCacheTs = Date.now();
  console.log('PrizePicks esports leagues:', esportsLeagues.map(l => `${l.id}:${l.attributes?.name}`));
  return esportsLeagues;
}

async function fetchPrizePicksProjections(leagueId, stateCode = 'CA') {
  const url = `https://api.prizepicks.com/projections?league_id=${leagueId}&per_page=250&single_stat=true&in_game=true&state_code=${stateCode}&game_mode=prizepools`;
  const html = await fetchPrizePicksURL(url);
  return JSON.parse(html);
}

// GET /prizepicks/leagues - returns list of esports leagues
app.get('/prizepicks/leagues', async (req, res) => {
  try {
    const leagues = await fetchPrizePicksLeagues();
    res.json({ leagues: leagues.map(l => ({ id: l.id, name: l.attributes?.name, sport: l.attributes?.sport })) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /prizepicks/props?sport=LoL&state=CA
// Fetches all props for specified sport(s)
app.get('/prizepicks/props', async (req, res) => {
  const { sport, state = 'CA' } = req.query;
  try {
    const leagues = await fetchPrizePicksLeagues();

    // Filter leagues by requested sport
    const sportKeywords = {
      'LoL':      ['league of legends', 'lol'],
      'CS2':      ['counter-strike', 'cs2', 'cs '],
      'Valorant': ['valorant', 'val'],
      'Dota2':    ['dota'],
      'R6':       ['rainbow six', 'r6'],
      'COD':      ['call of duty', 'cod'],
      'APEX':     ['apex'],
      'ALL':      ESPORTS_KEYWORDS,
    };

    const keywords = sportKeywords[sport] || sportKeywords['ALL'];
    const targetLeagues = leagues.filter(l => {
      const name = (l.attributes?.name || l.attributes?.sport || '').toLowerCase();
      return keywords.some(kw => name.includes(kw));
    });

    if (!targetLeagues.length) {
      // Fallback: fetch all esports leagues
      const allLeagues = sport === 'ALL' ? leagues : leagues;
      if (!allLeagues.length) return res.json({ data: [], included: [], meta: { sport, count: 0 } });
    }

    const leaguesToFetch = targetLeagues.length ? targetLeagues : leagues;

    // Fetch projections for each league in parallel
    const results = await Promise.all(
      leaguesToFetch.map(l => fetchPrizePicksProjections(l.id, state).catch(e => null))
    );

    // Merge all results
    const merged = { data: [], included: [] };
    for (const r of results) {
      if (!r) continue;
      merged.data.push(...(r.data || []));
      // Deduplicate included by id
      const existingIds = new Set(merged.included.map(i => i.id));
      for (const item of (r.included || [])) {
        if (!existingIds.has(item.id)) {
          merged.included.push(item);
          existingIds.add(item.id);
        }
      }
    }

    res.json({ ...merged, meta: { sport, count: merged.data.length, leagues: leaguesToFetch.map(l => l.attributes?.name) } });
  } catch(err) {
    console.error('PrizePicks proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PICK LOGGER ─────────────────────────────────────────────────────────────
// In-memory pick log — persists until Render restarts
// For production, wire to a DB. For now this survives daily use.

const pickLog = [];

app.post("/picks/log", (req, res) => {
  const pick = {
    id: Date.now(),
    logged_at: new Date().toISOString(),
    ...req.body,
    result: "PENDING", // "HIT", "MISS", "PUSH", "PENDING"
    settled_at: null,
  };
  pickLog.push(pick);
  console.log(`Pick logged: ${pick.player} ${pick.rec} ${pick.line} (${pick.sport})`);
  res.json({ ok: true, id: pick.id, total: pickLog.length });
});

app.get("/picks/log", (req, res) => {
  const { sport, result, limit = 200 } = req.query;
  let log = [...pickLog].reverse(); // most recent first
  if (sport) log = log.filter(p => p.sport === sport);
  if (result) log = log.filter(p => p.result === result);
  log = log.slice(0, parseInt(limit));

  // Compute stats
  const settled = pickLog.filter(p => p.result !== "PENDING");
  const hits = settled.filter(p => p.result === "HIT").length;
  const stats = {
    total: pickLog.length,
    settled: settled.length,
    pending: pickLog.filter(p => p.result === "PENDING").length,
    hits, misses: settled.filter(p => p.result === "MISS").length,
    hit_rate: settled.length > 0 ? Math.round((hits / settled.length) * 100) : null,
    by_grade: { S: {}, A: {}, B: {}, C: {} },
    by_sport: {},
  };
  // Grade breakdown
  for (const grade of ["S","A","B","C"]) {
    const g = settled.filter(p => p.grade === grade);
    const gh = g.filter(p => p.result === "HIT").length;
    stats.by_grade[grade] = { total: g.length, hits: gh, hit_rate: g.length > 0 ? Math.round(gh/g.length*100) : null };
  }
  // Sport breakdown
  for (const p of settled) {
    if (!stats.by_sport[p.sport]) stats.by_sport[p.sport] = { total: 0, hits: 0 };
    stats.by_sport[p.sport].total++;
    if (p.result === "HIT") stats.by_sport[p.sport].hits++;
  }

  res.json({ log, stats });
});

app.patch("/picks/log/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const pick = pickLog.find(p => p.id === id);
  if (!pick) return res.status(404).json({ error: "not found" });
  pick.result = req.body.result || pick.result;
  pick.actual = req.body.actual ?? pick.actual; // actual kills
  pick.settled_at = new Date().toISOString();
  res.json({ ok: true, pick });
});

app.delete("/picks/log", (req, res) => {
  const count = pickLog.length;
  pickLog.length = 0;
  res.json({ ok: true, cleared: count });
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
