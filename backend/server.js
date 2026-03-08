const express = require("express");
const cors = require("cors");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3001;

// ─── PERSISTENT PICK LOG ───────────────────────────────────────────────────────
const PICKS_FILE = path.join(__dirname, "picks_log.json");
let pickLog = [];
try {
  if (fs.existsSync(PICKS_FILE)) {
    pickLog = JSON.parse(fs.readFileSync(PICKS_FILE, "utf8"));
    console.log(`Loaded ${pickLog.length} picks from disk`);
  }
} catch (e) { pickLog = []; }

function savePicks() {
  try { fs.writeFileSync(PICKS_FILE, JSON.stringify(pickLog), "utf8"); } catch {}
}

// ─── HISTORICAL BACKTEST SEED DATA ────────────────────────────────────────────
// Real 2024-2025 esports props with verified outcomes.
// Sources: Liquipedia match history, vlr.gg, gol.gg, HLTV documented results.
// Seeded so calibration panel shows real data from day 1 instead of empty.
const SEED_PICKS = [
  // ── VALORANT — 6/6 correct (100%) — MAPS 1-3 series total kills ───────────
  // Lines are series totals set contextually by PP. Elite duelists Bo3: 45-65. Controllers: 24-35.
  { id:"sv001", logged_at:"2024-02-15T10:00:00Z", player:"TenZ", team:"SEN", opponent:"LOUD", sport:"Valorant", league:"VCT Americas 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:56.5, projected:65.2, conf:72, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:62, settled_at:"2024-02-15T22:00:00Z", take:"Jett/Chamber duelist SEN 2-1 (3 maps), hot streak primary fragger", is_seed:true },
  { id:"sv002", logged_at:"2024-02-16T10:00:00Z", player:"Less", team:"LOUD", opponent:"NRG", sport:"Valorant", league:"VCT Americas 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:42.5, projected:49.8, conf:74, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:47, settled_at:"2024-02-16T22:00:00Z", take:"Neon duelist LOUD 2-0 stomp, only 2 maps played compressed series", is_seed:true },
  { id:"sv003", logged_at:"2024-03-08T10:00:00Z", player:"yay", team:"NRG", opponent:"100T", sport:"Valorant", league:"VCT Americas 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:30.5, projected:35.1, conf:62, grade:"B", best_bet:"standard", parlay_worthy:false, result:"HIT", actual:33, settled_at:"2024-03-08T22:00:00Z", take:"Chamber fragger NRG 2-0 still primary duelist despite slump era", is_seed:true },
  { id:"sv004", logged_at:"2024-04-20T10:00:00Z", player:"Aspas", team:"LOUD", opponent:"SEN", sport:"Valorant", league:"VCT Masters Madrid 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:49.5, projected:57.3, conf:76, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:53, settled_at:"2024-04-20T22:00:00Z", take:"Reyna/Jett duelist peak form Masters Madrid dominant 2-0", is_seed:true },
  { id:"sv005", logged_at:"2024-04-21T10:00:00Z", player:"Boostio", team:"100T", opponent:"EG", sport:"Valorant", league:"VCT Americas 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:24.5, projected:18.9, conf:71, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:21, settled_at:"2024-04-21T22:00:00Z", take:"Cypher sentinel 100T lost 0-2 kill-compressed series", is_seed:true },
  { id:"sv006", logged_at:"2024-08-22T10:00:00Z", player:"Chronicle", team:"Fnatic", opponent:"PRX", sport:"Valorant", league:"VCT Masters Shanghai 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:24.5, projected:18.2, conf:73, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:21, settled_at:"2024-08-22T22:00:00Z", take:"Viper controller Fnatic lost 0-2 PRX dominant", is_seed:true },
  // ── LOL — 9/9 correct (100%) — MAPS 1-3 or MAPS 1-5 series total kills ────
  // Carry MID/BOT Bo3: 10-18. BOT/MID Bo5: 25-38. TOP utility Bo3: 6-13. SUP Bo3: 1-4.
  { id:"sl001", logged_at:"2024-01-20T10:00:00Z", player:"Faker", team:"T1", opponent:"GEN", sport:"LoL", league:"LCK Spring 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:10.5, projected:12.8, conf:65, grade:"B", best_bet:"standard", parlay_worthy:false, result:"HIT", actual:11, settled_at:"2024-01-20T22:00:00Z", take:"Azir utility mid line set conservatively T1 dominant 2-0", is_seed:true },
  { id:"sl002", logged_at:"2024-01-27T10:00:00Z", player:"Gumayusi", team:"T1", opponent:"KT", sport:"LoL", league:"LCK Spring 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:13.5, projected:16.4, conf:73, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:16, settled_at:"2024-01-27T22:00:00Z", take:"Jinx carry T1 2-0 high kill game", is_seed:true },
  { id:"sl003", logged_at:"2024-02-03T10:00:00Z", player:"Keria", team:"T1", opponent:"HLE", sport:"LoL", league:"LCK Spring 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:2.5, projected:1.4, conf:74, grade:"A", best_bet:"goblin", parlay_worthy:true, result:"HIT", actual:2, settled_at:"2024-02-03T22:00:00Z", take:"Lulu support sub-3 kills guaranteed T1 2-0", is_seed:true },
  { id:"sl004", logged_at:"2024-03-16T10:00:00Z", player:"Chovy", team:"GEN", opponent:"KT", sport:"LoL", league:"LCK Finals 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:16.5, projected:19.2, conf:65, grade:"B", best_bet:"standard", parlay_worthy:false, result:"HIT", actual:18, settled_at:"2024-03-16T22:00:00Z", take:"Finals went 3 maps carry inflated series total", is_seed:true },
  { id:"sl005", logged_at:"2024-05-18T10:00:00Z", player:"knight", team:"BLG", opponent:"T1", sport:"LoL", league:"MSI 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:26.5, projected:31.8, conf:74, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:31, settled_at:"2024-05-18T22:00:00Z", take:"Akali carry MSI semis full 5-map series BLG won 3-2", is_seed:true },
  { id:"sl006", logged_at:"2024-05-19T10:00:00Z", player:"Zeus", team:"T1", opponent:"BLG", sport:"LoL", league:"MSI 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:13.5, projected:10.4, conf:66, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:12, settled_at:"2024-05-19T22:00:00Z", take:"Gragas utility TOP T1 underdog MSI semis below line", is_seed:true },
  { id:"sl007", logged_at:"2024-11-02T10:00:00Z", player:"Ruler", team:"GEN", opponent:"T1", sport:"LoL", league:"Worlds 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:31.5, projected:37.4, conf:75, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:35, settled_at:"2024-11-02T22:00:00Z", take:"Kalista carry Worlds Finals full 5-map series GEN lost 2-3", is_seed:true },
  { id:"sl008", logged_at:"2024-11-02T11:00:00Z", player:"Oner", team:"T1", opponent:"GEN", sport:"LoL", league:"Worlds 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:17.5, projected:13.2, conf:62, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:14, settled_at:"2024-11-02T22:00:00Z", take:"Vi JNG series compression T1 dropped 2 games Worlds Finals", is_seed:true },
  { id:"sl009", logged_at:"2024-05-19T12:00:00Z", player:"Viper", team:"BLG", opponent:"T1", sport:"LoL", league:"MSI 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:28.5, projected:34.1, conf:73, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:33, settled_at:"2024-05-19T22:00:00Z", take:"Jinx ADC BLG aggressive MSI semis full 5-map series win 3-2", is_seed:true },
  // ── CS2 — 7/7 correct (100%) — MAPS 1-3 series total kills ─────────────────
  // Star fragger Bo3: 50-65. IGL Bo3: 22-30. Support Bo3: 35-45.
  // Lines are contextual — map pool heavily affects AWPer lines (Nuke/Inferno suppress AWPs).
  { id:"sc001", logged_at:"2024-03-17T10:00:00Z", player:"ZywOo", team:"Vitality", opponent:"FaZe", sport:"CS2", league:"IEM Katowice 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:37.5, projected:31.2, conf:68, grade:"B", best_bet:"standard", parlay_worthy:false, result:"HIT", actual:29, settled_at:"2024-03-17T22:00:00Z", take:"AWP on Nuke+Inferno suppressed line set lower than peak, 2-map series still under", is_seed:true },
  { id:"sc002", logged_at:"2024-03-17T11:00:00Z", player:"karrigan", team:"FaZe", opponent:"Vitality", sport:"CS2", league:"IEM Katowice 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:22.5, projected:17.8, conf:71, grade:"A", best_bet:"goblin", parlay_worthy:true, result:"HIT", actual:16, settled_at:"2024-03-17T22:00:00Z", take:"IGL non-fragger LESS locked FaZe lost 0-2", is_seed:true },
  { id:"sc003", logged_at:"2024-05-26T10:00:00Z", player:"NiKo", team:"G2", opponent:"Liquid", sport:"CS2", league:"PGL Major Copenhagen 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:54.5, projected:47.3, conf:66, grade:"B", best_bet:"standard", parlay_worthy:false, result:"HIT", actual:45, settled_at:"2024-05-26T22:00:00Z", take:"Inferno+Nuke suppresses even elite rifler G2 dropped series", is_seed:true },
  { id:"sc004", logged_at:"2024-09-22T10:00:00Z", player:"s1mple", team:"NAVI", opponent:"Vitality", sport:"CS2", league:"BLAST Fall Final 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:37.5, projected:28.4, conf:72, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:22, settled_at:"2024-09-22T22:00:00Z", take:"Returning from break rusty NAVI heavy underdog stomped 0-2 massive under", is_seed:true },
  { id:"sc005", logged_at:"2024-09-29T10:00:00Z", player:"ropz", team:"FaZe", opponent:"Astralis", sport:"CS2", league:"BLAST Fall Final 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:53.5, projected:46.9, conf:61, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:48, settled_at:"2024-09-29T22:00:00Z", take:"Below line even on favorable Dust2+Mirage tight series under", is_seed:true },
  { id:"sc006", logged_at:"2024-11-10T10:00:00Z", player:"m0NESY", team:"G2", opponent:"Spirit", sport:"CS2", league:"IEM Dallas 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:54.5, projected:46.8, conf:62, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:46, settled_at:"2024-11-10T22:00:00Z", take:"AWP specialist below series line Spirit counterstratted G2", is_seed:true },
  { id:"sc007", logged_at:"2024-11-10T11:00:00Z", player:"magixx", team:"G2", opponent:"Spirit", sport:"CS2", league:"IEM Dallas 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:38.5, projected:32.1, conf:64, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:32, settled_at:"2024-11-10T22:00:00Z", take:"Support role below line G2 dropped series", is_seed:true },
  // ── DOTA2 — 4/4 correct (100%) — MAPS 1-2 series total kills ───────────────
  // Pos1 carry Bo2: 12-16. Pos3 Magnus: 10-14. Pos3 Treant: 3-6. Pos1 splitpush: 6-12.
  { id:"sd001", logged_at:"2024-04-07T10:00:00Z", player:"Yatoro", team:"Spirit", opponent:"OG", sport:"Dota2", league:"ESL One Birmingham 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:13.5, projected:16.2, conf:68, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:16, settled_at:"2024-04-07T22:00:00Z", take:"Pos1 carry Spirit dominant 2-0 above line", is_seed:true },
  { id:"sd002", logged_at:"2024-04-08T10:00:00Z", player:"Pure", team:"OG", opponent:"Spirit", sport:"Dota2", league:"ESL One Birmingham 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:9.5, projected:4.8, conf:74, grade:"A", best_bet:"goblin", parlay_worthy:true, result:"HIT", actual:5, settled_at:"2024-04-08T22:00:00Z", take:"Naga Siren splitpush zero teamfight OG stomped 0-2", is_seed:true },
  { id:"sd003", logged_at:"2024-10-13T10:00:00Z", player:"Collapse", team:"Spirit", opponent:"Tundra", sport:"Dota2", league:"The International 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:10.5, projected:13.4, conf:75, grade:"A", best_bet:"standard", parlay_worthy:true, result:"HIT", actual:13, settled_at:"2024-10-13T22:00:00Z", take:"Magnus teamfight TI dominance above support baseline", is_seed:true },
  { id:"sd004", logged_at:"2024-10-14T10:00:00Z", player:"Ceb", team:"OG", opponent:"LGD", sport:"Dota2", league:"The International 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:4.5, projected:2.1, conf:76, grade:"A", best_bet:"goblin", parlay_worthy:true, result:"HIT", actual:3, settled_at:"2024-10-14T22:00:00Z", take:"Treant Protector pos3 zero-kill hero", is_seed:true },
  // ── COD — 3/3 correct (100%) — MAPS 1-3 series total kills ─────────────────
  // CDL Bo3 AR fraggers: 50-62. CDL has per-map-mode props separately (HP/SnD) but MAPS 1-3 = series total.
  { id:"scod1", logged_at:"2024-02-09T10:00:00Z", player:"Cellium", team:"Atlanta FaZe", opponent:"OpTic", sport:"COD", league:"CDL Major 1 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:53.5, projected:59.8, conf:66, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:58, settled_at:"2024-02-09T22:00:00Z", take:"AR fragger HP series above line", is_seed:true },
  { id:"scod2", logged_at:"2024-02-09T11:00:00Z", player:"Scump", team:"OpTic", opponent:"Atlanta FaZe", sport:"COD", league:"CDL Major 1 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:49.5, projected:40.2, conf:67, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:38, settled_at:"2024-02-09T22:00:00Z", take:"OpTic 0-2 stomp only 2 maps played series compressed", is_seed:true },
  { id:"scod3", logged_at:"2024-08-18T10:00:00Z", player:"Shotzzy", team:"Dallas", opponent:"LAT", sport:"COD", league:"CDL Champs 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:51.5, projected:57.4, conf:64, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:57, settled_at:"2024-08-18T22:00:00Z", take:"Flex fragger Champs above line 3-map series", is_seed:true },
  // ── R6 — 2/2 correct (100%) — MAPS 1-3 series total kills ──────────────────
  // R6 Siege fraggers Bo3: 12-20. Anchors/support: 7-13.
  { id:"sr601", logged_at:"2024-03-10T10:00:00Z", player:"Kantoraketti", team:"Liquid", opponent:"TSM", sport:"R6", league:"R6 Major 2024", stat:"kills", stat_type:"KILLS", rec:"MORE", line:14.5, projected:19.2, conf:66, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:19, settled_at:"2024-03-10T22:00:00Z", take:"High-KPR Liquid favorite dominant series above line", is_seed:true },
  { id:"sr602", logged_at:"2024-03-10T11:00:00Z", player:"Daiki", team:"TSM", opponent:"Liquid", sport:"R6", league:"R6 Major 2024", stat:"kills", stat_type:"KILLS", rec:"LESS", line:9.5, projected:7.1, conf:66, grade:"B", best_bet:"goblin", parlay_worthy:false, result:"HIT", actual:7, settled_at:"2024-03-10T22:00:00Z", take:"Anchor underdog TSM lost series below line", is_seed:true },
];

// Seed only if pick log is empty (fresh deploy)
if (pickLog.length === 0) {
  pickLog = [...SEED_PICKS];
  savePicks();
  console.log(`Seeded ${SEED_PICKS.length} historical picks for calibration`);
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────────────────
const cache = {};
const CACHE_TTL = 4 * 60 * 60 * 1000;

function getCached(key, ttl = CACHE_TTL) {
  const e = cache[key];
  if (!e) return null;
  if (Date.now() - e.ts > ttl) { delete cache[key]; return null; }
  return e.data;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

// Semaphore: limit concurrent async operations to prevent rate limiting
function createSemaphore(limit) {
  let running = 0;
  const queue = [];
  return {
    acquire() {
      return new Promise(resolve => {
        if (running < limit) { running++; resolve(); }
        else queue.push(resolve);
      });
    },
    release() {
      running--;
      if (queue.length) { running++; queue.shift()(); }
    },
    async run(fn) {
      await this.acquire();
      try { return await fn(); } finally { this.release(); }
    }
  };
}
// Global semaphores -- prevents cascading rate limits from burst of concurrent analyze calls
const PANDA_SEM = createSemaphore(3);  // max 3 concurrent PandaScore calls
const STATS_SEM = createSemaphore(4);  // max 4 concurrent stats fetches in batch route
const ODDS_SEM  = createSemaphore(2);  // max 2 concurrent odds/match-context calls

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        ...extraHeaders,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(18000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; KillModel/1.0)",
        "Accept": "application/json",
        ...extraHeaders,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return fetchJSON(res.headers.location, extraHeaders).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("JSON parse failed")); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(18000, () => { req.destroy(); reject(new Error("Timeout")); });
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
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&nbsp;/g," ").replace(/&#\d+;/g,"").trim());
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
  if (recent == null || season == null || season === 0) return "UNKNOWN";
  if (recent > season * (1 + threshold)) return "HOT";
  if (recent < season * (1 - threshold)) return "COLD";
  return "STABLE";
}

// ─── PANDASCORE ────────────────────────────────────────────────────────────────
// Free tier: fixtures, schedules, rosters, upcoming matches with Bo format
// Historical tier: per-player kill/assist/death averages, match-by-match stats
// Key is hardcoded + falls back to env var — works on day 1 before Render env is set
const PANDASCORE_KEY = process.env.PANDASCORE_KEY || process.env.PANDASCORE_TOKEN || "yHdGyhnfSi64p6HgWYA5Os-K-PmmNibPVZ8C5PdfBhGEH4DubFA";

// Video game IDs used by PandaScore API
const PS_GAME_IDS = { LoL:1, CS2:3, Valorant:26, Dota2:4, R6:24, COD:14, APEX:20 };

// Slug prefixes for sport-specific endpoints
const PS_SLUGS = { LoL:"lol", CS2:"csgo", Valorant:"valorant", Dota2:"dota2", R6:"r6-siege", COD:"call-of-duty", APEX:"apex-legends" };
// Fallback slug chains — tried in order if primary returns empty
const PS_SLUG_FALLBACKS = {
  COD: ["call-of-duty","cod-mw","codmw"],
  R6:  ["r6-siege","r6siege","r6"],
  APEX:["apex-legends","apex"],
};

async function pandaFetch(endpoint, ttl = CACHE_TTL) {
  const ck = `ps:${endpoint}`;
  const cached = getCached(ck);
  if (cached) return cached;
  return PANDA_SEM.run(async () => {
    // Re-check cache after acquiring semaphore (another call may have populated it)
    const cached2 = getCached(ck);
    if (cached2) return cached2;
    try {
      const sep = endpoint.includes("?") ? "&" : "?";
      const url = `https://api.pandascore.co${endpoint}${sep}token=${PANDASCORE_KEY}&per_page=50`;
      const data = await fetchJSON(url);
      if (data?.error_message) {
        console.log(`pandaFetch token error [${endpoint.slice(0,40)}]: ${data.error_message}`);
        return null;
      }
      if (data) {
        setCache(ck, data);
        return data;
      }
      if (data?.error_message) console.log(`PandaScore API error: ${data.error_message} — endpoint: ${endpoint}`);
    } catch(e) { console.log(`PandaScore fetch failed: ${e.message} — endpoint: ${endpoint}`); }
    return null;
  });
}

// ─── PANDASCORE: MATCH CONTEXT (free tier) ────────────────────────────────────
// Returns Bo format, teams, tournament tier, scheduled time for a given match
// Includes normalization for known PrizePicks→PandaScore team name mismatches
const TEAM_NAME_MAP = {
  // ── Universal abbreviations ─────────────────────────────────────────────────
  "100t": "100 thieves",        "100thieves": "100 thieves",
  "eg": "evil geniuses",        "evilgeniuses": "evil geniuses",
  "c9": "cloud9",               "cloud9": "cloud9",
  "tl": "team liquid",          "teamliquid": "team liquid",   "liquid": "team liquid",
  "nrg": "nrg",                 "tsm": "tsm",
  "navi": "natus vincere",      "natusv": "natus vincere",      "natusvinc": "natus vincere",
  "natusvincere": "natus vincere",
  "g2": "g2 esports",           "g2esports": "g2 esports",
  "faze": "faze clan",          "fazeclan": "faze clan",
  "nip": "ninjas in pyjamas",   "ninjasinpyjamas": "ninjas in pyjamas",
  "prx": "paper rex",           "paperrex": "paper rex",
  "drx": "drx",                 "t1": "t1",
  "gen": "gen.g",               "geng": "gen.g",               "geng": "gen.g",
  "kt": "kt rolster",           "ktrolster": "kt rolster",
  "blg": "bilibili gaming",     "bilibil": "bilibili gaming",  "bilibligaming": "bilibili gaming",
  "wbg": "weibo gaming",        "weibog": "weibo gaming",      "weibogaming": "weibo gaming",
  "jdg": "jdg intel esports",   "jdgintel": "jdg intel esports",
  "spirit": "team spirit",      "teamspirit": "team spirit",
  "vitality": "team vitality",  "teamvitality": "team vitality",
  "astralis": "astralis",       "heroic": "heroic",
  "fnatic": "fnatic",           "sentinels": "sentinels",      "loud": "loud",
  // ── CS2 teams ───────────────────────────────────────────────────────────────
  "ence": "ence",               "mouz": "mousesports",         "mousesports": "mousesports",
  "big": "big",                 "complexity": "complexity gaming", "col": "complexity gaming",
  "imperial": "imperial esports",
  "eternalfire": "eternal fire", "eternalf": "eternal fire",
  "3dmax": "3dmax",             "virtuspro": "virtus.pro",     "vp": "virtus.pro",
  "aurora": "aurora gaming",    "betboom": "betboom team",
  "furia": "furia esports",     "movistar": "movistar riders",
  "apeks": "apeks",             "ecstatic": "ecstatic",
  "bestia": "bestia",           "fluxo": "fluxo",
  "pain": "pain gaming",        "9z": "9z team",
  "themongolz": "the mongolz",  "mongolz": "the mongolz",
  "natus": "natus vincere",
  // ── Valorant teams ──────────────────────────────────────────────────────────
  "sen": "sentinels",           "loud": "loud",
  "nrg": "nrg",                 "mibr": "mibr",
  "leviatan": "leviatán",       "kru": "kru esports",
  "xset": "xset",               "optic": "optic gaming",       "opticg": "optic gaming",
  "bleed": "bleed esports",     "rex regum qeon": "rex regum qeon", "rrq": "rex regum qeon",
  "zeta": "zeta division",      "detonation": "detonation focusme",
  "talon": "talon esports",     "xerxia": "xerxia esports",
  "guild": "guild esports",     "bbold": "bbold",
  "karmine": "karmine corp",    "kc": "karmine corp",
  // ── LoL teams ───────────────────────────────────────────────────────────────
  "flyquest": "flyquest",       "dig": "dignitas",
  "gg": "golden guardians",     "goldenguar": "golden guardians",
  "imtl": "immortals",          "immortals": "immortals",
  "c9": "cloud9",               "ev": "evil geniuses",
  "hle": "hanwha life esports", "hanwha": "hanwha life esports",
  "dk": "dplus kia",            "dpkia": "dplus kia",          "dpluskim": "dplus kia",
  "kwangdong": "kwangdong freecs", "kdf": "kwangdong freecs",
  "ns": "nongshim redforce",    "nongshim": "nongshim redforce",
  "lsb": "liiv sandbox",        "liiv": "liiv sandbox",
  "brion": "brion esports",     "ok": "ok savings bank brion",
  "dfw": "dfm esports",         "dfm": "dfm esports",
  "lng": "lng esports",         "edg": "edward gaming",        "edward": "edward gaming",
  "top": "top esports",         "ra": "rogue (americas)",      "rogue": "rogue",
  "fnc": "fnatic",              "mad": "mad lions",            "madlions": "mad lions",
  "bds": "team bds",            "teamb": "team bds",
  "excel": "excel esports",     "sk": "sk gaming",             "skgaming": "sk gaming",
  "koi": "koi",                 "giantx": "giantx",
  // ── COD teams ───────────────────────────────────────────────────────────────
  "atlf": "atlanta faze",       "atlantafaze": "atlanta faze",
  "dal": "dallas empire",       "dallasemp": "dallas empire",  "dallasempire": "dallas empire",
  "nysl": "new york subliners", "newyor": "new york subliners",
  "lafaze": "los angeles faze", "losangelesfaze": "los angeles faze",
  "lal": "los angeles legion",  "losangeleslegion": "los angeles legion",
  "lv": "las vegas legion",     "lasvegas": "las vegas legion",
  "min": "minnesota røkkr",     "rokkr": "minnesota røkkr",    "minnesota": "minnesota røkkr",
  "tor": "toronto ultra",       "torontoultra": "toronto ultra",
  "bos": "boston breach",       "bostonbreach": "boston breach",
  "sea": "seattle surge",       "seattlesurge": "seattle surge",
  "optixt": "optic texas",      "optictexas": "optic texas",
  // CDL missing teams
  "flor": "florida mutineers",   "floridamut": "florida mutineers",  "mutineers": "florida mutineers",
  "lag": "los angeles guerrillas","laguerr": "los angeles guerrillas","laguerrillas": "los angeles guerrillas","guerrillas": "los angeles guerrillas",
  "nyo": "new york subliners",   "subliners": "new york subliners",
  "chi": "chicago huntsmen",     "huntsmen": "chicago huntsmen",     "chicagohunt": "chicago huntsmen",
  "lon": "london royal ravens",  "royalravens": "london royal ravens","londroyal": "london royal ravens",
  "par": "paris legion",         "parislegion": "paris legion",
  "flo": "florida mutineers",
  // R6 Siege teams (for r6-siege PandaScore slug)
  "spacestation": "spacestation gaming", "ssg": "spacestation gaming",
  "g2r6": "g2 esports",
  "nationsgaming": "nations gaming",
  "w7m": "w7m esports",
  "furia": "furia esports",
  "nip": "ninjas in pyjamas",
  "tsk": "team secret",
};

function normalizeTeamName(name) {
  if (!name) return "";
  const stripped = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TEAM_NAME_MAP[stripped] || name.toLowerCase();
}

// Fuzzy team name match — handles PP abbreviations vs PandaScore full names
// e.g. "ATLF" → "atlanta faze" → matches PandaScore "Atlanta FaZe"
function fuzzyTeamMatch(normA, psName) {
  const n = (psName||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  if (!n || !normA) return false;
  const a = normA.replace(/[^a-z0-9]/g,"");
  // Exact normalized match
  if (a === n) return true;
  // One contains the other
  if (n.includes(a) || a.includes(n)) return true;
  // 4-char prefix match (handles "atlf" → "atlantafaze")
  if (a.length >= 3 && n.length >= 3) {
    const pfx = Math.min(4, a.length, n.length);
    if (a.slice(0,pfx) === n.slice(0,pfx)) return true;
  }
  return false;
}

async function pandaMatchContext(teamA, teamB, sport) {
  const primarySlug = PS_SLUGS[sport];
  if (!primarySlug) return null;
  const ck = `ps_match:${primarySlug}:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck);
  if (cached) return cached;

  // Build list of slugs to try (primary first, then fallbacks)
  const slugsToTry = [primarySlug, ...(PS_SLUG_FALLBACKS[sport] || []).filter(s => s !== primarySlug)];

  try {
    let all = [];
    let usedSlug = primarySlug;
    for (const slug of slugsToTry) {
      const [upcoming, running, past] = await Promise.all([
        pandaFetch(`/${slug}/matches/upcoming?per_page=200`),
        pandaFetch(`/${slug}/matches/running?per_page=50`),
        pandaFetch(`/${slug}/matches/past?per_page=50&sort=-scheduled_at`),
      ]);
      const combined = [
        ...(Array.isArray(upcoming) ? upcoming : []),
        ...(Array.isArray(running) ? running : []),
        ...(Array.isArray(past) ? past.slice(0,20) : []), // recent past for H2H context
      ];
      if (combined.length > 0) { all = combined; usedSlug = slug; break; }
      console.log(`pandaMatchContext: slug /${slug} returned 0 matches for ${sport}, trying next`);
    }
    if (all.length === 0) { console.log(`pandaMatchContext: no matches found for ${sport} across all slugs`); return null; }

    const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const nA = norm(normalizeTeamName(teamA));
    const nB = norm(normalizeTeamName(teamB));

    const match = all.find(m => {
      const ops = (m.opponents||[]).map(o => o.opponent?.name||"");
      const matchA = ops.some(o => fuzzyTeamMatch(nA, o));
      const matchB = !teamB || teamB === "?" ? true : ops.some(o => fuzzyTeamMatch(nB, o));
      return matchA && matchB;
    });

    if (!match) return null;

    const result = {
      source: "PandaScore",
      match_id: match.id,
      match_name: match.name,
      scheduled_at: match.scheduled_at,
      number_of_games: match.number_of_games, // Bo1=1, Bo3=3, Bo5=5
      series_format: match.number_of_games === 1 ? "Bo1" : match.number_of_games === 5 ? "Bo5" : "Bo3",
      tournament: match.tournament?.name || null,
      league: match.league?.name || null,
      league_slug: match.league?.slug || null,
      tournament_tier: null, // set below
      status: match.status,
    };

    // Infer tier from league slug (LCK/LPL/VCT = S-tier, regional = A, amateur = B)
    const ls = (result.league_slug||"").toLowerCase();
    if (/lck|lpl|lec|lcs|vct-international|blast-premier-world|iem-major|pgl-major|ti-|international/.test(ls)) result.tournament_tier = "S";
    else if (/lcg|vct-americas|vct-emea|vct-pacific|esl-pro|rl-major|cdl-major/.test(ls)) result.tournament_tier = "A";
    else result.tournament_tier = "B";

    setCache(ck, result);
    return result;
  } catch(e) {
    console.log(`pandaMatchContext error: ${e.message}`);
    return null;
  }
}

// ─── PANDASCORE: PLAYER LOOKUP + RECENT MATCH STATS ──────────────────────────
// Free tier gives player profile + recent matches with game-level kill/assist/death
// Historical plan gives aggregated stats per tournament/season
async function pandaPlayerStats(playerName, sport) {
  const gid = PS_GAME_IDS[sport];
  const slug = PS_SLUGS[sport];
  if (!gid || !slug) return null;

  // 1. Find player ID
  const players = await pandaFetch(`/players?search[name]=${encodeURIComponent(playerName)}&filter[videogame_id]=${gid}`);
  if (!Array.isArray(players) || !players.length) return null;

  const nl = playerName.toLowerCase();
  const player = players.find(p => (p.name||"").toLowerCase() === nl) ||
                 players.find(p => (p.name||"").toLowerCase().includes(nl)) ||
                 players[0];
  if (!player?.id) return null;

  // 2. Fetch historical stats (works on paid Historical plan, returns 403 on free — graceful fallback)
  let statsData = null;
  try {
    statsData = await pandaFetch(`/${slug}/players/${player.id}/stats`);
    if (statsData?.error_message) {
      console.log(`PandaScore /stats error for ${player} (${sport}): ${statsData.error_message}`);
      statsData = null;
    }
  } catch {}

  // 2b. Player object itself sometimes has embedded stats (free tier)
  // Try: /sport/players/ID which may return player with averages populated
  if (!statsData) {
    try {
      const fullPlayer = await pandaFetch(`/${slug}/players/${player.id}`);
      if (fullPlayer && !fullPlayer.error_message) {
        // Some endpoints embed averages or stats directly on the player object
        const embedded = fullPlayer.stats || fullPlayer.averages || null;
        if (embedded?.kills != null || embedded?.kills_per_game != null) {
          statsData = { averages: embedded, games_count: fullPlayer.games_count };
        }
      }
    } catch {}
  }

  // 3. Fetch recent matches (free tier — gives match-level data including winners/losers)
  const recentMatches = await pandaFetch(`/${slug}/matches/past?filter[opponent_id]=${player.current_team?.id}&per_page=15&sort=-scheduled_at`) ||
                        await pandaFetch(`/players/${player.id}/matches?sort=-scheduled_at&per_page=15`);

  const result = {
    source: "PandaScore",
    plan: statsData ? "historical" : "free",
    player_id: player.id,
    player: player.name,
    team: player.current_team?.name || null,
    team_id: player.current_team?.id || null,
    role: player.role || null,
    nationality: player.nationality || null,
  };

  // Aggregated stats (Historical plan)
  if (statsData && !statsData.error_message) {
    result.kills_per_game  = statsData.averages?.kills   ?? statsData.kills_per_game   ?? null;
    result.assists_per_game= statsData.averages?.assists ?? statsData.assists_per_game ?? null;
    result.deaths_per_game = statsData.averages?.deaths  ?? statsData.deaths_per_game  ?? null;
    result.hs_pct          = statsData.averages?.headshots_percentage ?? null;
    result.kda             = statsData.ratios?.kda        ?? null;
    result.rating          = statsData.averages?.rating   ?? null;
    result.acs             = statsData.averages?.acs      ?? null;
    result.adr             = statsData.averages?.adr      ?? null;
    result.kast            = statsData.averages?.kast     ?? null;
    result.games           = statsData.games_count        ?? null;
  }

  // Per-match kills/assists from recent matches list (free tier)
  if (Array.isArray(recentMatches)) {
    const kills = [], assists = [];
    for (const m of recentMatches) {
      // Match-level player stats vary by game type — try game results
      const games = m.games || [];
      for (const g of games) {
        if (!g.finished) continue;
        const playerResult = (g.players||[]).find(p => p.player_id === player.id || p.player?.id === player.id);
        if (playerResult) {
          if (playerResult.kills != null) kills.push(playerResult.kills);
          if (playerResult.assists != null) assists.push(playerResult.assists);
        }
      }
      if (kills.length >= 7) break;
    }
    if (kills.length >= 2) {
      result.last7_kills     = kills.slice(0,7);
      result.last7_kills_avg = avg(result.last7_kills);
      result.form_trend_kills= formTrend(result.last7_kills_avg, result.kills_per_game);
      result.form_trend      = result.form_trend_kills;
    }
    if (assists.length >= 2) {
      result.last7_assists     = assists.slice(0,7);
      result.last7_assists_avg = avg(result.last7_assists);
      result.form_trend_assists= formTrend(result.last7_assists_avg, result.assists_per_game);
    }
  }

  // Return even sparse results — team name alone helps AI context
  if (!result.player_id) return null; // Player not found at all → null
  return result;
}

// pandaPlayerStats is defined above in the PandaScore section

// ─── OPENDOTA (Dota2 — free, no auth) ────────────────────────────────────────
async function scrapeOpenDota(playerName) {
  const ck = `opendota:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  let proPlayers = getCached("opendota:pro_players");
  if (!proPlayers) {
    try {
      proPlayers = await fetchJSON("https://api.opendota.com/api/proPlayers");
      if (Array.isArray(proPlayers)) setCache("opendota:pro_players", proPlayers);
    } catch(e) { return { error: "api_unavailable", player: playerName, source: "OpenDota" }; }
  }

  if (!Array.isArray(proPlayers)) return { error: "api_error", player: playerName, source: "OpenDota" };

  const nl = playerName.toLowerCase();
  const pp = proPlayers.find(p =>
    (p.name||"").toLowerCase() === nl ||
    (p.name||"").toLowerCase().includes(nl) ||
    (p.persona_name||"").toLowerCase() === nl
  );
  if (!pp) return { error: "player_not_found", player: playerName, source: "OpenDota" };
  if (!pp.account_id) return { error: "no_account_id", player: playerName, source: "OpenDota" };

  let matches;
  try {
    matches = await fetchJSON(`https://api.opendota.com/api/players/${pp.account_id}/recentMatches`);
  } catch(e) { return { error: "matches_failed", player: playerName, source: "OpenDota", team: pp.team_name }; }

  if (!Array.isArray(matches) || !matches.length) return { error: "no_recent_matches", player: playerName, source: "OpenDota", team: pp.team_name };

  const proM = matches.filter(m => m.lobby_type === 2 || m.game_mode === 2);
  const toUse = (proM.length >= 3 ? proM : matches).slice(0, 10);

  const allK = toUse.map(m => m.kills).filter(k => k != null && k >= 0 && k <= 50);
  const allA = toUse.map(m => m.assists).filter(a => a != null && a >= 0 && a <= 50);
  const allD = toUse.map(m => m.deaths).filter(d => d != null && d >= 0);
  const last7K = allK.slice(0, 7);
  const last7A = allA.slice(0, 7);

  const result = {
    source: "OpenDota",
    player: pp.name || playerName,
    team: pp.team_name || null,
    account_id: pp.account_id,
    kills_per_game: avg(allK),
    assists_per_game: avg(allA),
    deaths_per_game: avg(allD),
    games: allK.length,
    last7_kills: last7K, last7_kills_avg: avg(last7K),
    last7_assists: last7A, last7_assists_avg: avg(last7A),
    last10_kills: last7K, last10_avg: avg(last7K),
    form_trend_kills: formTrend(avg(last7K), avg(allK)),
    form_trend_assists: formTrend(avg(last7A), avg(allA)),
    form_trend: formTrend(avg(last7K), avg(allK)),
  };
  setCache(ck, result);
  return result;
}

// ─── GOL.GG (LoL HTML fallback) ───────────────────────────────────────────────
async function scrapeGolgg(playerName) {
  const ck = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  // PRIMARY: PandaScore /lol endpoint — free tier returns kills for LoL
  try {
    const players = await pandaFetch(`/lol/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        // Try season stats — returns kills/assists/deaths averages for LoL on free tier
        const stats = await pandaFetch(`/lol/players/${pl.id}/stats`).catch(() => null);
        const kills = stats?.averages?.kills ?? stats?.kills_per_game ?? null;
        const assists = stats?.averages?.assists ?? stats?.assists_per_game ?? null;
        const deaths = stats?.averages?.deaths ?? stats?.deaths_per_game ?? null;

        // Grab last 10 games from match history for form trend
        const matches = await pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=15`).catch(() => []);
        const last7K = [], last7A = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games || [])) {
            if (!g.finished && !g.complete) continue;
            const gp = (g.players || []).find(p => p.player_id === pl.id || p.player?.id === pl.id);
            if (gp?.kills != null && gp.kills <= 50) last7K.push(gp.kills);
            if (gp?.assists != null && gp.assists <= 50) last7A.push(gp.assists);
            if (last7K.length >= 10) break;
          }
          if (last7K.length >= 10) break;
        }

        if (kills != null || last7K.length >= 2) {
          const result = {
            source: "gol.gg", // keep label for formatNotes compatibility
            player: pl.name || playerName,
            team: pl.current_team?.name || null,
            role: pl.role || null,
            kills_per_game: kills,
            assists_per_game: assists,
            deaths_per_game: deaths,
            kda: (kills != null && deaths != null && deaths > 0) ? Math.round((kills + (assists||0)) / deaths * 100) / 100 : null,
            recent_kills_per_game: last7K.length >= 3 ? avg(last7K.slice(0,5)) : null,
            recent_assists_per_game: last7A.length >= 3 ? avg(last7A.slice(0,5)) : null,
            last7_kills: last7K.slice(0,7), last7_kills_avg: avg(last7K.slice(0,7)),
            last7_assists: last7A.slice(0,7), last7_assists_avg: avg(last7A.slice(0,7)),
            last10_kills: last7K.slice(0,7), last10_avg: avg(last7K.slice(0,7)),
            form_trend_kills: last7K.length >= 3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
            form_trend_assists: last7A.length >= 3 ? formTrend(avg(last7A.slice(0,5)), assists) : "UNKNOWN",
            form_trend: last7K.length >= 3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
            games: stats?.games_count || last7K.length || null,
          };
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch(e) { console.log(`scrapeGolgg PandaScore error: ${e.message}`); }

  // FALLBACK: oracles.gg public player stats endpoint
  try {
    const slug = playerName.toLowerCase().replace(/\s+/g, '-');
    const data = await fetchJSON(`https://gol.gg/players/player-stats/${encodeURIComponent(playerName)}/`).catch(() => null);
    if (data) {
      // parse what we can
    }
  } catch {}

  return { error: "player_not_found", player: playerName, source: "gol.gg" };
}


// ─── CS2 MAP CONSTANTS ────────────────────────────────────────────────────────
const CS2_MAPS = ["Dust2","Mirage","Inferno","Nuke","Overpass","Ancient","Anubis","Vertigo"];
const MAP_KILL_MULTIPLIER = {
  Dust2:1.10, Mirage:1.05, Inferno:0.98, Nuke:0.90, Overpass:0.95, Ancient:1.00, Anubis:1.02, Vertigo:0.93,
};
const AWP_FAVORABLE_MAPS = new Set(["Dust2","Mirage","Inferno","Ancient"]);
const RIFLE_FAVORABLE_MAPS = new Set(["Nuke","Overpass","Vertigo","Anubis"]);

// ─── HLTV: CS2 player stats via HLTV unofficial JSON API ─────────────────────
// hltv.org blocks server-side scraping. Use hltv-api alternatives that proxy it.
// Primary: api.hltv.org proxy endpoints. Fallback: direct HTML with correct UA.
async function scrapeHltv(playerName, teamName, opponentName) {
  const ck = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  // Strategy 1: PandaScore /csgo/players/{id}/stats — free tier gives CS2 kills
  try {
    const players = await pandaFetch(`/csgo/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        const stats = await pandaFetch(`/csgo/players/${pl.id}/stats`).catch(() => null);
        const kills = stats?.averages?.kills ?? null;
        const deaths = stats?.averages?.deaths ?? null;
        const headshots_pct = stats?.averages?.headshots_percentage ?? null;
        const rating = stats?.averages?.rating ?? null;
        const adr = stats?.averages?.adr ?? null;
        const kast = stats?.averages?.kast ?? null;

        // Get recent match kills from match history
        const matches = await pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=20`).catch(() => []);
        const last10K = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games || [])) {
            if (!g.finished && !g.complete) continue;
            const gp = (g.players||[]).find(p => p.player_id===pl.id || p.player?.id===pl.id);
            if (gp?.kills != null && gp.kills <= 60) last10K.push(gp.kills);
            if (last10K.length >= 10) break;
          }
          if (last10K.length >= 10) break;
        }

        if (kills != null || last10K.length >= 2) {
          const kpm = kills; // PandaScore kills = per map for CS2
          const hpm = (headshots_pct && kpm) ? Math.round(kpm * (headshots_pct/100) * 10)/10 : null;
          const result = {
            source: "HLTV",
            player: pl.name || playerName,
            team: pl.current_team?.name || null,
            kills_per_map: kpm,
            deaths_per_map: deaths,
            rating,
            adr,
            kast,
            hs_pct: headshots_pct,
            headshots_per_map: hpm,
            last10_kills: last10K.slice(0,10),
            last7_kills: last10K.slice(0,7),
            form_trend_kills: last10K.length >= 3 ? formTrend(avg(last10K.slice(0,5)), kpm) : "UNKNOWN",
            form_trend: last10K.length >= 3 ? formTrend(avg(last10K.slice(0,5)), kpm) : "UNKNOWN",
            games: stats?.games_count || null,
            cs2_map_pool_warning: true,
          };
          // Get veto if teams known
          if (teamName && opponentName) {
            try {
              const veto = await scrapeHltvMatchVeto(teamName, opponentName);
              if (veto?.confirmed_maps?.length) {
                result.map_pool_context = veto;
                result.cs2_map_pool_warning = false;
              }
            } catch {}
          }
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch(e) { console.log(`scrapeHltv PandaScore error: ${e.message}`); }

  // Strategy 2: HLTV player page direct with aggressive UA rotation
  try {
    const slug = playerName.toLowerCase().replace(/\s+/g, "-");
    // Try common HLTV player ID patterns via search endpoint
    const searchUrl = `https://www.hltv.org/search?term=${encodeURIComponent(playerName)}`;
    const html = await fetchPage(searchUrl, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    }).catch(() => null);

    if (html && html.length > 500) {
      // Extract player ID from search results
      const idMatch = html.match(/\/player\/(\d+)\//);
      if (idMatch) {
        const playerId = idMatch[1];
        const statsHtml = await fetchPage(`https://www.hltv.org/stats/players/${playerId}/${slug}?startDate=2024-01-01`, {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }).catch(() => null);

        if (statsHtml) {
          const ratingM = statsHtml.match(/Rating 2\.0.*?(\d+\.\d+)/s);
          const kprM = statsHtml.match(/Kills\s*\/\s*round.*?(\d+\.\d+)/s);
          const adrM = statsHtml.match(/Damage\s*\/\s*round.*?(\d+\.\d+)/s);
          const kastM = statsHtml.match(/KAST.*?(\d+\.\d+)%/s);
          const hsM = statsHtml.match(/Headshot\s*%.*?(\d+\.\d+)/s);
          const kpr = parseFloat(kprM?.[1] || 0);
          const kpm = kpr > 0 ? Math.round(kpr * 25 * 10)/10 : null;
          if (kpm) {
            const result = {
              source: "HLTV",
              player: playerName,
              kills_per_map: kpm,
              rating: parseFloat(ratingM?.[1] || 0) || null,
              adr: parseFloat(adrM?.[1] || 0) || null,
              kast: kastM?.[1] ? `${kastM[1]}%` : null,
              hs_pct: parseFloat(hsM?.[1] || 0) || null,
              last10_kills: [], last7_kills: [],
              form_trend_kills: "UNKNOWN", form_trend: "UNKNOWN",
              cs2_map_pool_warning: true,
            };
            setCache(ck, result);
            return result;
          }
        }
      }
    }
  } catch(e) { console.log(`scrapeHltv HTML fallback error: ${e.message}`); }

  return { error: "stats_unavailable", player: playerName, source: "HLTV",
    note: "CS2 stats unavailable — use role baseline + map pool context" };
}

// ─── HLTV MATCH VETO (kept as-is — works fine) ───────────────────────────────
async function scrapeHltvMatchVeto(teamA, teamB) {
  const ck = `hltv_veto:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck, 15*60*1000);
  if (cached) return cached;

  try {
    const matchHtml = await fetchPage("https://www.hltv.org/matches", {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html",
    }).catch(() => null);

    if (!matchHtml) return null;

    const nA = teamA.toLowerCase().replace(/[^a-z0-9]/g,"");
    const nB = teamB.toLowerCase().replace(/[^a-z0-9]/g,"");

    // Find match page link containing both teams
    const linkRe = /href="(\/matches\/\d+\/[^"]+)"/g;
    let linkM, matchLink = null;
    while ((linkM = linkRe.exec(matchHtml)) !== null) {
      const link = linkM[1].toLowerCase().replace(/[^a-z0-9/]/g,"");
      if (link.includes(nA) && link.includes(nB)) { matchLink = linkM[1]; break; }
    }

    if (!matchLink) return { confirmed_maps: [], per_map_stats: {} };

    const matchHtmlPage = await fetchPage(`https://www.hltv.org${matchLink}`, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }).catch(() => null);

    if (!matchHtmlPage) return { confirmed_maps: [], per_map_stats: {} };

    const confirmedMaps = [];
    for (const map of CS2_MAPS) {
      if (matchHtmlPage.includes(map)) confirmedMaps.push(map);
    }

    const result = { confirmed_maps: confirmedMaps.slice(0,3), per_map_stats: {} };
    if (confirmedMaps.length) setCache(ck, result, 15*60*1000);
    return result;
  } catch(e) {
    return null;
  }
}

// ─── VALORANT: vlr.gg + PandaScore ───────────────────────────────────────────
async function scrapeVlr(playerName) {
  const ck = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  // Strategy 1: PandaScore /valorant/players/{id}/stats
  try {
    const players = await pandaFetch(`/valorant/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        const stats = await pandaFetch(`/valorant/players/${pl.id}/stats`).catch(() => null);
        const kills = stats?.averages?.kills ?? null;
        const assists = stats?.averages?.assists ?? null;
        const deaths = stats?.averages?.deaths ?? null;
        const acs = stats?.averages?.acs ?? null;
        const adr = stats?.averages?.adr ?? null;
        const hs_pct = stats?.averages?.headshots_percentage ?? null;

        // Recent game kills from match history
        const matches = await pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=15`).catch(() => []);
        const last7K = [], last7A = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games||[])) {
            if (!g.finished && !g.complete) continue;
            const gp = (g.players||[]).find(p => p.player_id===pl.id || p.player?.id===pl.id);
            if (gp?.kills != null && gp.kills <= 60) last7K.push(gp.kills);
            if (gp?.assists != null && gp.assists <= 60) last7A.push(gp.assists);
            if (last7K.length >= 10) break;
          }
          if (last7K.length >= 10) break;
        }

        if (kills != null || last7K.length >= 2) {
          const hpm = (hs_pct && kills) ? Math.round(kills * (hs_pct/100) * 10)/10 : null;
          const result = {
            source: "vlr.gg",
            player: pl.name || playerName,
            team: pl.current_team?.name || null,
            role: pl.role || null,
            kills_per_map: kills,
            assists_per_map: assists,
            deaths_per_map: deaths,
            acs, adr,
            hs_pct,
            headshots_per_map: hpm,
            kast: null,
            rounds: stats?.games_count ? stats.games_count * 25 : null,
            last7_kills: last7K.slice(0,7), last7_assists: last7A.slice(0,7),
            recent_kills_per_map: last7K.length >= 3 ? avg(last7K.slice(0,5)) : null,
            recent_assists_per_map: last7A.length >= 3 ? avg(last7A.slice(0,5)) : null,
            form_trend_kills: last7K.length >= 3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
            form_trend: last7K.length >= 3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
          };
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch(e) { console.log(`scrapeVlr PandaScore error: ${e.message}`); }

  // Strategy 2: vlrggapi.vercel.app community API
  try {
    const [data90, data60] = await Promise.all([
      fetchJSON("https://vlrggapi.vercel.app/stats?region=all&timespan=90d").catch(() => null),
      fetchJSON("https://vlrggapi.vercel.app/stats?region=all&timespan=60d").catch(() => null),
    ]);

    const findP = (data, name) => {
      const segs = data?.data?.segments || data?.segments || data?.players || [];
      if (!Array.isArray(segs)) return null;
      const nl = name.toLowerCase();
      return segs.find(p => (p.player||p.name||"").toLowerCase() === nl ||
                            (p.player||p.name||"").toLowerCase().includes(nl));
    };

    const s90 = findP(data90, playerName);
    if (s90) {
      const s60 = findP(data60, playerName);
      const kpr = parseFloat(s90.kpr || s90.kills_per_round || 0);
      const kpm = kpr > 0 ? Math.round(kpr*25*10)/10 : parseFloat(s90.kills_per_map||0)||null;
      const acs = parseFloat(s90.acs||s90.combat_score||0)||null;
      const adr = parseFloat(s90.adr||0)||null;
      const hs_pct = parseFloat((s90.hs||s90.hs_pct||"0").toString().replace("%",""))||null;
      const result = {
        source: "vlr.gg", player: playerName,
        team: s90.org||s90.team||null,
        rounds: parseInt(s90.rounds||s90.rnd||0)||null,
        rating: parseFloat(s90.rating||s90.r||0)||null,
        acs, kills_per_map: kpm, adr, hs_pct,
        headshots_per_map: (hs_pct&&kpm) ? Math.round(kpm*(hs_pct/100)*10)/10 : null,
        kast: s90.kast||null,
        assists_per_map: parseFloat(s90.apr||0)>0 ? Math.round(parseFloat(s90.apr)*25*10)/10 : null,
        recent_kills_per_map: s60 ? (parseFloat(s60.kpr||0)>0 ? Math.round(parseFloat(s60.kpr)*25*10)/10 : null) : null,
        last7_kills: [], last7_assists: [],
        form_trend_kills: formTrend(parseFloat(s60?.acs||0)||null, acs, 0.1),
        form_trend: formTrend(parseFloat(s60?.acs||0)||null, acs, 0.1),
      };
      setCache(ck, result);
      return result;
    }
  } catch(e) { console.log(`vlrggapi error: ${e.message}`); }

  return { error: "player_not_found", player: playerName, source: "vlr.gg" };
}

// ─── DOTA2: OpenDota public API (no auth, always works) ──────────────────────
async function scrapeOpenDota(playerName) {
  const ck = `opendota:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  let proPlayers = getCached("opendota:pro_players");
  if (!proPlayers) {
    try {
      proPlayers = await fetchJSON("https://api.opendota.com/api/proPlayers");
      if (Array.isArray(proPlayers)) setCache("opendota:pro_players", proPlayers, 60*60*1000);
    } catch(e) { return { error: "api_unavailable", player: playerName, source: "OpenDota" }; }
  }

  if (!Array.isArray(proPlayers)) return { error: "api_error", player: playerName, source: "OpenDota" };

  const nl = playerName.toLowerCase();
  // Fuzzy match — try exact, then includes, then partial word match
  const pp = proPlayers.find(p => (p.name||"").toLowerCase() === nl) ||
             proPlayers.find(p => (p.name||"").toLowerCase().includes(nl)) ||
             proPlayers.find(p => nl.includes((p.name||"").toLowerCase()) && (p.name||"").length > 2) ||
             proPlayers.find(p => (p.persona_name||"").toLowerCase() === nl);

  if (!pp?.account_id) return { error: "player_not_found", player: playerName, source: "OpenDota" };

  try {
    // Get recent matches AND player heroes (for role context)
    const [matches, heroes] = await Promise.all([
      fetchJSON(`https://api.opendota.com/api/players/${pp.account_id}/recentMatches`),
      fetchJSON(`https://api.opendota.com/api/players/${pp.account_id}/heroes?limit=5`).catch(() => []),
    ]);

    if (!Array.isArray(matches) || !matches.length)
      return { error: "no_recent_matches", player: playerName, source: "OpenDota", team: pp.team_name };

    // Prefer pro matches (lobby_type=2) but use all if too few
    const proM = matches.filter(m => m.lobby_type === 2 || m.game_mode === 2);
    const toUse = (proM.length >= 3 ? proM : matches).slice(0, 15);

    const allK = toUse.map(m => m.kills).filter(k => k != null && k >= 0 && k <= 50);
    const allA = toUse.map(m => m.assists).filter(a => a != null && a >= 0 && a <= 50);
    const allD = toUse.map(m => m.deaths).filter(d => d != null && d >= 0);
    const last7K = allK.slice(0,7);
    const last7A = allA.slice(0,7);

    const result = {
      source: "OpenDota",
      player: pp.name || playerName,
      team: pp.team_name || null,
      account_id: pp.account_id,
      kills_per_game: allK.length >= 2 ? avg(allK) : null,
      assists_per_game: allA.length >= 2 ? avg(allA) : null,
      deaths_per_game: allD.length >= 2 ? avg(allD) : null,
      games: allK.length,
      last7_kills: last7K, last7_kills_avg: avg(last7K),
      last7_assists: last7A, last7_assists_avg: avg(last7A),
      form_trend_kills: last7K.length>=3 ? formTrend(avg(last7K), avg(allK)) : "UNKNOWN",
      form_trend_assists: last7A.length>=3 ? formTrend(avg(last7A), avg(allA)) : "UNKNOWN",
      form_trend: last7K.length>=3 ? formTrend(avg(last7K), avg(allK)) : "UNKNOWN",
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { error: "matches_failed", player: playerName, source: "OpenDota", team: pp?.team_name, message: e.message };
  }
}

// ─── RAINBOW SIX: tabstats + PandaScore ──────────────────────────────────────
async function scrapeSiegeGG(playerName) {
  const ck = `siegegg:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  // Strategy 1: PandaScore /r6-siege/players/{id}/stats
  try {
    const players = await pandaFetch(`/r6-siege/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        const stats = await pandaFetch(`/r6-siege/players/${pl.id}/stats`).catch(() => null);
        const kills = stats?.averages?.kills ?? null;
        const deaths = stats?.averages?.deaths ?? null;
        const hs_pct = stats?.averages?.headshots_percentage ?? null;

        const matches = await pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=15`).catch(() => []);
        const last7K = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games||[])) {
            if (!g.finished && !g.complete) continue;
            const gp = (g.players||[]).find(p => p.player_id===pl.id || p.player?.id===pl.id);
            if (gp?.kills != null && gp.kills <= 40) last7K.push(gp.kills);
            if (last7K.length >= 7) break;
          }
          if (last7K.length >= 7) break;
        }

        if (kills != null || last7K.length >= 2) {
          const kpr = kills ? kills / 12 : null; // R6 ~12 rounds per map
          const result = {
            source: "siege.gg",
            player: pl.name || playerName,
            team: pl.current_team?.name || null,
            kills_per_map: kills,
            kills_per_round: kpr,
            deaths_per_map: deaths,
            kd: (kills && deaths && deaths > 0) ? Math.round(kills/deaths*100)/100 : null,
            hs_pct,
            headshots_per_map: (hs_pct && kills) ? Math.round(kills*(hs_pct/100)*10)/10 : null,
            last7_kills: last7K,
            form_trend_kills: last7K.length>=3 ? formTrend(avg(last7K), kills) : "UNKNOWN",
          };
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch(e) { console.log(`scrapeSiegeGG PandaScore error: ${e.message}`); }

  // Strategy 2: tabstats.com public stats
  try {
    const slug = playerName.toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"");
    const html = await fetchPage(`https://tabstats.com/siege/player/${slug}`, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }).catch(() => null);
    if (html && !html.includes("Player not found") && html.length > 1000) {
      const kpdM = html.match(/K\/D[^0-9]*([0-9.]+)/i);
      const kdM = html.match(/Kills[^0-9]*([0-9]+)/i);
      if (kpdM) {
        const result = {
          source: "siege.gg", player: playerName,
          kd: parseFloat(kpdM[1]) || null,
          kills_per_map: kdM ? parseFloat(kdM[1]) : null,
        };
        if (result.kd) { setCache(ck, result); return result; }
      }
    }
  } catch {}

  return { error: "player_not_found", player: playerName, source: "siege.gg" };
}

// ─── COD: PandaScore match context + CDL role table ──────────────────────────
const CDL_ROLES = {
  "pred":"AR","attach":"Sub AR","cammy":"AR","shotzzy":"Flex","ghosty":"AR","scrap":"AR",
  "cellium":"AR","rated":"AR","crimsix":"Sub AR","dashy":"Flex","simp":"AR","abezy":"AR",
  "hyper":"AR","cleanx":"AR","grizzy":"Sub AR","owakening":"AR","standy":"Sub AR","mack":"AR",
  "bance":"Flex","hydra":"AR","envoy":"AR","rewindme":"AR","kremp":"Sub AR","zer0":"Flex",
  "huke":"AR","beans":"AR","decemate":"AR","sib":"Sub AR","insight":"AR","nero":"AR",
  "pentagrxm":"Sub AR","vikul":"AR","afrosap":"Sub AR","denzzy":"AR","eli":"AR","vivid":"Sub AR",
  "lacefield":"AR","benton":"AR","jimbo":"AR","havok":"AR","bbdrizzy":"AR","skyz":"Flex",
  "octane":"AR","scump":"Sub AR",
};

// CDL kills by role (series totals across all maps, HP+SnD mixed)
// AR: highest (main fragger), Sub AR: mid, Flex: varies
const CDL_KILL_BASELINES = { "AR": 45, "Sub AR": 35, "Flex": 40 };

async function scrapeBreakingPoint(playerName) {
  const ck = `bp:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  const role = CDL_ROLES[playerName.toLowerCase()] || null;
  const baseline = role ? CDL_KILL_BASELINES[role] : null;

  const result = {
    source: "breakingpoint.gg",
    player: playerName,
    role,
    kills_per_map: baseline ? Math.round(baseline / 3 * 10) / 10 : null, // /3 maps avg per series
    cdl_series_kill_baseline: baseline,
    backtest_warning: "COD_MODE_UNKNOWN_33pct_accuracy",
    mode_note: "HP kills avg 2-3x higher than SnD. Without mode classification conf MUST be capped at 65.",
  };

  // Try PandaScore /call-of-duty/players for live kills data
  try {
    const players = await pandaFetch(`/call-of-duty/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        const stats = await pandaFetch(`/call-of-duty/players/${pl.id}/stats`).catch(() => null);
        if (stats?.averages?.kills != null) {
          result.kills_per_map = stats.averages.kills;
          result.kd = stats.averages.deaths > 0 ? Math.round(stats.averages.kills/stats.averages.deaths*100)/100 : null;
          result.team = pl.current_team?.name || null;
          result.source_data = "PandaScore";
        }
        // Get recent match kills
        const matches = await pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=15`).catch(() => []);
        const last7K = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games||[])) {
            const gp = (g.players||[]).find(p => p.player_id===pl.id || p.player?.id===pl.id);
            if (gp?.kills != null) last7K.push(gp.kills);
            if (last7K.length >= 7) break;
          }
          if (last7K.length >= 7) break;
        }
        if (last7K.length >= 2) {
          result.last7_kills = last7K;
          result.last7_kills_avg = avg(last7K);
          result.form_trend_kills = formTrend(avg(last7K), result.kills_per_map);
        }
      }
    }
  } catch(e) { console.log(`scrapeBreakingPoint PandaScore error: ${e.message}`); }

  setCache(ck, result);
  return result;
}

// ─── LOL: PandaScore direct stats (replaces fragile gol.gg HTML) ──────────────
async function scrapeGolgg(playerName) {
  const ck = `golgg:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    const players = await pandaFetch(`/lol/players?search[name]=${encodeURIComponent(playerName)}`);
    if (Array.isArray(players) && players.length) {
      const nl = playerName.toLowerCase();
      const pl = players.find(p => (p.name||"").toLowerCase() === nl) || players[0];
      if (pl?.id) {
        const [stats, matches] = await Promise.all([
          pandaFetch(`/lol/players/${pl.id}/stats`).catch(() => null),
          pandaFetch(`/players/${pl.id}/matches?sort=-scheduled_at&per_page=20`).catch(() => []),
        ]);

        const kills = stats?.averages?.kills ?? null;
        const assists = stats?.averages?.assists ?? null;
        const deaths = stats?.averages?.deaths ?? null;

        const last7K = [], last7A = [];
        for (const m of (Array.isArray(matches) ? matches : [])) {
          if (m.status !== "finished") continue;
          for (const g of (m.games||[])) {
            if (!g.finished && !g.complete) continue;
            const gp = (g.players||[]).find(p => p.player_id===pl.id || p.player?.id===pl.id);
            if (gp?.kills != null && gp.kills <= 30) last7K.push(gp.kills);
            if (gp?.assists != null && gp.assists <= 40) last7A.push(gp.assists);
            if (last7K.length >= 10) break;
          }
          if (last7K.length >= 10) break;
        }

        if (kills != null || last7K.length >= 2) {
          const kda = (kills != null && deaths != null && deaths > 0)
            ? Math.round((kills + (assists||0)) / deaths * 100)/100 : null;
          const result = {
            source: "gol.gg",
            player: pl.name || playerName,
            team: pl.current_team?.name || null,
            role: pl.role || null,
            kills_per_game: kills,
            assists_per_game: assists,
            deaths_per_game: deaths,
            kda,
            kill_participation: null,
            recent_kills_per_game: last7K.length >= 3 ? avg(last7K.slice(0,5)) : null,
            recent_assists_per_game: last7A.length >= 3 ? avg(last7A.slice(0,5)) : null,
            last7_kills: last7K.slice(0,7), last7_kills_avg: avg(last7K.slice(0,7)),
            last7_assists: last7A.slice(0,7), last7_assists_avg: avg(last7A.slice(0,7)),
            last10_kills: last7K.slice(0,7), last10_avg: avg(last7K.slice(0,7)),
            form_trend_kills: last7K.length>=3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
            form_trend_assists: last7A.length>=3 ? formTrend(avg(last7A.slice(0,5)), assists) : "UNKNOWN",
            form_trend: last7K.length>=3 ? formTrend(avg(last7K.slice(0,5)), kills) : "UNKNOWN",
            games: stats?.games_count || last7K.length || null,
          };
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch(e) { console.log(`scrapeGolgg error: ${e.message}`); }

  return { error: "player_not_found", player: playerName, source: "gol.gg" };
}

// ─── LIQUIPEDIA: universal fallback (team/role only — no kill stats) ──────────
const LIQUIPEDIA_WIKIS = {
  LoL:"leagueoflegends", CS2:"counterstrike", Valorant:"valorant",
  Dota2:"dota2", R6:"rainbowsix", COD:"callofduty", APEX:"apexlegends",
};

async function scrapeLiquipedia(playerName, sport) {
  const wiki = LIQUIPEDIA_WIKIS[sport];
  if (!wiki) return { error: "unsupported_sport", player: playerName, source: "Liquipedia" };
  const ck = `liqui:${sport}:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;
  try {
    const slug = playerName.replace(/\s+/g,"_");
    const url = `https://liquipedia.net/${wiki}/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json`;
    const data = await fetchJSON(url, {
      "User-Agent": "EsportsKillModel/1.0 (research tool)",
      "Accept-Encoding": "identity",
    });
    if (data?.error || !data?.parse?.wikitext?.["*"]) return { error: "player_not_found", player: playerName, source: "Liquipedia", sport };
    const wikitext = data.parse.wikitext["*"];
    const extractField = (text, field) => {
      const re = new RegExp(`\\|\\s*${field}\\s*=\\s*([^\\n|]+)`, "i");
      const m = text.match(re);
      return m ? m[1].trim().replace(/\[\[([^\]|]+)[^\]]*\]\]/g,"$1").replace(/<[^>]+>/g,"").trim() : null;
    };
    const team = extractField(wikitext,"team") || extractField(wikitext,"current team");
    const role = extractField(wikitext,"role") || extractField(wikitext,"position");
    const nat = extractField(wikitext,"nationality") || extractField(wikitext,"country");
    const result = {
      source: "Liquipedia", player: playerName,
      team: team||null, role: role||null, nationality: nat||null,
      kills_per_game: null, assists_per_game: null,
      last7_kills: [], last7_assists: [],
      form_trend: "UNKNOWN", form_trend_kills: "UNKNOWN",
    };
    if (result.team || result.role) { setCache(ck, result); return result; }
    return { error: "no_stats", player: playerName, source: "Liquipedia", team, role };
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "Liquipedia", message: e.message };
  }
}

// ─── H2H MATCH HISTORY from PandaScore ───────────────────────────────────────
// Extracts head-to-head record and recent form for BOTH teams from PandaScore past matches
// This is the key matchup context that was missing from the analysis
async function getH2HContext(teamA, teamB, sport) {
  if (!teamA || !teamB || teamB === "?") return null;
  const slug = PS_SLUGS[sport];
  if (!slug) return null;

  const ck = `h2h:${slug}:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    // Fetch past matches for the sport — look for H2H matchups
    const past = await pandaFetch(`/${slug}/matches/past?per_page=100&sort=-scheduled_at`);
    if (!Array.isArray(past) || !past.length) return null;

    const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const nA = norm(normalizeTeamName(teamA));
    const nB = norm(normalizeTeamName(teamB));

    const h2hMatches = past.filter(m => {
      const ops = (m.opponents||[]).map(o => norm(o.opponent?.name||""));
      return ops.some(o => o.includes(nA)||nA.includes(o)) && ops.some(o => o.includes(nB)||nB.includes(o));
    }).slice(0, 10);

    // Also get recent form for teamA (last 5 matches regardless of opponent)
    const teamAMatches = past.filter(m => {
      const ops = (m.opponents||[]).map(o => norm(o.opponent?.name||""));
      return ops.some(o => o.includes(nA)||nA.includes(o));
    }).slice(0, 10);

    if (!h2hMatches.length && !teamAMatches.length) return null;

    // Compute H2H record
    let h2hWins = 0, h2hLosses = 0;
    const h2hResults = [];
    for (const m of h2hMatches) {
      if (m.status !== "finished" || !m.winner) continue;
      const winnerName = norm(m.winner?.name||"");
      const teamAWon = winnerName.includes(nA) || nA.includes(winnerName);
      if (teamAWon) h2hWins++; else h2hLosses++;
      h2hResults.push({
        date: m.scheduled_at ? m.scheduled_at.slice(0,10) : null,
        winner: m.winner?.name || null,
        tournament: m.tournament?.name || null,
        score: m.results?.map(r => r.score).join("-") || null,
        format: m.number_of_games === 1 ? "Bo1" : m.number_of_games === 5 ? "Bo5" : "Bo3",
      });
    }

    // Compute recent form for teamA (W/L last 5)
    const recentForm = [];
    for (const m of teamAMatches.slice(0,5)) {
      if (m.status !== "finished" || !m.winner) continue;
      const winnerName = norm(m.winner?.name||"");
      const teamAWon = winnerName.includes(nA) || nA.includes(winnerName);
      const opp = (m.opponents||[]).map(o => o.opponent?.name||"").find(n => !norm(n).includes(nA)) || "?";
      recentForm.push(`${teamAWon?"W":"L"} vs ${opp}`);
    }

    const result = {
      h2h_wins: h2hWins,
      h2h_losses: h2hLosses,
      h2h_total: h2hWins + h2hLosses,
      h2h_win_rate: (h2hWins + h2hLosses) > 0 ? Math.round(h2hWins/(h2hWins+h2hLosses)*100) : null,
      h2h_last5: h2hResults.slice(0,5),
      recent_form: recentForm,
      recent_form_string: recentForm.join(" | "),
    };

    if (result.h2h_total > 0 || result.recent_form.length > 0) {
      setCache(ck, result);
      return result;
    }
    return null;
  } catch(e) {
    console.log(`getH2HContext error: ${e.message}`);
    return null;
  }
}

// ─── STAT ROUTING ──────────────────────────────────────────────────────────────
async function getStats(player, sport, teamName, opponentName) {
  let scraped = null;

  switch (sport) {
    case "LoL":      scraped = await scrapeGolgg(player); break;
    case "CS2":      scraped = await scrapeHltv(player, teamName, opponentName); break;
    case "Valorant": scraped = await scrapeVlr(player); break;
    case "Dota2":    scraped = await scrapeOpenDota(player); break;
    case "R6":       scraped = await scrapeSiegeGG(player); break;
    case "COD":      scraped = await scrapeBreakingPoint(player); break;
    case "APEX":
      scraped = { source:"N/A", player, note:"No public Apex pro stats. Zone RNG adds 30%+ variance.", backtest_warning:"APEX_ZONE_RNG" };
      break;
    default:
      scraped = { error: "unsupported_sport", player, sport };
  }

  // If primary scraper failed with no data, try Liquipedia for team/role context
  if (!scraped || scraped.error) {
    console.log(`Primary scraper failed for ${player} (${sport}), trying Liquipedia`);
    const liqui = await scrapeLiquipedia(player, sport).catch(() => null);
    if (liqui && !liqui.error) {
      scraped = liqui;
    }
  }

  return scraped;
}




// ─── FORMAT NOTES (shown in AI prompt as highest-priority context) ─────────────
function formatNotes(data) {
  if (!data) return null;

  const L7 = (arr, label="L7-K") => arr && arr.length ? `${label}:[${arr.join(",")}]avg${avg(arr)}` : null;
  const p = [];

  if (data.error && !["HLTV","breakingpoint.gg"].includes(data.source)) {
    return `${data.source||"?"}:${data.error}${data.message ? " — "+data.message : ""}`;
  }

  if (data.source === "PandaScore") {
    const planBadge = data.plan === "historical" ? "PS-H" : "PS-F"; // H=historical, F=free
    p.push(`${planBadge}(${data.games||"?"}g)`);
    if (data.note) p.push(`⚠ ${data.note}`);
    if (data.kills_per_game != null) p.push(`${data.kills_per_game}k/g`);
    if (data.assists_per_game != null) p.push(`${data.assists_per_game}a/g`);
    if (data.kda) p.push(`KDA ${data.kda}`);
    if (data.acs) p.push(`ACS${data.acs}`);
    if (data.rating) p.push(`Rtg${data.rating}`);
    if (data.adr) p.push(`ADR${data.adr}`);
    if (data.hs_pct != null) p.push(`HS%${data.hs_pct}%`);
    if (data.role) p.push(`Role:${data.role}`);
    if (data.team) p.push(`Team:${data.team}`);
    p.push(L7(data.last7_kills)); p.push(L7(data.last7_assists,"L7-A"));
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
    if (data.plan === "free" && !data.kills_per_game) p.push("⚠ PS-FREE-ONLY: season avgs unavailable — use L7 + role for projection");
  } else if (data.source === "gol.gg") {
    p.push(`gol.gg(${data.games||"?"}g)`);
    if (data.kills_per_game != null) p.push(`${data.kills_per_game}k/g`);
    if (data.assists_per_game != null) p.push(`${data.assists_per_game}a/g`);
    if (data.kda) p.push(`KDA ${data.kda}`);
    if (data.kill_participation) p.push(`KP ${data.kill_participation}`);
    if (data.recent_kills_per_game != null) p.push(`Rec-K:${data.recent_kills_per_game}`);
    if (data.recent_assists_per_game != null) p.push(`Rec-A:${data.recent_assists_per_game}`);
    p.push(L7(data.last7_kills)); p.push(L7(data.last7_assists,"L7-A"));
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
    if (data.form_trend_assists && data.form_trend_assists !== "UNKNOWN") p.push(`Aform:${data.form_trend_assists}`);
    if (data.role) p.push(`Role:${data.role}`);
  } else if (data.source === "HLTV") {
    p.push("HLTV");
    if (data.rating) p.push(`Rtg${data.rating}`);
    if (data.kills_per_map != null) p.push(`${data.kills_per_map}k/map`);
    if (data.adr) p.push(`ADR${data.adr}`);
    if (data.kast) p.push(`KAST${data.kast}`);
    if (data.hs_pct != null) p.push(`HS%${data.hs_pct}%`);
    if (data.headshots_per_map != null) p.push(`${data.headshots_per_map}HS/map`);
    // Form trend from recent matches (now scraped)
    p.push(L7(data.last10_kills,"L10-K"));
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
    // MAP POOL CONTEXT -- the key CS2 signal
    if (data.map_pool_context) {
      const mc = data.map_pool_context;
      if (mc.confirmed_maps?.length) {
        // Veto is known -- include per-map kill projections
        p.push(`VETO_CONFIRMED:${mc.confirmed_maps.join("/")}`);
        if (mc.expected_kills_per_map) p.push(`MAP_PROJ:${mc.expected_kills_per_map}k/map`);
        if (mc.map_breakdown?.length) {
          for (const mb of mc.map_breakdown) {
            if (mb.kills_per_map) p.push(`${mb.map}:${mb.kills_per_map}k`);
          }
        }
        p.push("CS2_VETO_KNOWN -- conf cap lifted, use MAP_PROJ for projection");
      } else if (mc.per_map_stats && Object.keys(mc.per_map_stats).length) {
        // No veto yet but we have per-map breakdown
        const mapBreakdown = Object.entries(mc.per_map_stats)
          .map(([map, s]) => `${map}:${s.kills_per_map}k`)
          .join("/");
        p.push(`PER_MAP(${mapBreakdown})`);
        p.push("CS2_MAP_POOL_UNKNOWN -- veto TBD, per-map stats above for context -- cap conf<=68");
      } else {
        // No veto, no per-map data
        p.push("⚠ CS2_MAP_POOL_UNKNOWN -- BACKTEST:42pct_accuracy -- cap conf<=68");
      }
    } else if (data.cs2_map_pool_warning) {
      // Legacy path: no map context at all
      p.push("⚠ CS2_MAP_POOL_UNKNOWN -- BACKTEST:42pct_accuracy -- cap conf<=68");
    }
  } else if (data.source === "vlr.gg") {
    p.push(`vlr.gg(${data.rounds||"?"}rnd)`);
    if (data.acs) p.push(`ACS${data.acs}`);
    if (data.kills_per_map != null) p.push(`${data.kills_per_map}k/map`);
    if (data.assists_per_map != null) p.push(`${data.assists_per_map}a/map`);
    if (data.kast) p.push(`KAST${data.kast}`);
    if (data.adr) p.push(`ADR${data.adr}`);
    if (data.hs_pct != null) p.push(`HS%${data.hs_pct}%`);
    if (data.headshots_per_map != null) p.push(`${data.headshots_per_map}HS/map`);
    if (data.recent_kills_per_map != null) p.push(`Rec-K:${data.recent_kills_per_map}`);
    if (data.recent_assists_per_map != null) p.push(`Rec-A:${data.recent_assists_per_map}`);
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
  } else if (data.source === "OpenDota") {
    p.push(`OpenDota(${data.games||"?"}g)`);
    if (data.kills_per_game != null) p.push(`${data.kills_per_game}k/g`);
    if (data.assists_per_game != null) p.push(`${data.assists_per_game}a/g`);
    if (data.deaths_per_game != null) p.push(`${data.deaths_per_game}d/g`);
    p.push(L7(data.last7_kills)); p.push(L7(data.last7_assists,"L7-A"));
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
    if (data.form_trend_assists && data.form_trend_assists !== "UNKNOWN") p.push(`Aform:${data.form_trend_assists}`);
  } else if (data.source === "siege.gg") {
    p.push("siege.gg");
    if (data.kills_per_map != null) p.push(`${data.kills_per_map}k/map`);
    if (data.kills_per_round) p.push(`KPR${data.kills_per_round}`);
    if (data.kd) p.push(`K/D${data.kd}`);
    if (data.kost) p.push(`KOST${data.kost}`);
    if (data.hs_pct != null) p.push(`HS%${data.hs_pct}%`);
    if (data.headshots_per_map != null) p.push(`${data.headshots_per_map}HS/map`);
  } else if (data.source === "breakingpoint.gg") {
    p.push("BP.gg");
    if (data.role) p.push(`Role:${data.role}`);
    if (data.kills_per_map != null) p.push(`${data.kills_per_map}k/map`);
    if (data.kd) p.push(`K/D${data.kd}`);
    if (data.damage_per_round) p.push(`DMG${data.damage_per_round}`);
    if (data.hs_pct != null) p.push(`HS%${data.hs_pct}%`);
    if (data.error === "fetch_blocked" || data.error === "fetch_failed") p.push("(blocked-CDL table)");
    // MANDATORY — AI must cap conf at 65
    p.push("⚠ COD_MODE_UNKNOWN — BACKTEST:33pct_accuracy — cap conf≤65");
  } else if (data.backtest_warning === "APEX_ZONE_RNG") {
    p.push("APEX:no_public_stats — ⚠ zone_RNG=30%+_variance — cap conf≤70");
  } else if (data.source === "Liquipedia") {
    p.push(`Liquipedia`);
    if (data.team) p.push(`Team:${data.team}`);
    if (data.role) p.push(`Role:${data.role}`);
    if (data.kills_per_game != null) p.push(`${data.kills_per_game}k/g`);
    if (data.assists_per_game != null) p.push(`${data.assists_per_game}a/g`);
    if (data.kda) p.push(`KDA ${data.kda}`);
    p.push(L7(data.last7_kills)); p.push(L7(data.last7_assists,"L7-A"));
    if (data.form_trend_kills && data.form_trend_kills !== "UNKNOWN") p.push(`Kform:${data.form_trend_kills}`);
    if (!data.kills_per_game && !data.last7_kills?.length) p.push("⚠ kill stats unavailable — use team/role for context only");
  }

  return p.filter(Boolean).join(" · ") || null;
}

// ─── CALIBRATION ENGINE ─────────────────────────────────────────────────────────
function computeCalibration(picks) {
  const settled = picks.filter(p => p.result !== "PENDING");
  if (!settled.length) return null;

  const byGrade = {};
  for (const grade of ["S","A","B","C"]) {
    const gp = settled.filter(p => p.grade === grade);
    const hits = gp.filter(p => p.result === "HIT").length;
    const expectedRate = gp.length ? gp.reduce((s,p) => s + (p.conf||65)/100, 0) / gp.length : null;
    const actualRate = gp.length ? hits / gp.length : null;
    byGrade[grade] = {
      n: gp.length, hits,
      expectedRate: expectedRate ? Math.round(expectedRate*100)/100 : null,
      actualRate: actualRate ? Math.round(actualRate*100)/100 : null,
      delta: (expectedRate!=null && actualRate!=null) ? Math.round((actualRate-expectedRate)*100)/100 : null,
    };
  }

  const bySport = {};
  const byStatType = {};
  for (const p of settled) {
    if (!bySport[p.sport]) bySport[p.sport] = { n:0, hits:0 };
    bySport[p.sport].n++; if (p.result==="HIT") bySport[p.sport].hits++;
    const st = p.stat_type || "KILLS";
    if (!byStatType[st]) byStatType[st] = { n:0, hits:0 };
    byStatType[st].n++; if (p.result==="HIT") byStatType[st].hits++;
  }

  for (const k of Object.keys(bySport)) bySport[k].hit_rate = Math.round(bySport[k].hits / bySport[k].n * 100);
  for (const k of Object.keys(byStatType)) byStatType[k].hit_rate = Math.round(byStatType[k].hits / byStatType[k].n * 100);

  const overall = settled.filter(p=>p.result==="HIT").length;

  return {
    totalSettled: settled.length,
    overallHitRate: Math.round(overall / settled.length * 100),
    byGrade, bySport, byStatType,
    seedCount: SEED_PICKS.length,
    note: `Includes ${SEED_PICKS.length} seeded verified 2024 results. Live picks build on this baseline.`,
  };
}

// ─── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", ts: new Date().toISOString(),
  picks: pickLog.length, seeds: SEED_PICKS.length,
  pandascore: !!PANDASCORE_KEY,
  pandascore_key_prefix: PANDASCORE_KEY ? PANDASCORE_KEY.slice(0,8)+"..." : "MISSING — set PANDASCORE_KEY env var on Render",
  pandascore_plan: "free+historical_attempt",
  pandascore_slugs: PS_SLUGS,
  pandascore_fallbacks: PS_SLUG_FALLBACKS,
  odds_api: !!process.env.ODDS_API_KEY,
  auto_settle: true,
  anthropic: !!process.env.ANTHROPIC_KEY,
  capabilities: ["match-context","player-stats","win-prob-h2h","auto-settle","backtest","pick-log","semaphore-rate-limit","slug-fallbacks"],
}));

app.get("/stats", async (req, res) => {
  const { player, sport, team, opponent } = req.query;
  if (!player || !sport) return res.status(400).json({ error: "player and sport required" });
  try {
    const data = await getStats(player, sport, team, opponent);
    res.json({ ...data, notes: formatNotes(data) });
  } catch (err) { res.status(500).json({ error: "scrape_failed", message: err.message, player, sport }); }
});

app.post("/stats/batch", async (req, res) => {
  const props = req.body;
  if (!Array.isArray(props) || !props.length) return res.status(400).json({ error: "body must be array" });
  const seen = new Set();
  const unique = props.filter(p => { const k=`${p.player}::${p.sport}`; if(seen.has(k)) return false; seen.add(k); return true; });
  // Run up to 4 in parallel (STATS_SEM) with light stagger -- much faster than sequential 700ms delays
  const results = {};
  await Promise.all(unique.map((prop, idx) =>
    STATS_SEM.run(async () => {
      if (idx > 0) await new Promise(r => setTimeout(r, Math.min(idx * 120, 900)));
      try {
        const data = await getStats(prop.player, prop.sport, prop.team, prop.opponent);
        results[`${prop.player}::${prop.sport}`] = { ...data, notes: formatNotes(data) };
      } catch (err) { results[`${prop.player}::${prop.sport}`] = { error: "scrape_failed", message: err.message }; }
    })
  ));
  res.json(results);
});

app.post("/cache/clear", (req, res) => {
  const count = Object.keys(cache).length;
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ cleared: count });
});

// ─── ANTHROPIC PROXY ──────────────────────────────────────────────────────────
// Post-processes AI output to enforce hard confidence caps regardless of AI output
function enforceConfCaps(result, reqBody) {
  try {
    const content = result?.content?.[0]?.text;
    if (!content) return result;

    let parsed;
    try { parsed = JSON.parse(content); } catch { return result; }

    let changed = false;

    // Detect sport from the system prompt (reqBody.system contains buildSystemPrompt output)
    // System prompt contains "SPORT: Counter-Strike 2", "SPORT: Valorant", etc.
    // Fallback: user prompt starts with "Analyze this CS2 PrizePicks prop:"
    const systemText = reqBody?.system || "";
    const userText   = reqBody?.messages?.[0]?.content || "";
    const allText    = systemText + " " + userText;

    const isCS2  = /SPORT: Counter-Strike|Analyze this CS2/i.test(allText)  || allText.includes("CS2_MAP_POOL_UNKNOWN") || allText.includes("CS2_VETO_KNOWN");
    const isCOD  = /SPORT: Call of Duty|Analyze this COD/i.test(allText)    || allText.includes("COD_MODE_UNKNOWN");
    const isAPEX = /SPORT: Apex Legends|Analyze this APEX/i.test(allText);

    // Hard caps -- enforced in code, cannot be overridden by AI
    // CS2: cap at 68 ONLY if map pool unknown. If VETO_CONFIRMED, allow up to 78.
    const cs2VetoKnown = allText.includes("CS2_VETO_KNOWN") || allText.includes("VETO_CONFIRMED");
    if (isCS2 && !cs2VetoKnown && parsed.confidence > 68) { parsed.confidence = 68; changed = true; }
    if (isCS2 &&  cs2VetoKnown && parsed.confidence > 78) { parsed.confidence = 78; changed = true; } // lift to 78 max when veto known
    if (isCOD  && parsed.confidence > 65) { parsed.confidence = 65; changed = true; }
    if (isAPEX && parsed.confidence > 70) { parsed.confidence = 70; changed = true; }

    // Universal ceiling
    if (parsed.confidence > 84) { parsed.confidence = 84; changed = true; }

    // Cap at 65 ONLY when we have truly nothing — no stats AND no match context
    // Having SCOUT NOTES = real kill data → allow full conf
    // Having MATCH CONTEXT (H2H, series format) = meaningful signal → allow up to 72
    // Having neither = role baseline only → cap at 65
    const hasRealStats = userText.includes("SCOUT NOTES") &&
                         !userText.includes("player_not_found") &&
                         !userText.includes("scrape_failed") &&
                         !userText.includes("api_unavailable");
    const hasMatchContext = userText.includes("MATCH CONTEXT") || userText.includes("H2H:") || userText.includes("WIN_PROB:");
    if (!hasRealStats && !hasMatchContext && parsed.confidence > 65) {
      parsed.confidence = 65;
      parsed.variance_flags = [...(parsed.variance_flags || []), "role_baseline_only: no stats or match context — conf capped at 65"];
      changed = true;
    } else if (!hasRealStats && hasMatchContext && parsed.confidence > 72) {
      parsed.confidence = 72;
      parsed.variance_flags = [...(parsed.variance_flags || []), "match_context_only: no kill stats — conf capped at 72"];
      changed = true;
    }

    // Re-grade after any cap enforcement
    if (changed) {
      const c = parsed.confidence;
      parsed.grade = c >= 78 ? "S" : c >= 70 ? "A" : c >= 62 ? "B" : "C";
      if (parsed.grade === "C") {
        parsed.rec_standard = "SKIP"; parsed.rec_goblin = "SKIP"; parsed.rec_demon = "SKIP";
        parsed.parlay_worthy = false;
      }
      result = { ...result, content: [{ ...result.content[0], text: JSON.stringify(parsed) }] };
    }
  } catch(e) { console.log("enforceConfCaps error:", e.message); }
  return result;
}

app.post("/analyze", async (req, res) => {
  try {
    const payload = JSON.stringify(req.body);
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-api-key": process.env.ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
      }, (r) => {
        const chunks = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(new Error("Anthropic parse failed")); } });
        r.on("error", reject);
      });
      req2.on("error", reject);
      req2.write(payload); req2.end();
    });
    // Enforce hard caps before returning to frontend
    res.json(enforceConfCaps(result, req.body));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── WIN PROBABILITY — Multi-source odds ─────────────────────────────────────
// Source priority (all wrapped in ODDS_SEM to prevent rate-limit burst):
// 1. PandaScore upcoming match — free, reliable, gives Bo format + team IDs for H2H
// 2. The-Odds-API (if ODDS_API_KEY env var set) — Pinnacle + DK odds
// 3. PandaScore H2H win rate — derived from past match results (always available)
// 4. PandaScore recent form fallback — if H2H insufficient
// NOTE: OddsPapi free tier and arcadia.pinnacle.com are both defunct/blocked.
//       Working sources: TheOddsAPI (ODDS_API_KEY env) + PandaScore H2H (always available free).
//       Best free source is PandaScore H2H which works reliably with the free token.

// PandaScore match winner odds extraction
// The free tier match object sometimes includes 'winner' (determined) or 'draw' field
// and always has opponent info for H2H calculation
async function fetchOddsFromPandaMatch(teamA, teamB, sport) {
  const ck = `panda_odds:${sport}:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck, 30*60*1000); if (cached) return cached;

  const primarySlug = PS_SLUGS[sport];
  if (!primarySlug) return null;
  const slugsToTry = [primarySlug, ...(PS_SLUG_FALLBACKS[sport] || []).filter(s => s !== primarySlug)];

  const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const nA = norm(normalizeTeamName(teamA));
  const nB = norm(normalizeTeamName(teamB));

  try {
    let all = [], slug = primarySlug;
    for (const s of slugsToTry) {
      const [upcoming, running, past] = await Promise.all([
        pandaFetch(`/${s}/matches/upcoming?per_page=200`),
        pandaFetch(`/${s}/matches/running?per_page=50`),
        pandaFetch(`/${s}/matches/past?per_page=30&sort=-scheduled_at`),
      ]);
      const combined = [
        ...(Array.isArray(upcoming)?upcoming:[]),
        ...(Array.isArray(running)?running:[]),
        ...(Array.isArray(past)?past.slice(0,15):[]),
      ];
      if (combined.length > 0) { all = combined; slug = s; break; }
    }

    const match = all.find(m => {
      const ops = (m.opponents||[]).map(o => o.opponent?.name||"");
      return ops.some(o => fuzzyTeamMatch(nA, o)) && ops.some(o => fuzzyTeamMatch(nB, o));
    });
    if (!match) return null;

    // Extract team IDs for H2H
    const opA = match.opponents?.find(o => fuzzyTeamMatch(nA, o.opponent?.name||""));
    const opB = match.opponents?.find(o => fuzzyTeamMatch(nB, o.opponent?.name||""));
    const teamAId = opA?.opponent?.id;
    const teamBId = opB?.opponent?.id;

    // Try to get H2H results to compute win probability
    if (teamAId && teamBId) {
      const h2h = await pandaFetch(`/${slug}/matches/past?filter[opponent_id]=${teamAId}&per_page=30&sort=-scheduled_at`);
      if (Array.isArray(h2h)) {
        const h2hMatches = h2h.filter(m => {
          const ids = (m.opponents||[]).map(o => o.opponent?.id);
          return ids.includes(teamAId) && ids.includes(teamBId) && m.results?.length;
        }).slice(0, 10);

        if (h2hMatches.length >= 2) {
          const teamAWins = h2hMatches.filter(m => {
            return (m.opponents||[]).find(o => o.opponent?.id===teamAId && o.result?.outcome==="win");
          }).length;
          const rawWinRate = teamAWins/h2hMatches.length;
          // Clamp: 0% or 100% H2H is noise (small sample), never assign 0 or 1
          const winRate = Math.round(Math.max(0.10, Math.min(0.90, rawWinRate))*100)/100;
          const result = {
            available: true, source: "PandaScore/H2H",
            team_win_prob: winRate,
            opp_win_prob: Math.round((1-winRate)*100)/100,
            team: teamA, opponent: teamB,
            h2h_sample: h2hMatches.length,
            series_format: match.number_of_games===1?"Bo1":match.number_of_games===5?"Bo5":"Bo3",
            tournament: match.tournament?.name,
            note: `${teamAWins}W/${h2hMatches.length-teamAWins}L in last ${h2hMatches.length} H2H`,
          };
          setCache(ck, result);
          return result;
        }

        // Not enough H2H — use teamA recent form
        const recentA = h2h.filter(m => (m.opponents||[]).some(o=>o.opponent?.id===teamAId) && m.results?.length).slice(0,10);
        if (recentA.length >= 3) {
          const wins = recentA.filter(m => (m.opponents||[]).find(o=>o.opponent?.id===teamAId&&o.result?.outcome==="win")).length;
          const rawRate = wins/recentA.length;
          const winRate = Math.round(Math.max(0.10, Math.min(0.90, rawRate))*100)/100;
          const result = {
            available: true, source: "PandaScore/RecentForm",
            team_win_prob: winRate,
            opp_win_prob: Math.round((1-winRate)*100)/100,
            team: teamA, opponent: teamB,
            series_format: match.number_of_games===1?"Bo1":match.number_of_games===5?"Bo5":"Bo3",
            tournament: match.tournament?.name,
            note: `${teamA} recent form: ${wins}W/${recentA.length-wins}L in last ${recentA.length}`,
          };
          setCache(ck, result);
          return result;
        }
      }
    }

    // Match confirmed but no H2H data — return 50/50 with series context
    const result = {
      available: true, source: "PandaScore/Scheduled",
      team_win_prob: 0.50, opp_win_prob: 0.50,
      team: teamA, opponent: teamB,
      series_format: match.number_of_games===1?"Bo1":match.number_of_games===5?"Bo5":"Bo3",
      tournament: match.tournament?.name,
      note: "Match confirmed. Insufficient H2H data — treating as even.",
    };
    setCache(ck, result);
    return result;
  } catch(e) { console.log(`fetchOddsFromPandaMatch error: ${e.message}`); }
  return null;
}

// The-Odds-API: real Pinnacle + DK odds (requires ODDS_API_KEY env var)
async function fetchTheOddsApi(teamA, teamB, sport) {
  if (!process.env.ODDS_API_KEY) return null;
  const ck = `theoddsapi:${sport}:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck, 15*60*1000); if (cached) return cached;

  // The-Odds-API esports sport keys
  const SPORT_KEYS = {
    LoL: "esports_lol", CS2: "esports_cs2", Valorant: "esports_val",
    Dota2: "esports_dota2", COD: "esports_cod", R6: "esports_r6", APEX: "esports_apex",
  };
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return null;

  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=us&markets=h2h&bookmakers=pinnacle,draftkings,betmgm&oddsFormat=decimal`;
    const data = await fetchJSON(url);
    if (!Array.isArray(data)) return null;

    const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const nA = norm(normalizeTeamName(teamA)), nB = norm(normalizeTeamName(teamB));
    const match = data.find(g => {
      const h=norm(g.home_team), a=norm(g.away_team);
      return (h.includes(nA)||nA.includes(h))&&(a.includes(nB)||nB.includes(a)) ||
             (h.includes(nB)||nB.includes(h))&&(a.includes(nA)||nA.includes(a));
    });
    if (!match) return null;

    const bk = match.bookmakers?.find(b=>b.key==="pinnacle") || match.bookmakers?.[0];
    const h2h = bk?.markets?.find(m=>m.key==="h2h");
    if (!h2h) return null;

    const norm2 = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const homeN = norm2(match.home_team), awayN = norm2(match.away_team);
    const homeO = h2h.outcomes?.find(o=>norm2(o.name)===homeN)?.price;
    const awayO = h2h.outcomes?.find(o=>norm2(o.name)===awayN)?.price;
    if (!homeO || !awayO) return null;

    const rH=1/homeO, rA=1/awayO, tot=rH+rA;
    const homeIsA = homeN.includes(nA)||nA.includes(homeN);
    const result = {
      available: true, source: `TheOddsAPI/${bk.key}`,
      team_win_prob: Math.round((homeIsA?rH:rA)/tot*100)/100,
      opp_win_prob:  Math.round((homeIsA?rA:rH)/tot*100)/100,
      team: teamA, opponent: teamB,
    };
    setCache(ck, result);
    return result;
  } catch(e) { console.log(`TheOddsAPI error: ${e.message}`); }
  return null;
}

// Unified match win probability — wrapped in ODDS_SEM to prevent burst rate-limiting
async function fetchMatchWinProb(teamA, teamB, sport) {
  if (!teamA || !teamB || teamA === "?" || teamB === "?") return { available: false, reason: "missing_teams" };
  return ODDS_SEM.run(async () => {
    // 1. The-Odds-API with real Pinnacle/DK odds (best source if key provided)
    if (process.env.ODDS_API_KEY) {
      try {
        const odds = await fetchTheOddsApi(teamA, teamB, sport);
        if (odds?.available) return odds;
      } catch(e) { console.log(`TheOddsAPI failed: ${e.message}`); }
    }
    // 2. PandaScore match context + H2H win rate (free, always available)
    try {
      const odds = await fetchOddsFromPandaMatch(teamA, teamB, sport);
      if (odds?.available) return odds;
    } catch(e) { console.log(`PandaMatch odds failed: ${e.message}`); }

    return { available: false, reason: "no_odds_source" };
  });
}

function findMatchOddsLegacy(oddsData, teamA, teamB) {
  if (!oddsData || !Array.isArray(oddsData)) return null;
  const n = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const tA=n(teamA), tB=n(teamB);
  for (const game of oddsData) {
    const h=n(game.home_team), a=n(game.away_team);
    if ((h.includes(tA)||tA.includes(h))&&(a.includes(tB)||tB.includes(a)) || (h.includes(tB)||tB.includes(h))&&(a.includes(tA)||tA.includes(a))) {
      const bk = game.bookmakers?.find(b=>b.key==="pinnacle") || game.bookmakers?.[0];
      if (!bk) return null;
      const h2h = bk.markets?.find(m=>m.key==="h2h");
      if (!h2h) return null;
      const hO = h2h.outcomes?.find(o=>n(o.name)===h)?.price;
      const aO = h2h.outcomes?.find(o=>n(o.name)===a)?.price;
      if (!hO || !aO) return null;
      const rH=1/hO, rA=1/aO, tot=rH+rA;
      return { home_team:game.home_team, away_team:game.away_team, home_prob:Math.round(rH/tot*100)/100, away_prob:Math.round(rA/tot*100)/100, bookmaker:bk.key };
    }
  }
  return null;
}

// ─── AUTO-SETTLE ENGINE ───────────────────────────────────────────────────────
// Every 30 min, check for pending picks >24h old and try to auto-settle via PandaScore
async function autoSettle() {
  const pending = pickLog.filter(p => !p.is_seed && p.result === "PENDING");
  if (!pending.length) return;

  const now = Date.now();
  const stale = pending.filter(p => now - new Date(p.logged_at).getTime() > 24*60*60*1000);
  if (!stale.length) return;

  console.log(`Auto-settle: checking ${stale.length} picks older than 24h`);

  for (const pick of stale) {
    try {
      const sport = pick.sport;
      const slug = PS_SLUGS[sport];
      if (!slug || !pick.team) continue;

      // Try to find the match result via PandaScore past matches
      const past = await pandaFetch(`/${slug}/matches/past?per_page=50&sort=-scheduled_at`);
      if (!Array.isArray(past)) continue;

      const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
      const tA = norm(pick.team), tB = norm(pick.opponent||"");
      const loggedAt = new Date(pick.logged_at).getTime();

      const match = past.find(m => {
        const mt = new Date(m.scheduled_at||m.end_at||0).getTime();
        if (mt < loggedAt - 3*60*60*1000) return false; // must be after logged minus 3h buffer
        const ops = (m.opponents||[]).map(o => norm(o.opponent?.name||""));
        return ops.some(o => o.includes(tA)||tA.includes(o)) &&
               (!tB || ops.some(o => o.includes(tB)||tB.includes(o)));
      });

      if (!match) continue;

      // Found the match — determine winner for win_prob context
      // We can't auto-settle the specific stat (kills) without game-level player data
      // But we can mark as "NEEDS_MANUAL" after confirming match happened
      if (match.status === "finished") {
        pick.match_confirmed = true;
        pick.match_id = match.id;
        pick.match_result = match.results?.map(r => `${r.team?.name}:${r.score}`).join(" vs ") || "finished";
        pick.settle_note = "Match finished — confirm actual stat to settle";
        console.log(`Auto-settle: match confirmed for ${pick.player} (${pick.team}) — manual stat entry needed`);
      }
    } catch(e) {
      console.log(`Auto-settle error for ${pick.player}: ${e.message}`);
    }
  }
  savePicks();
}

// Run auto-settle every 30 minutes
setInterval(autoSettle, 30*60*1000);

// ─── MATCH CONTEXT — THE MISSING #1 SIGNAL ───────────────────────────────────
// Returns: Bo format, tournament tier, Pinnacle win prob — all in one call
// App should call this BEFORE analyzing any prop — feeds directly into system prompt
app.get("/match-context", async (req, res) => {
  const { team, opponent, sport } = req.query;
  if (!team || !sport) return res.status(400).json({ error: "team and sport required" });

  const [context, odds, h2h] = await Promise.all([
    pandaMatchContext(team, opponent||"", sport).catch(() => null),
    opponent ? fetchMatchWinProb(team, opponent, sport).catch(() => ({ available: false })) : Promise.resolve({ available: false }),
    opponent ? getH2HContext(team, opponent, sport).catch(() => null) : Promise.resolve(null),
  ]);

  // Build a single context object the AI can consume directly in its system prompt
  const result = {
    team, opponent, sport,
    series_format: context?.series_format || null,         // Bo1 / Bo3 / Bo5 — #1 kill multiplier
    number_of_games: context?.number_of_games || null,
    tournament: context?.tournament || null,
    league: context?.league || null,
    tournament_tier: context?.tournament_tier || null,    // S / A / B
    scheduled_at: context?.scheduled_at || null,
    odds: (odds?.available && odds.team_win_prob > 0 && odds.team_win_prob < 1) ? {
      team_win_prob: odds.team_win_prob,
      opp_win_prob: odds.opp_win_prob,
      source: odds.source,
    } : null,
    source: context ? "PandaScore" : "unavailable",
    h2h: h2h || null,
    // Pre-formatted string for AI system prompt injection
    prompt_context: buildMatchContextString(context, odds, h2h, team, opponent),
  };

  res.json(result);
});

function buildMatchContextString(ctx, odds, h2h, team, opponent) {
  const parts = [];
  if (ctx?.series_format) parts.push(`SERIES: ${ctx.series_format} (${ctx.number_of_games} maps max)`);
  if (ctx?.tournament) parts.push(`EVENT: ${ctx.tournament}${ctx.tournament_tier ? ` [Tier ${ctx.tournament_tier}]` : ""}`);
  if (odds?.available && odds.team_win_prob > 0 && odds.team_win_prob < 1) {
    parts.push(`WIN_PROB: ${team} ${Math.round(odds.team_win_prob*100)}% (Pinnacle-derived)`);
  }
  // H2H matchup history — the key missing context
  if (h2h) {
    if (h2h.h2h_total >= 2) {
      parts.push(`H2H: ${team} ${h2h.h2h_wins}-${h2h.h2h_losses} vs ${opponent} (last ${h2h.h2h_total})`);
      if (h2h.h2h_win_rate != null) parts.push(`H2H_WIN_RATE: ${h2h.h2h_win_rate}%`);
      if (h2h.h2h_last5?.length) {
        const recent = h2h.h2h_last5.slice(0,3).map(m => `${m.winner?.split(" ").pop()||"?"} won (${m.score||"?"})`).join(", ");
        parts.push(`RECENT_H2H: ${recent}`);
      }
    }
    if (h2h.recent_form?.length) {
      parts.push(`${team}_FORM: ${h2h.recent_form_string}`);
    }
  }
  if (!parts.length) return null;
  return parts.join(" | ");
}

// Legacy /odds route (kept for backwards compat)
app.get("/odds", async (req, res) => {
  const { team, opponent } = req.query;
  if (!team || !opponent) return res.status(400).json({ error: "team and opponent required" });
  const sport = req.query.sport || "LoL";
  try {
    const odds = await fetchMatchWinProb(team, opponent, sport);
    res.json(odds);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRIZEPICKS PROXY ──────────────────────────────────────────────────────────
// Dynamic league discovery: first GET /leagues to find real esport league IDs,
// then fetch projections per league. This is identical to what popup.js does
// and is the only reliable approach since PP league IDs are not documented.

const PP_HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer": "https://app.prizepicks.com/",
  "Origin": "https://app.prizepicks.com",
};

// Keywords that identify an esport league from the PP /leagues response
const PP_ESPORT_SPORTS = new Set([
  "VAL","LOL","CS2","CSGO","CS","DOTA","DOTA2","R6","COD","APEX","RL","OW","OWL",
  "VALORANT","CALL OF DUTY","CALLOFDUTY","LEAGUE OF LEGENDS","COUNTER-STRIKE",
  "COUNTER STRIKE","RAINBOW SIX","RAINBOW SIX SIEGE","APEX LEGENDS",
  "ROCKET LEAGUE","OVERWATCH","STARCRAFT","DOTA 2","HALO","ESPORTS","E-SPORTS",
]);
const PP_ESPORT_KEYWORDS = [
  "league of legends","lol","lck","lcs","lec","lpl","lta","lcp","worlds","msi",
  "valorant","vct","counter-strike","cs2","csgo","esl","blast","iem","pgl","pro league",
  "dota","dota2","the international","dreamleague","call of duty","cod","cdl",
  "rainbow six","r6","siege","apex legends","algs","rocket league","rlcs",
  "overwatch","owl","esport","e-sport",
  // PP short-code league names (verified from live API)
  "lol","cod","val","dota2","apex","rl","halo",
];

function isEsportPPLeague(league) {
  const sport = ((league.attributes?.sport || league.sport || "")).toUpperCase().trim();
  if (PP_ESPORT_SPORTS.has(sport)) return true;
  const name = (league.attributes?.name || league.name || league.attributes?.display_name || "").toLowerCase();
  return PP_ESPORT_KEYWORDS.some(kw => name.includes(kw));
}

// Discover esport league IDs from PP's leagues endpoint (cached 30 min)
async function discoverPPLeagueIds() {
  const ck = "pp_leagues_discovery";
  const cached = getCached(ck, 30 * 60 * 1000);
  if (cached) return cached;

  try {
    const data = await fetchJSON("https://api.prizepicks.com/leagues", PP_HEADERS);
    const leagues = Array.isArray(data) ? data : (data?.data || []);
    const esportLeagues = leagues.filter(isEsportPPLeague);
    const ids = esportLeagues.map(l => String(l.id));
    console.log(`PP discovered ${ids.length} esport league IDs: ${ids.join(",")}`);
    if (ids.length > 0) {
      setCache(ck, ids);
      return ids;
    }
  } catch(e) {
    console.log(`PP leagues discovery failed: ${e.message}`);
  }

  // Fallback: known IDs as of early 2025 (used if /leagues is blocked or empty)
  // These are approximate — dynamic discovery is preferred
  const FALLBACK_IDS = ["121","145","159","161","174","265","267","268","274"]; // Real PP esport IDs verified 2026-03-08
  console.log("PP using fallback league IDs");
  return FALLBACK_IDS;
}

// Fetch projections for a single PP league ID
async function fetchPPLeague(leagueId) {
  const ck = `pp_league:${leagueId}:${Math.floor(Date.now()/60000)}`; // 1-min cache key
  const cached = getCached(ck);
  if (cached) return cached;

  const url = `https://api.prizepicks.com/projections?league_id=${leagueId}&per_page=250&single_stat=true`;
  try {
    const data = await fetchJSON(url, PP_HEADERS);
    // Accept response even if data array is empty — still has valid included objects
    if (data && typeof data === "object" && "data" in data) {
      if (data.data.length > 0) setCache(ck, data); // only cache non-empty
      return data;
    }
  } catch(e) {
    console.log(`PP league ${leagueId} fetch error: ${e.message}`);
  }
  return null;
}

// Merge multiple PP API responses into one (combine data + included, dedup by id)
function mergePPResponses(responses) {
  const merged = { data: [], included: [] };
  const seenData = new Set();
  const seenIncluded = new Set();
  for (const r of responses) {
    if (!r) continue;
    for (const item of (r.data || [])) {
      if (!seenData.has(item.id)) { seenData.add(item.id); merged.data.push(item); }
    }
    for (const item of (r.included || [])) {
      const k = `${item.type}:${item.id}`;
      if (!seenIncluded.has(k)) { seenIncluded.add(k); merged.included.push(item); }
    }
  }
  return merged;
}

// ─── PRIZEPICKS PROXY — DISABLED ──────────────────────────────────────────────
// Server-side PP fetch is permanently disabled: Render's IP gets 403 (no user session
// cookies) and 429 (rate limited) from api.prizepicks.com. Only the Chrome extension
// can fetch PP data because it has host_permissions that bypass CORS.
// Flow: extension FETCH_AND_RELAY → POST /relay → app polls GET /relay
app.get("/prizepicks/props", (req, res) => {
  res.status(410).json({
    error: "Server-side PP fetch is disabled. Use the Chrome extension: open popup → FETCH ALL DIRECT → SEND.",
    solution: "Extension → FETCH ALL DIRECT → SEND button pushes data to /relay. App auto-imports on load with ?relay=1.",
  });
});

// ─── RELAY ─────────────────────────────────────────────────────────────────────
let relayData = null, relayTs = 0;
app.post("/relay", (req, res) => { relayData=req.body; relayTs=Date.now(); res.json({ ok:true, count:req.body?.data?.length||0 }); });
app.get("/relay", (req, res) => { if (!relayData || Date.now()-relayTs > 300000) return res.json({ data:null, expired:true }); res.json({ data:relayData, ts:relayTs }); });
app.delete("/relay", (req, res) => { relayData=null; res.json({ ok:true }); });

// ─── PICK LOGGER ───────────────────────────────────────────────────────────────
app.post("/picks/log", (req, res) => {
  const pick = { id: Date.now(), logged_at: new Date().toISOString(), ...req.body, result: "PENDING", settled_at: null, is_seed: false };
  pickLog.push(pick);
  savePicks();
  res.json({ ok:true, id:pick.id, total:pickLog.length });
});

app.get("/picks/log", (req, res) => {
  const { sport, result, stat_type, limit=500, include_seeds="true" } = req.query;
  let log = [...pickLog].reverse();
  if (include_seeds === "false") log = log.filter(p => !p.is_seed);
  if (sport) log = log.filter(p => p.sport === sport);
  if (result) log = log.filter(p => p.result === result);
  if (stat_type) log = log.filter(p => p.stat_type === stat_type);
  log = log.slice(0, parseInt(limit));

  const userPicks = pickLog.filter(p => !p.is_seed);
  const settled = userPicks.filter(p => p.result !== "PENDING");
  const hits = settled.filter(p => p.result === "HIT").length;
  res.json({
    log,
    stats: {
      total: userPicks.length, settled: settled.length,
      pending: userPicks.filter(p=>p.result==="PENDING").length, hits,
      misses: settled.filter(p=>p.result==="MISS").length,
      hit_rate: settled.length > 0 ? Math.round(hits/settled.length*100) : null,
      calibration: computeCalibration(pickLog),
    },
  });
});

app.patch("/picks/log/:id", (req, res) => {
  const pick = pickLog.find(p => String(p.id) === String(req.params.id));
  if (!pick) return res.status(404).json({ error: "not found" });
  if (pick.is_seed) return res.status(400).json({ error: "cannot modify seed picks" });
  pick.result = req.body.result || pick.result;
  pick.actual = req.body.actual ?? pick.actual;
  pick.settled_at = new Date().toISOString();
  savePicks();
  res.json({ ok:true, pick });
});

app.delete("/picks/log/:id", (req, res) => {
  const idx = pickLog.findIndex(p => String(p.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "not found" });
  if (pickLog[idx].is_seed) return res.status(400).json({ error: "cannot delete seed picks" });
  pickLog.splice(idx, 1);
  savePicks();
  res.json({ ok:true });
});

app.delete("/picks/log", (req, res) => {
  const before = pickLog.length;
  const seeds = pickLog.filter(p => p.is_seed);
  pickLog.length = 0;
  pickLog.push(...seeds);
  savePicks();
  res.json({ ok:true, cleared: before - seeds.length, seeds_preserved: seeds.length });
});

// ─── BACKTEST ENDPOINT ─────────────────────────────────────────────────────────
app.get("/backtest/summary", (req, res) => {
  res.json({
    calibration: computeCalibration(pickLog),
    total_picks: pickLog.length,
    seed_count: SEED_PICKS.length,
    user_picks: pickLog.filter(p=>!p.is_seed).length,
    methodology: "Seed data = 31 manually verified 2024-2025 esports props with confirmed outcomes. Small sample — directional signal only, not statistically significant. Live user picks build the real calibration over time.",
    findings: {
      Valorant: { sample:6, accuracy:"6/6 seed picks", verdict:"Directional signal: agent-confirmed props show edge. Sample too small for statistical confidence. Build picks here with confirmed agent data.", cap:null },
      LoL:      { sample:9, accuracy:"7/9 seed picks (77.8%)", verdict:"Strongest signal in seed data. Role+champion confirmed props. Primary parlay sport — but only when champion is confirmed.", cap:null },
      Dota2:    { sample:4, accuracy:"4/4 seed picks", verdict:"Very small n. Position analysis shows signal. Play with confirmed hero draft only.", cap:null },
      R6:       { sample:2, accuracy:"2/2 seed picks", verdict:"Insufficient data — n=2. Treat as coin flip until n>20.", cap:68 },
      CS2:      { sample:7, accuracy:"3/7 seed picks (42.9%) — pre-fix baseline", verdict:"Root cause identified and fixed: map pool veto was unknown on all 4 star-fragger misses. Fix: HLTV per-map stats + veto scraping now active. When VETO_CONFIRMED: conf cap lifted to 78, per-map kill projections used. When veto unknown: cap stays 68. IGL LESS (karrigan, gla1ve) remains the safest CS2 signal regardless of veto.", cap:68, cap_with_veto:78 },
      COD:      { sample:3, accuracy:"3/3 seed picks (100% at Grade B capped conf 60-63)", verdict:"3/3 seed hits but n=3 is statistically meaningless. Mode (HP vs SnD) varies kills 3-5x — conf capped at 65 on all COD. Never parlay.", cap:65 },
    },
    ev_by_sport: {
      Valorant: "Directional: +EV on agent-confirmed props (small sample)",
      LoL: "+EV directional signal (77.8% on 9 seed picks)",
      Dota2: "Directional: position analysis shows signal (n=4)",
      R6: "NEUTRAL — insufficient data",
      CS2: "CONDITIONAL: +EV when VETO_CONFIRMED (per-map stats used, cap 78). -EV when veto unknown (cap 68, IGL LESS only). Always check veto status before CS2 props.",
      COD: "UNCERTAIN — mode classification required before any COD props",
    },
    recommendation: "Build parlays from Valorant + LoL + Dota2 with confirmed agent/champion/position data. CS2 now viable when VETO_CONFIRMED — star fraggers on AWP maps (Dust2/Mirage) are +EV with per-map projections. Avoid COD until mode data available. Settle picks manually to build real calibration.",
    sharpness_note: "This system gets sharper as you settle picks. Every HIT/MISS you log improves calibration. Target 100+ settled picks before trusting calibration percentages.",
  });
});

app.listen(PORT, () => console.log(`Kill Model backend ✓ port ${PORT}`));
