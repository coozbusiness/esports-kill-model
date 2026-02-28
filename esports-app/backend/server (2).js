const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");

const app = express();
app.use(cors());
app.use(express.json());

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

async function scrapeGolgg(playerName) {
  const cacheKey = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const html = await fetchPage("https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/");
  const rows = extractTableRows(html);
  for (const cells of rows) {
    if (cells.length < 8) continue;
    if (cells[0].toLowerCase().includes(playerName.toLowerCase())) {
      const result = {
        source: "gol.gg", player: cells[0], team: cells[1] || null, role: cells[2] || null,
        kda: parseFloat(cells[3]) || null, kills_per_game: parseFloat(cells[4]) || null,
        deaths_per_game: parseFloat(cells[5]) || null, assists_per_game: parseFloat(cells[6]) || null,
        kill_participation: cells[8] || null, games: parseInt(cells[9]) || null,
      };
      setCache(cacheKey, result);
      return result;
    }
  }
  return { error: "player_not_found", player: playerName, source: "gol.gg" };
}

async function scrapeHltv(playerName) {
  const cacheKey = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const sixMonthsAgo = new Date(Date.now() - 180*24*60*60*1000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  const html = await fetchPage(`https://www.hltv.org/stats/players?startDate=${sixMonthsAgo}&endDate=${today}&rankingFilter=Top50`);
  const linkRegex = /href="\/stats\/players\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)\s*</gi;
  let playerId = null, playerSlug = null, m;
  while ((m = linkRegex.exec(html)) !== null) {
    if (m[3].trim().toLowerCase() === playerName.toLowerCase()) {
      playerId = m[1]; playerSlug = m[2]; break;
    }
  }
  if (!playerId) return { error: "player_not_found", player: playerName, source: "HLTV" };
  const playerHtml = await fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${sixMonthsAgo}&endDate=${today}`);
  const stats = {};
  const statRowRegex = /summaryStatBreakdownName[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+summaryStatBreakdownVal[^>]*>([^<]+)</gi;
  while ((m = statRowRegex.exec(playerHtml)) !== null) stats[m[1].trim()] = m[2].trim();
  const kpr = parseFloat(stats["KPR"] || 0);
  const result = {
    source: "HLTV", player: playerName,
    rating: parseFloat(stats["Rating 2.0"] || stats["Rating"] || 0),
    kpr, kills_per_map: kpr > 0 ? Math.round(kpr * 25 * 10) / 10 : null,
    adr: parseFloat(stats["ADR"] || 0), kast: stats["KAST"] || null,
    impact: parseFloat(stats["Impact"] || 0),
  };
  setCache(cacheKey, result);
  return result;
}

async function scrapeVlr(playerName) {
  const cacheKey = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const html = await fetchPage("https://www.vlr.gg/stats/?type=players&timespan=90d");
  const rows = extractTableRows(html);
  for (const cells of rows) {
    if (cells.length < 8) continue;
    if (cells[0].toLowerCase().includes(playerName.toLowerCase()) || cells[1].toLowerCase().includes(playerName.toLowerCase())) {
      const o = cells[0].toLowerCase().includes(playerName.toLowerCase()) ? 0 : 1;
      const result = {
        source: "vlr.gg", player: cells[o],
        rounds: parseInt(cells[2+o]) || null, rating: parseFloat(cells[3+o]) || null,
        acs: parseFloat(cells[4+o]) || null, kills_per_map: parseFloat(cells[5+o]) || null,
        deaths_per_map: parseFloat(cells[6+o]) || null, kast: cells[9+o] || null,
        adr: parseFloat(cells[10+o]) || null,
      };
      setCache(cacheKey, result);
      return result;
    }
  }
  return { error: "player_not_found", player: playerName, source: "vlr.gg" };
}

function formatNotes(data) {
  if (!data || data.error) return null;
  if (data.source === "gol.gg") return [`gol.gg (${data.games||"?"}g):`, data.kills_per_game != null ? `${data.kills_per_game} kills/game` : null, data.kda != null ? `KDA ${data.kda}` : null, data.kill_participation ? `KP ${data.kill_participation}` : null].filter(Boolean).join(", ");
  if (data.source === "HLTV") return [`HLTV:`, data.rating ? `Rating ${data.rating}` : null, data.kills_per_map != null ? `~${data.kills_per_map} kills/map` : null, data.adr ? `ADR ${data.adr}` : null, data.kast ? `KAST ${data.kast}` : null].filter(Boolean).join(", ");
  if (data.source === "vlr.gg") return [`vlr.gg (${data.rounds||"?"}rnd):`, data.acs != null ? `ACS ${data.acs}` : null, data.kills_per_map != null ? `${data.kills_per_map} kills/map` : null, data.kast ? `KAST ${data.kast}` : null, data.adr ? `ADR ${data.adr}` : null].filter(Boolean).join(", ");
  return null;
}

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.get("/stats", async (req, res) => {
  const { player, sport } = req.query;
  if (!player || !sport) return res.status(400).json({ error: "player and sport required" });
  try {
    let data;
    if (sport === "LoL" || sport === "Dota2") data = await scrapeGolgg(player);
    else if (sport === "CS2") data = await scrapeHltv(player);
    else if (sport === "Valorant") data = await scrapeVlr(player);
    else return res.json({ error: "unsupported_sport", player, sport });
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
      if (sport === "LoL" || sport === "Dota2") data = await scrapeGolgg(player);
      else if (sport === "CS2") data = await scrapeHltv(player);
      else if (sport === "Valorant") data = await scrapeVlr(player);
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

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
