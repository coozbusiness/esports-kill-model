const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ─── CACHE ────────────────────────────────────────────────────────────────────
// Simple in-memory cache — stats don't change mid-day
const cache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { delete cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
    },
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

// ─── GOL.GG SCRAPER (League of Legends) ──────────────────────────────────────
// URL: https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/
// Finds player row in the global stats table, returns kills/game + KDA

async function scrapeGolgg(playerName) {
  const cacheKey = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Search for player
  const searchUrl = `https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/`;
  const html = await fetchPage(searchUrl);
  const $ = cheerio.load(html);

  let result = null;
  $("table tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (!cells.length) return;
    const nameCell = $(cells[0]).text().trim();
    if (nameCell.toLowerCase().includes(playerName.toLowerCase())) {
      // Columns: Player | Team | Role | KDA | Kills | Deaths | Assists | CS/min | KP | Games
      result = {
        source: "gol.gg",
        player: nameCell,
        kda: parseFloat($(cells[3]).text().trim()) || null,
        kills_per_game: parseFloat($(cells[4]).text().trim()) || null,
        deaths_per_game: parseFloat($(cells[5]).text().trim()) || null,
        assists_per_game: parseFloat($(cells[6]).text().trim()) || null,
        kill_participation: $(cells[8]).text().trim() || null,
        games: parseInt($(cells[9]).text().trim()) || null,
        role: $(cells[2]).text().trim() || null,
        team: $(cells[1]).text().trim() || null,
      };
      return false; // break
    }
  });

  if (!result) {
    // Try individual player page search
    const encoded = encodeURIComponent(playerName.toLowerCase());
    const playerListHtml = await fetchPage(`https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/`);
    const $2 = cheerio.load(playerListHtml);
    // Find the player link to get their ID
    let playerUrl = null;
    $2("table tbody tr td a").each((_, el) => {
      const text = $2(el).text().trim();
      if (text.toLowerCase() === playerName.toLowerCase()) {
        playerUrl = "https://gol.gg" + $2(el).attr("href");
        return false;
      }
    });
    if (playerUrl) {
      const playerHtml = await fetchPage(playerUrl);
      const $3 = cheerio.load(playerHtml);
      // Individual player page has stats in a different table
      $3("table tbody tr").first().each((_, row) => {
        const cells = $3(row).find("td");
        if (cells.length >= 6) {
          result = {
            source: "gol.gg",
            player: playerName,
            kda: parseFloat($3(cells[0]).text().trim()) || null,
            kills_per_game: parseFloat($3(cells[1]).text().trim()) || null,
            deaths_per_game: parseFloat($3(cells[2]).text().trim()) || null,
            assists_per_game: parseFloat($3(cells[3]).text().trim()) || null,
            kill_participation: $3(cells[5]).text().trim() || null,
            games: parseInt($3(cells[6]).text().trim()) || null,
          };
        }
      });
    }
  }

  if (result) setCache(cacheKey, result);
  return result;
}

// ─── HLTV SCRAPER (CS2) ───────────────────────────────────────────────────────
// URL: https://www.hltv.org/stats/players?startDate=2025-01-01&endDate=2025-12-31
// Finds player in stats table, then fetches their individual page for detailed stats

async function scrapeHltv(playerName) {
  const cacheKey = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // HLTV stats leaderboard — get player ID from here
  const today = new Date().toISOString().slice(0, 10);
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const listUrl = `https://www.hltv.org/stats/players?startDate=${sixMonthsAgo}&endDate=${today}&rankingFilter=Top50`;

  const html = await fetchPage(listUrl);
  const $ = cheerio.load(html);

  let playerId = null;
  let playerSlug = null;

  // Find player row in leaderboard
  $(".stats-table tbody tr").each((_, row) => {
    const nameEl = $(row).find(".playerCol a");
    const name = nameEl.text().trim();
    if (name.toLowerCase() === playerName.toLowerCase()) {
      const href = nameEl.attr("href") || "";
      // href format: /stats/players/7398/ZywOo
      const parts = href.split("/");
      playerId = parts[3];
      playerSlug = parts[4];
      return false;
    }
  });

  if (!playerId) {
    // Try broader search without ranking filter
    const broadUrl = `https://www.hltv.org/stats/players?startDate=${sixMonthsAgo}&endDate=${today}`;
    const broadHtml = await fetchPage(broadUrl);
    const $2 = cheerio.load(broadHtml);
    $2(".stats-table tbody tr").each((_, row) => {
      const nameEl = $2(row).find(".playerCol a");
      const name = nameEl.text().trim();
      if (name.toLowerCase() === playerName.toLowerCase()) {
        const href = nameEl.attr("href") || "";
        const parts = href.split("/");
        playerId = parts[3];
        playerSlug = parts[4];
        return false;
      }
    });
  }

  if (!playerId) return { error: "player_not_found", player: playerName, source: "HLTV" };

  // Fetch individual player stats page
  const playerUrl = `https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${sixMonthsAgo}&endDate=${today}`;
  const playerHtml = await fetchPage(playerUrl);
  const $p = cheerio.load(playerHtml);

  const stats = {};
  $p(".summaryStatBreakdownRow").each((_, row) => {
    const name = $p(row).find(".summaryStatBreakdownName").text().trim();
    const val = $p(row).find(".summaryStatBreakdownVal").text().trim();
    if (name && val) stats[name] = val;
  });

  // Also get kills per map from individual stats box
  $p(".statistics .col .columns").each((_, col) => {
    const label = $p(col).find(".col-desc").text().trim();
    const val = $p(col).find(".bold").text().trim();
    if (label && val) stats[label] = val;
  });

  const kpr = parseFloat(stats["KPR"] || stats["Kills / round"] || 0);
  const result = {
    source: "HLTV",
    player: playerName,
    player_id: playerId,
    rating: parseFloat(stats["Rating 2.0"] || stats["Rating"] || 0),
    kpr,
    kills_per_map: kpr > 0 ? Math.round(kpr * 25 * 10) / 10 : null,
    adr: parseFloat(stats["ADR"] || stats["Damage / Round"] || 0),
    kast: stats["KAST"] || null,
    impact: parseFloat(stats["Impact"] || 0),
    dpr: parseFloat(stats["DPR"] || 0),
    profile_url: playerUrl,
  };

  setCache(cacheKey, result);
  return result;
}

// ─── VLR.GG SCRAPER (Valorant) ────────────────────────────────────────────────
// URL: https://www.vlr.gg/stats/?type=players&timespan=90d
// Finds player, returns ACS, kills/map, KAST, ADR

async function scrapeVlr(playerName) {
  const cacheKey = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const statsUrl = `https://www.vlr.gg/stats/?type=players&timespan=90d`;
  const html = await fetchPage(statsUrl);
  const $ = cheerio.load(html);

  let result = null;
  let playerUrl = null;

  // Find player in stats table
  $(".wf-table tbody tr").each((_, row) => {
    const nameEl = $(row).find(".mod-player .text-of");
    const name = nameEl.text().trim();
    if (name.toLowerCase() === playerName.toLowerCase()) {
      const href = $(row).find("a").attr("href") || "";
      playerUrl = href ? `https://www.vlr.gg${href}` : null;

      const cells = $(row).find("td");
      // Columns vary but typically: player | team | agents | rounds | rating | acs | k | d | a | +/- | kast | adr | hs | fk | fd | fk+-
      result = {
        source: "vlr.gg",
        player: name,
        rounds: parseInt($(cells[3]).text().trim()) || null,
        rating: parseFloat($(cells[4]).text().trim()) || null,
        acs: parseFloat($(cells[5]).text().trim()) || null,
        kills_per_map: parseFloat($(cells[6]).text().trim()) || null,
        deaths_per_map: parseFloat($(cells[7]).text().trim()) || null,
        assists_per_map: parseFloat($(cells[8]).text().trim()) || null,
        kast: $(cells[10]).text().trim() || null,
        adr: parseFloat($(cells[11]).text().trim()) || null,
        hs_pct: $(cells[12]).text().trim() || null,
        first_kills_per_map: parseFloat($(cells[13]).text().trim()) || null,
      };
      return false;
    }
  });

  // If found but want more detail, fetch individual player page
  if (result && playerUrl) {
    try {
      const playerHtml = await fetchPage(playerUrl);
      const $p = cheerio.load(playerHtml);
      // Get agent breakdown
      const agents = [];
      $p(".wf-table tbody tr").each((_, row) => {
        const agentName = $p(row).find("td").first().text().trim();
        const agentAcs = parseFloat($p(row).find("td").eq(2).text().trim()) || 0;
        if (agentName && agentName !== "All Agents" && agents.length < 3) {
          agents.push(`${agentName}(ACS ${agentAcs})`);
        }
      });
      if (agents.length) result.top_agents = agents.join(", ");
    } catch (e) {
      // Individual page optional — main stats already captured
    }
  }

  if (result) setCache(cacheKey, result);
  else return { error: "player_not_found", player: playerName, source: "vlr.gg" };
  return result;
}

// ─── FORMAT FOR SCOUT NOTES ───────────────────────────────────────────────────
function formatNotes(data) {
  if (!data || data.error) return null;

  if (data.source === "gol.gg") {
    return [
      `gol.gg (${data.games || "?"}g):`,
      data.kills_per_game != null ? `${data.kills_per_game} kills/game` : null,
      data.kda != null ? `KDA ${data.kda}` : null,
      data.kill_participation ? `KP ${data.kill_participation}` : null,
      data.role ? `Role: ${data.role}` : null,
      data.team ? `Team: ${data.team}` : null,
    ].filter(Boolean).join(", ");
  }

  if (data.source === "HLTV") {
    return [
      `HLTV stats:`,
      data.rating ? `Rating ${data.rating}` : null,
      data.kills_per_map != null ? `~${data.kills_per_map} kills/map` : null,
      data.adr ? `ADR ${data.adr}` : null,
      data.kast ? `KAST ${data.kast}` : null,
      data.impact ? `Impact ${data.impact}` : null,
    ].filter(Boolean).join(", ");
  }

  if (data.source === "vlr.gg") {
    return [
      `vlr.gg (${data.rounds || "?"}rnd):`,
      data.acs != null ? `ACS ${data.acs}` : null,
      data.kills_per_map != null ? `${data.kills_per_map} kills/map` : null,
      data.kast ? `KAST ${data.kast}` : null,
      data.adr ? `ADR ${data.adr}` : null,
      data.top_agents ? `Agents: ${data.top_agents}` : null,
    ].filter(Boolean).join(", ");
  }

  return null;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// Single player lookup
// GET /stats?player=knight&sport=LoL
app.get("/stats", async (req, res) => {
  const { player, sport } = req.query;
  if (!player || !sport) {
    return res.status(400).json({ error: "player and sport required" });
  }

  try {
    let data;
    if (sport === "LoL" || sport === "Dota2") {
      data = await scrapeGolgg(player);
    } else if (sport === "CS2") {
      data = await scrapeHltv(player);
    } else if (sport === "Valorant") {
      data = await scrapeVlr(player);
    } else {
      return res.json({ error: "unsupported_sport", player, sport });
    }

    const notes = formatNotes(data);
    res.json({ ...data, notes });
  } catch (err) {
    res.status(500).json({
      error: "scrape_failed",
      message: err.message,
      player,
      sport,
    });
  }
});

// Batch lookup — POST /stats/batch
// Body: [{ player: "knight", sport: "LoL" }, ...]
app.post("/stats/batch", async (req, res) => {
  const props = req.body;
  if (!Array.isArray(props) || !props.length) {
    return res.status(400).json({ error: "body must be array of {player, sport}" });
  }

  // Deduplicate by player+sport
  const seen = new Set();
  const unique = props.filter(p => {
    const k = `${p.player}::${p.sport}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Run sequentially to be polite to sites (1 req/sec)
  const results = {};
  for (const { player, sport } of unique) {
    try {
      let data;
      if (sport === "LoL" || sport === "Dota2") data = await scrapeGolgg(player);
      else if (sport === "CS2") data = await scrapeHltv(player);
      else if (sport === "Valorant") data = await scrapeVlr(player);
      else data = { error: "unsupported_sport" };

      results[`${player}::${sport}`] = {
        ...data,
        notes: formatNotes(data),
      };
    } catch (err) {
      results[`${player}::${sport}`] = {
        error: "scrape_failed",
        message: err.message,
        player,
        sport,
      };
    }
    // 1 second between requests — be polite
    await new Promise(r => setTimeout(r, 1000));
  }

  res.json(results);
});

// Cache clear (useful if you want fresh stats)
app.post("/cache/clear", (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ cleared: count });
});

app.listen(PORT, () => {
  console.log(`Esports stats backend running on port ${PORT}`);
});
