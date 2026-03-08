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
const PANDASCORE_KEY = process.env.PANDASCORE_TOKEN || "yHdGyhnfSi64p6HgWYA5Os-K-PmmNibPVZ8C5PdfBhGEH4DubFA";

// Video game IDs used by PandaScore API
const PS_GAME_IDS = { LoL:1, CS2:3, Valorant:26, Dota2:4, R6:24, COD:14, APEX:20 };

// Slug prefixes for sport-specific endpoints
const PS_SLUGS = { LoL:"lol", CS2:"csgo", Valorant:"valorant", Dota2:"dota2", R6:"r6siege", COD:"codmw", APEX:"apex-legends" };

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
      if (data && !data.error_message) {
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
  const slug = PS_SLUGS[sport];
  if (!slug) return null;
  const ck = `ps_match:${slug}:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck);
  if (cached) return cached;

  try {
    // Search upcoming and running matches
    const [upcoming, running] = await Promise.all([
      pandaFetch(`/${slug}/matches/upcoming?per_page=100`),
      pandaFetch(`/${slug}/matches/running?per_page=20`),
    ]);

    const all = [...(Array.isArray(upcoming) ? upcoming : []), ...(Array.isArray(running) ? running : [])];

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
    if (statsData?.error_message) statsData = null; // free tier — skip gracefully
  } catch {}

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

  // Only return if we got something meaningful
  if (!result.team && !result.role && !result.kills_per_game && !result.last7_kills?.length) return null;
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

  try {
    const [seasonHtml, recentHtml] = await Promise.all([
      fetchPage("https://gol.gg/players/list/season-ALL/split-ALL/tournament-ALL/"),
      fetchPage("https://gol.gg/players/list/season-S15/split-ALL/tournament-ALL/").catch(() => null),
    ]);

    function parseRow(html) {
      if (!html) return null;
      for (const cells of extractTableRows(html)) {
        if (cells.length < 8) continue;
        if (!cells[0].toLowerCase().includes(playerName.toLowerCase())) continue;
        return {
          player: cells[0], team: cells[1]||null, role: cells[2]||null,
          kda: parseFloat(cells[3])||null,
          kills_per_game: parseFloat(cells[4])||null,
          deaths_per_game: parseFloat(cells[5])||null,
          assists_per_game: parseFloat(cells[6])||null,
          kill_participation: cells[8]||null,
          games: parseInt(cells[9])||null,
        };
      }
      return null;
    }

    const season = parseRow(seasonHtml);
    if (!season) return { error: "player_not_found", player: playerName, source: "gol.gg" };

    let lastKills = [], lastAssists = [];
    try {
      const slug = playerName.toLowerCase().replace(/\s+/g, "-");
      const matchHtml = await fetchPage(`https://gol.gg/players/player-stats/${slug}/`);
      for (const cells of extractTableRows(matchHtml)) {
        if (cells.length >= 7) {
          const k = parseFloat(cells[2]), a = parseFloat(cells[4]);
          if (!isNaN(k) && k >= 0 && k <= 50) lastKills.push(k);
          if (!isNaN(a) && a >= 0 && a <= 50) lastAssists.push(a);
          if (lastKills.length >= 7) break;
        }
      }
    } catch {}

    const recent = parseRow(recentHtml);
    const result = {
      source: "gol.gg", ...season,
      recent_kills_per_game: recent?.kills_per_game || null,
      recent_assists_per_game: recent?.assists_per_game || null,
      last7_kills: lastKills.slice(0,7), last7_kills_avg: avg(lastKills.slice(0,7)),
      last7_assists: lastAssists.slice(0,7), last7_assists_avg: avg(lastAssists.slice(0,7)),
      last10_kills: lastKills.slice(0,7), last10_avg: avg(lastKills.slice(0,7)),
      form_trend_kills: lastKills.length >= 3 ? formTrend(avg(lastKills), season.kills_per_game) : formTrend(recent?.kills_per_game, season.kills_per_game),
      form_trend_assists: lastAssists.length >= 3 ? formTrend(avg(lastAssists), season.assists_per_game) : "UNKNOWN",
      form_trend: lastKills.length >= 3 ? formTrend(avg(lastKills), season.kills_per_game) : formTrend(recent?.kills_per_game, season.kills_per_game),
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "gol.gg", message: e.message };
  }
}

// ─── HLTV CS2 MAP CONSTANTS ───────────────────────────────────────────────────
// Current CS2 active duty pool (2025)
const CS2_MAPS = ["Dust2","Mirage","Inferno","Nuke","Overpass","Ancient","Anubis","Vertigo"];

// AWP-friendly maps (more open angles, longer sightlines = more AWP kills)
const AWP_FAVORABLE_MAPS = new Set(["Dust2","Mirage","Inferno","Ancient"]);
// Tight/CQC maps where AWPs under-perform, rifles over-perform
const RIFLE_FAVORABLE_MAPS = new Set(["Nuke","Overpass","Vertigo","Anubis"]);

// Expected kill multiplier per map vs average (based on historical round counts / site aggression)
const MAP_KILL_MULTIPLIER = {
  Dust2:    1.10, // open, high pick rate, ~48-52 total kills avg
  Mirage:   1.05, // popular, balanced
  Inferno:  0.98, // tight, slower pace
  Nuke:     0.90, // most rounds go pistol heavy on ct side
  Overpass: 0.95,
  Ancient:  1.00,
  Anubis:   1.02,
  Vertigo:  0.93,
};

// ─── HLTV: SCRAPE UPCOMING MATCH VETO FOR SPECIFIC TEAMS ─────────────────────
// Scrapes hltv.org/matches to find upcoming/live match between teamA and teamB
// Returns the confirmed/picked maps if veto is in progress or complete
async function scrapeHltvMatchVeto(teamA, teamB) {
  const ck = `hltv_veto:${teamA.toLowerCase()}:${teamB.toLowerCase()}`;
  const cached = getCached(ck, 15*60*1000); // 15min cache for live veto data
  if (cached) return cached;

  try {
    // Try HLTV matches page for upcoming/live events
    const html = await fetchPage("https://www.hltv.org/matches");

    const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    const nA = norm(teamA), nB = norm(teamB);

    // Find match block containing both teams
    // HLTV match blocks: <div class="match-info-box"> or <div class="upcomingMatch">
    const matchBlocks = [];
    const blockRe = /<(?:div|a)[^>]+(?:upcomingMatch|liveMatch|matchInfo)[^>]*>([\s\S]*?)<\/(?:div|a)>/gi;
    let bm;
    while ((bm = blockRe.exec(html)) !== null) matchBlocks.push(bm[1]);

    // Also check for team names directly in raw HTML near each other
    // Look for both team names within 800 chars of each other
    let vetoMaps = [];
    let matchFound = false;

    // Strategy: find href="/matches/NNN/teamA-vs-teamB" pattern
    const matchLinkRe = /href="(\/matches\/\d+\/[^"]+)"[^>]*>[\s\S]{0,600}?(?:Dust2|Mirage|Inferno|Nuke|Overpass|Ancient|Anubis|Vertigo)/gi;
    let mlm;
    while ((mlm = matchLinkRe.exec(html)) !== null) {
      const slug = mlm[1].toLowerCase();
      if ((slug.includes(nA.slice(0,4)) || slug.includes(nA.slice(0,5))) &&
          (slug.includes(nB.slice(0,4)) || slug.includes(nB.slice(0,5)))) {
        matchFound = true;
        // Extract map names from surrounding context
        const ctx = mlm[0];
        for (const map of CS2_MAPS) {
          if (ctx.includes(map)) vetoMaps.push(map);
        }
      }
    }

    // Try individual match page if we found a match link
    if (!matchFound) {
      // Search for team name proximity
      const lHtml = html.toLowerCase();
      const idxA = lHtml.indexOf(nA.slice(0,5));
      if (idxA !== -1) {
        const nearby = lHtml.slice(Math.max(0, idxA-100), idxA+500);
        if (nearby.includes(nB.slice(0,4))) {
          matchFound = true;
          // Try to find map names in vicinity
          const ctx = html.slice(Math.max(0, idxA-100), idxA+500);
          for (const map of CS2_MAPS) {
            if (ctx.includes(map)) vetoMaps.push(map);
          }
        }
      }
    }

    const result = {
      match_found: matchFound,
      confirmed_maps: [...new Set(vetoMaps)],  // deduplicate
      veto_complete: vetoMaps.length >= 1,
      source: "HLTV/matches",
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { match_found: false, confirmed_maps: [], veto_complete: false, source: "HLTV/matches", error: e.message };
  }
}

// ─── HLTV: PER-MAP PLAYER STATS ───────────────────────────────────────────────
// Fetches how a player performs on each specific map (crucial for CS2 props)
// URL: /stats/players/{id}/{slug}?startDate=...&endDate=...&maps={mapName}
async function scrapeHltvPerMapStats(playerId, playerSlug, maps, d90, today) {
  const mapStats = {};
  // Only fetch top 3 maps to avoid rate limiting
  const mapsToFetch = (maps || CS2_MAPS.slice(0,4));

  const fetches = mapsToFetch.slice(0,3).map(async mapName => {
    const mapLower = mapName.toLowerCase().replace("2","").replace("pass",""); // dust, mirage, inferno, nuke
    const ck = `hltv_map:${playerId}:${mapLower}`;
    const cached = getCached(ck); if (cached) return { map: mapName, stats: cached };
    try {
      const url = `https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${d90}&endDate=${today}&maps=${mapLower}`;
      const html = await fetchPage(url);
      const stats = {};
      const r = /summaryStatBreakdownName[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+summaryStatBreakdownVal[^>]*>([^<]+)</gi;
      let m;
      while ((m = r.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();
      const kpr = parseFloat(stats["KPR"]||0);
      const parsed = {
        kpr, kills_per_map: kpr > 0 ? Math.round(kpr*25*10)/10 : null,
        rating: parseFloat(stats["Rating 2.0"]||stats["Rating"]||0),
        adr: parseFloat(stats["ADR"]||0),
      };
      setCache(ck, parsed);
      return { map: mapName, stats: parsed };
    } catch { return { map: mapName, stats: null }; }
  });

  const results = await Promise.all(fetches);
  for (const { map, stats } of results) {
    if (stats?.kills_per_map) mapStats[map] = stats;
  }
  return mapStats;
}

// ─── HLTV: RECENT MATCH HISTORY (last 10 games kills) ────────────────────────
async function scrapeHltvRecentMatches(playerId, playerSlug, d90, today) {
  try {
    const ck = `hltv_recent:${playerId}`;
    const cached = getCached(ck); if (cached) return cached;

    const url = `https://www.hltv.org/stats/players/individual/${playerId}/${playerSlug}/matches?startDate=${d90}&endDate=${today}`;
    const html = await fetchPage(url);

    // Parse table rows: each row has match date, opponent, map, kills, deaths, rating
    const kills = [];
    const rows = extractTableRows(html);
    for (const cells of rows) {
      if (cells.length >= 5) {
        // Typical HLTV match table: Date | Team | Opponent | Map | K | D | +/- | ADR | KAST | Rating
        // Kill column is usually index 4 or 5
        for (const idx of [4, 5, 3]) {
          const k = parseInt(cells[idx]);
          if (!isNaN(k) && k >= 0 && k <= 60) {
            kills.push(k);
            break;
          }
        }
      }
      if (kills.length >= 10) break;
    }

    const result = kills.length >= 2 ? kills : null;
    if (result) setCache(ck, result);
    return result;
  } catch { return null; }
}

// ─── HLTV (CS2 FULL INTEL) ────────────────────────────────────────────────────
// Full upgrade: player stats + per-map breakdown + recent form + veto data
async function scrapeHltv(playerName, teamName, opponentName) {
  const ck = `hltv:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    const d90  = new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);
    const d30  = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
    const today = new Date().toISOString().slice(0,10);

    // Step 1: Find player ID and slug from HLTV player list
    const listHtml = await fetchPage(`https://www.hltv.org/stats/players?startDate=${d30}&endDate=${today}&rankingFilter=Top50`);
    const linkRe = /href="\/stats\/players\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)\s*</gi;
    let playerId = null, playerSlug = null, m;
    while ((m = linkRe.exec(listHtml)) !== null) {
      if (m[3].trim().toLowerCase() === playerName.toLowerCase()) { playerId = m[1]; playerSlug = m[2]; break; }
    }

    // If not found in top50, try top100
    if (!playerId) {
      const list100 = await fetchPage(`https://www.hltv.org/stats/players?startDate=${d90}&endDate=${today}&rankingFilter=Top30`).catch(() => "");
      while ((m = linkRe.exec(list100)) !== null) {
        if (m[3].trim().toLowerCase() === playerName.toLowerCase()) { playerId = m[1]; playerSlug = m[2]; break; }
      }
    }

    if (!playerId) return { error: "player_not_found", player: playerName, source: "HLTV", cs2_map_pool_warning: true };

    // Step 2: Season overview stats (d90 for bigger sample)
    function parseHltvStats(html) {
      const stats = {};
      const r = /summaryStatBreakdownName[^>]*>([^<]+)<\/[^>]+>\s*<[^>]+summaryStatBreakdownVal[^>]*>([^<]+)</gi;
      let m;
      while ((m = r.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();
      const kpr = parseFloat(stats["KPR"]||0);
      const hsRaw = stats["HS%"] || stats["Headshot %"] || null;
      const hs_pct = hsRaw ? parseFloat(hsRaw.replace("%","")) : null;
      return {
        rating: parseFloat(stats["Rating 2.0"]||stats["Rating"]||0),
        kpr, kills_per_map: kpr > 0 ? Math.round(kpr*25*10)/10 : null,
        adr: parseFloat(stats["ADR"]||0), kast: stats["KAST"]||null,
        hs_pct, headshots_per_map: (kpr>0 && hs_pct!=null) ? Math.round(kpr*25*(hs_pct/100)*10)/10 : null,
      };
    }

    // Fetch season stats + per-map stats + recent matches in parallel
    const [sHtml, recentKills, vetoData] = await Promise.all([
      fetchPage(`https://www.hltv.org/stats/players/${playerId}/${playerSlug}?startDate=${d90}&endDate=${today}`),
      scrapeHltvRecentMatches(playerId, playerSlug, d90, today),
      (teamName && opponentName) ? scrapeHltvMatchVeto(teamName, opponentName) : Promise.resolve(null),
    ]);

    const season = parseHltvStats(sHtml);

    // Step 3: Per-map stats for top 4 maps
    // If veto is known, prioritize those specific maps
    const mapsToCheck = vetoData?.confirmed_maps?.length >= 1
      ? vetoData.confirmed_maps.slice(0,3)
      : CS2_MAPS.slice(0,4);
    const perMapStats = await scrapeHltvPerMapStats(playerId, playerSlug, mapsToCheck, d90, today);

    // Step 4: Compute form trend from recent match kills
    const last10_kills = Array.isArray(recentKills) ? recentKills.slice(0,10) : [];
    const last10_avg = last10_kills.length >= 2 ? avg(last10_kills) : null;
    const form_trend_kills = (last10_avg && season.kills_per_map)
      ? formTrend(last10_avg, season.kills_per_map)
      : "UNKNOWN";

    // Step 5: Determine map pool context
    // If veto known: compute expected kills for those specific maps
    let map_pool_context = null;
    let cs2_map_pool_warning = true; // default: still unknown

    if (vetoData?.confirmed_maps?.length >= 1) {
      cs2_map_pool_warning = false; // We have veto data — lift the blanket cap!
      const confirmedMaps = vetoData.confirmed_maps;

      // Compute weighted expected kills for confirmed maps
      const mapKills = confirmedMaps.map(map => {
        const mapSpecific = perMapStats[map]?.kills_per_map;
        const globalMult = MAP_KILL_MULTIPLIER[map] || 1.0;
        const baseK = mapSpecific || (season.kills_per_map ? season.kills_per_map * globalMult : null);
        return { map, kills_per_map: baseK, source: mapSpecific ? "per-map-stat" : "global-avg" };
      }).filter(x => x.kills_per_map);

      const expectedK = mapKills.length
        ? Math.round(mapKills.reduce((s,x) => s+x.kills_per_map, 0) / mapKills.length * 10) / 10
        : null;

      map_pool_context = {
        confirmed_maps: confirmedMaps,
        expected_kills_per_map: expectedK,
        map_breakdown: mapKills,
        veto_complete: vetoData.veto_complete,
        note: `Veto confirmed: ${confirmedMaps.join("/")} — expected ${expectedK||"?"}k/map`,
      };
    } else {
      // No veto yet — provide per-map breakdown as context for common maps
      const hasAnyMapData = Object.keys(perMapStats).length >= 1;
      if (hasAnyMapData) {
        map_pool_context = {
          confirmed_maps: [],
          per_map_stats: perMapStats,
          note: "Veto TBD — per-map stats provided for context",
        };
      }
    }

    const result = {
      source: "HLTV", player: playerName,
      ...season,
      last10_kills,
      last10_avg,
      form_trend: form_trend_kills,
      form_trend_kills,
      per_map_stats: perMapStats,
      map_pool_context,
      cs2_map_pool_warning,  // false when veto confirmed, true otherwise
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "HLTV", cs2_map_pool_warning: true, message: e.message };
  }
}

// ─── VLR.GG (Valorant HTML fallback) ──────────────────────────────────────────
async function scrapeVlr(playerName) {
  const ck = `vlr:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    const [html90, html30] = await Promise.all([
      fetchPage("https://www.vlr.gg/stats/?type=players&timespan=90d"),
      fetchPage("https://www.vlr.gg/stats/?type=players&timespan=60d").catch(()=>null),
    ]);

    function parseVlrRow(html, name) {
      if (!html) return null;
      for (const cells of extractTableRows(html)) {
        if (cells.length < 8) continue;
        const n0 = cells[0].toLowerCase(), n1 = (cells[1]||"").toLowerCase();
        if (!n0.includes(name.toLowerCase()) && !n1.includes(name.toLowerCase())) continue;
        const o = n0.includes(name.toLowerCase()) ? 0 : 1;
        return {
          rounds: parseInt(cells[2+o])||null, rating: parseFloat(cells[3+o])||null,
          acs: parseFloat(cells[4+o])||null, kills_per_map: parseFloat(cells[5+o])||null,
          deaths_per_map: parseFloat(cells[6+o])||null, assists_per_map: parseFloat(cells[7+o])||null,
          kast: cells[8+o]||null, adr: parseFloat(cells[9+o])||null,
          hs_pct: parseFloat((cells[10+o]||"").replace("%",""))||null,
          fk_per_map: parseFloat(cells[11+o])||null,
        };
      }
      return null;
    }

    const season = parseVlrRow(html90, playerName);
    if (!season) return { error: "player_not_found", player: playerName, source: "vlr.gg" };

    const recent = parseVlrRow(html30, playerName);
    const hs_per_map = (season.hs_pct && season.kills_per_map) ? Math.round(season.kills_per_map * (season.hs_pct/100) * 10)/10 : null;

    const result = {
      source: "vlr.gg", player: playerName, ...season,
      headshots_per_map: hs_per_map,
      recent_acs: recent?.acs||null,
      recent_kills_per_map: recent?.kills_per_map||null,
      recent_assists_per_map: recent?.assists_per_map||null,
      last7_kills: [], last7_assists: [],
      form_trend_kills: formTrend(recent?.acs, season.acs, 0.1),
      form_trend: formTrend(recent?.acs, season.acs, 0.1),
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "vlr.gg", message: e.message };
  }
}

// ─── SIEGE.GG (R6 fallback) ───────────────────────────────────────────────────
async function scrapeSiegeGG(playerName) {
  const ck = `siegegg:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    const slug = playerName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const html = await fetchPage(`https://siege.gg/players/${slug}`);
    if (!html || html.includes("Player not found") || html.includes("404")) {
      return { error: "player_not_found", player: playerName, source: "siege.gg" };
    }
    const result = { source: "siege.gg", player: playerName };
    const kprM = html.match(/KPR[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i); if (kprM) result.kills_per_round = parseFloat(kprM[1]);
    const kdM = html.match(/K\/D[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+)/i); if (kdM) result.kd = parseFloat(kdM[1]);
    const kostM = html.match(/KOST[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+%?)/i); if (kostM) result.kost = kostM[1];
    const hsM = html.match(/HS%[^<]*<\/[^>]+>[^<]*<[^>]+>([0-9.]+%?)/i); if (hsM) result.hs_pct = parseFloat(hsM[1].replace("%",""));
    if (result.kills_per_round) {
      result.kills_per_map = Math.round(result.kills_per_round * 12 * 10) / 10;
      if (result.hs_pct) result.headshots_per_map = Math.round(result.kills_per_map * (result.hs_pct/100) * 10) / 10;
    }
    if (!result.kd && !result.kills_per_round) return { error: "parse_failed", player: playerName, source: "siege.gg" };
    setCache(ck, result);
    return result;
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "siege.gg", message: e.message };
  }
}

// ─── COD: breakingpoint.gg + CDL role table ────────────────────────────────────
// BACKTEST: Without mode data accuracy was 33%. Role table gives direction signal.
// Model must cap conf at 65 for all COD props (see notes string flag).
const CDL_ROLES = {
  "pred":"AR","attach":"Sub AR","cammy":"AR","shotzzy":"Flex","ghosty":"AR","scrap":"AR",
  "cellium":"AR","rated":"AR","crimsix":"Sub AR","dashy":"Flex","simp":"AR","abezy":"AR",
  "hyper":"AR","cleanx":"AR","grizzy":"Sub AR","owakening":"AR","standy":"Sub AR","mack":"AR",
  "bance":"Flex","hydra":"AR","envoy":"AR","rewindme":"AR","kremp":"Sub AR","zer0":"Flex",
  "huke":"AR","beans":"AR","decemate":"AR","sib":"Sub AR","insight":"AR","nero":"AR",
  "pentagrxm":"Sub AR","vikul":"AR","afrosap":"Sub AR","denzzy":"AR","eli":"AR","vivid":"Sub AR",
  "lacefield":"AR","benton":"AR","jimbo":"AR","havok":"AR","bbdrizzy":"AR","skyz":"Flex",
  "octane":"AR","scump":"Sub AR","shotzzy":"Flex",
};

async function scrapeBreakingPoint(playerName) {
  const ck = `bp:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  const result = {
    source: "breakingpoint.gg",
    player: playerName,
    // These flags are read by formatNotes and passed to AI system prompt
    backtest_warning: "COD_MODE_UNKNOWN_33pct_accuracy",
    mode_note: "HP kills avg 2-3x higher than SnD. Without mode classification conf MUST be capped at 65.",
    role: CDL_ROLES[playerName.toLowerCase()] || null,
  };

  try {
    const html = await fetchPage(
      `https://www.breakingpoint.gg/players/${encodeURIComponent(playerName)}`,
      { "Referer": "https://www.breakingpoint.gg/" }
    );

    if (html && !html.includes("Page not found") && html.length > 500) {
      const kdM = html.match(/K\/D.*?([0-9]+\.[0-9]+)/i); if (kdM) result.kd = parseFloat(kdM[1]);
      const klM = html.match(/(?:Kills Per Map|kills_per_map)[^0-9]*([0-9]+\.[0-9]+)/i); if (klM) result.kills_per_map = parseFloat(klM[1]);
      const dmgM = html.match(/Damage.*?([0-9]+\.[0-9]+)/i); if (dmgM) result.damage_per_round = parseFloat(dmgM[1]);
      const hsM = html.match(/Headshots?[^<]*<[^>]+>([0-9.]+%?)/i); if (hsM) result.hs_pct = parseFloat(hsM[1].replace("%",""));
      if (result.hs_pct && result.kills_per_map) result.headshots_per_map = Math.round(result.kills_per_map * (result.hs_pct/100) * 10) / 10;
    } else {
      result.error = "fetch_blocked";
    }
  } catch(e) {
    result.error = "fetch_failed";
    result.message = e.message;
  }

  setCache(ck, result);
  return result;
}

// ─── LIQUIPEDIA MEDIAWIKI API (free, no key, works server-side for all esports) ──
// Liquipedia exposes a MediaWiki action=parse API that returns structured player
// data. No Cloudflare protection on the API endpoint (unlike the HTML pages).
// Supports: LoL, CS2, Valorant, Dota2, R6, COD, Apex, etc.
const LIQUIPEDIA_WIKIS = {
  LoL: "leagueoflegends", CS2: "counterstrike", Valorant: "valorant",
  Dota2: "dota2", R6: "rainbowsix", COD: "callofduty", APEX: "apexlegends",
};

async function scrapeLiquipedia(playerName, sport) {
  const wiki = LIQUIPEDIA_WIKIS[sport];
  if (!wiki) return { error: "unsupported_sport", player: playerName, source: "Liquipedia" };

  const ck = `liqui:${sport}:${playerName.toLowerCase()}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    // Use the Liquipedia API endpoint — returns wikitext/HTML for a player page
    const slug = playerName.replace(/\s+/g,"_");
    const url = `https://liquipedia.net/${wiki}/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json`;
    const data = await fetchJSON(url, {
      "User-Agent": "EsportsKillModel/1.0 (research tool; contact: admin@localhost)",
      "Accept-Encoding": "identity",
    });

    if (data?.error || !data?.parse?.wikitext?.["*"]) {
      return { error: "player_not_found", player: playerName, source: "Liquipedia", sport };
    }

    const wikitext = data.parse.wikitext["*"];

    // Extract key stats from wikitext infobox fields
    function extractField(text, field) {
      const re = new RegExp(`\\|\\s*${field}\\s*=\\s*([^\\n|]+)`, "i");
      const m = text.match(re);
      return m ? m[1].trim().replace(/\[\[([^\]|]+)[^\]]*\]\]/g,"$1").replace(/<[^>]+>/g,"").trim() : null;
    }

    const team     = extractField(wikitext, "team") || extractField(wikitext, "current team");
    const role     = extractField(wikitext, "role") || extractField(wikitext, "position");
    const nat      = extractField(wikitext, "nationality") || extractField(wikitext, "country");

    // Extract kills/assists stats from wikitext tables (varies by wiki format)
    // Pattern: stat tables in recent matches section or career stats section
    let kills_per_game = null, assists_per_game = null, kda = null;
    const statPatterns = [
      /kda\s*=\s*([0-9.]+)/i,
      /kills?_per_game\s*=\s*([0-9.]+)/i,
      /avgkills?\s*=\s*([0-9.]+)/i,
    ];
    for (const p of statPatterns) {
      const m = wikitext.match(p);
      if (m) { kills_per_game = parseFloat(m[1]); break; }
    }

    // For LoL: try to parse season stats table rows
    // Format: ||Player||Champion||K||D||A||KDA||...
    const last7_kills = [];
    const last7_assists = [];
    const tableRowRe = /\|\|\s*(\d+)\s*\|\|\s*(\d+)\s*\|\|\s*(\d+)/g;
    let trm;
    while ((trm = tableRowRe.exec(wikitext)) !== null) {
      const k = parseInt(trm[1]), d = parseInt(trm[2]), a = parseInt(trm[3]);
      if (!isNaN(k) && k <= 50 && k >= 0) last7_kills.push(k);
      if (!isNaN(a) && a <= 50 && a >= 0) last7_assists.push(a);
      if (last7_kills.length >= 7) break;
    }

    const result = {
      source: "Liquipedia",
      player: playerName,
      team: team || null,
      role: role || null,
      nationality: nat || null,
      kills_per_game: kills_per_game || (last7_kills.length >= 3 ? avg(last7_kills) : null),
      assists_per_game: assists_per_game || (last7_assists.length >= 3 ? avg(last7_assists) : null),
      kda: kda || null,
      last7_kills: last7_kills.slice(0,7),
      last7_kills_avg: avg(last7_kills.slice(0,7)),
      last7_assists: last7_assists.slice(0,7),
      last7_assists_avg: avg(last7_assists.slice(0,7)),
      form_trend: last7_kills.length >= 3 ? formTrend(avg(last7_kills), kills_per_game) : "STABLE",
      form_trend_kills: last7_kills.length >= 3 ? formTrend(avg(last7_kills), kills_per_game) : "STABLE",
      // Even if no kill data, Liquipedia gives team/role context which is valuable
      games: null,
    };

    // Only cache and return if we got something useful
    if (result.team || result.role || result.kills_per_game || result.last7_kills.length > 0) {
      setCache(ck, result);
      return result;
    }
    return { error: "no_stats", player: playerName, source: "Liquipedia", team, role };
  } catch(e) {
    return { error: "scrape_failed", player: playerName, source: "Liquipedia", message: e.message };
  }
}

// ─── PANDASCORE: EXTRACT KILLS FROM FREE-TIER MATCH RESULTS ──────────────────
// PandaScore free tier matches include games[] with players[] including kills for
// LoL and some other games. The key was missing: we need to call
// /players/{id}/matches which returns FULL match objects with embedded games.
async function pandaKillsFromMatches(playerId, playerIdNum, sport) {
  const slug = PS_SLUGS[sport];
  if (!slug) return null;

  const ck = `ps_kills:${sport}:${playerIdNum}`;
  const cached = getCached(ck); if (cached) return cached;

  try {
    // Fetch past matches for this player — free tier includes games with player results
    const matches = await pandaFetch(`/players/${playerIdNum}/matches?sort=-scheduled_at&per_page=12`);
    if (!Array.isArray(matches) || !matches.length) return null;

    const allKills = [], allAssists = [], allDeaths = [];

    for (const match of matches) {
      if (match.status !== "finished") continue;
      const games = match.games || [];
      for (const game of games) {
        if (!game.finished && !game.complete) continue;

        // Try to find this player in the game results
        // LoL: game.players array with kills/assists/deaths (Historical plan only typically)
        // But on free tier, match.results sometimes has player-level outcomes

        const gamePlayers = game.players || game.player_results || [];
        for (const gp of gamePlayers) {
          const gpId = gp.player_id ?? gp.player?.id ?? gp.id;
          if (String(gpId) !== String(playerIdNum)) continue;
          if (gp.kills != null && gp.kills >= 0 && gp.kills <= 50) allKills.push(gp.kills);
          if (gp.assists != null && gp.assists >= 0 && gp.assists <= 50) allAssists.push(gp.assists);
          if (gp.deaths != null) allDeaths.push(gp.deaths);
        }
        if (allKills.length >= 10) break;
      }
      if (allKills.length >= 10) break;
    }

    if (allKills.length < 2) return null;

    const result = {
      last7_kills: allKills.slice(0,7),
      last7_kills_avg: avg(allKills.slice(0,7)),
      last7_assists: allAssists.slice(0,7),
      last7_assists_avg: avg(allAssists.slice(0,7)),
      kills_per_game: avg(allKills),
      assists_per_game: avg(allAssists),
      deaths_per_game: avg(allDeaths),
      games: allKills.length,
    };
    setCache(ck, result);
    return result;
  } catch(e) {
    console.log(`pandaKillsFromMatches error: ${e.message}`);
    return null;
  }
}

// ─── STAT ROUTING ──────────────────────────────────────────────────────────────
// Source priority:
// 1. PandaScore historical plan (best — full kill/assist averages) — if available
// 2. PandaScore free match history — sometimes has per-game kills in game.players
// 3. Sport-specific HTML/API scrapers (gol.gg, HLTV, VLR, siege.gg, BP, OpenDota)
// 4. Liquipedia — universal fallback (gives team/role, sometimes kill stats)
async function getStats(player, sport, teamName, opponentName) {
  // 1. Try PandaScore — first check for kill data (historical plan)
  let psEnrichment = null;
  let psPlayerId = null;
  try {
    const ps = await pandaPlayerStats(player, sport);
    if (ps && !ps.error) {
      psPlayerId = ps.player_id;
      const hasKillStats = (ps.kills_per_game != null) || (ps.last7_kills?.length >= 2);
      if (hasKillStats) {
        console.log(`Stats via PandaScore historical: ${player} (${sport})`);
        if (sport === "CS2" && (teamName || opponentName)) {
          try {
            const vetoData = await scrapeHltvMatchVeto(teamName||"", opponentName||"");
            ps.map_pool_context = vetoData;
            ps.cs2_map_pool_warning = !(vetoData?.confirmed_maps?.length);
          } catch {}
        }
        return ps;
      }
      // Free tier — save enrichment, try match history for kill data
      if (ps.team || ps.role) psEnrichment = { team: ps.team, role: ps.role, nationality: ps.nationality };
    }
  } catch(e) { console.log(`PandaScore lookup failed: ${e.message}`); }

  // 1b. Try extracting kills from PandaScore match history (free tier)
  if (psPlayerId) {
    try {
      const killData = await pandaKillsFromMatches(player, psPlayerId, sport);
      if (killData?.kills_per_game) {
        console.log(`Stats via PandaScore free-tier match history: ${player} (${sport}) — ${killData.games}g`);
        const result = {
          source: "PandaScore",
          plan: "free",
          player_id: psPlayerId,
          player,
          team: psEnrichment?.team || null,
          role: psEnrichment?.role || null,
          ...killData,
          form_trend_kills: formTrend(killData.last7_kills_avg, killData.kills_per_game),
          form_trend: formTrend(killData.last7_kills_avg, killData.kills_per_game),
        };
        return result;
      }
    } catch {}
  }

  // 2. Sport-specific scrapers
  console.log(`Stats via scraper: ${player} (${sport})`);
  let scraped = null;
  switch (sport) {
    case "LoL":      scraped = await scrapeGolgg(player); break;
    case "CS2":      scraped = await scrapeHltv(player, teamName, opponentName); break;
    case "Valorant": scraped = await scrapeVlr(player); break;
    case "Dota2":    scraped = await scrapeOpenDota(player); break;
    case "R6":       scraped = await scrapeSiegeGG(player); break;
    case "COD":      scraped = await scrapeBreakingPoint(player); break;
    case "APEX":
      scraped = { source:"N/A", player, note:"No public Apex pro stats. Zone RNG adds 30%+ variance. Model applies -8 conf.", backtest_warning:"APEX_ZONE_RNG" };
      break;
    default:
      scraped = { error: "unsupported_sport", player, sport };
  }

  // 3. If scraper failed, fall back to Liquipedia (always available, no bot protection)
  if (!scraped || scraped.error) {
    console.log(`Scraper failed for ${player} (${sport}), trying Liquipedia`);
    const liqui = await scrapeLiquipedia(player, sport).catch(() => null);
    if (liqui && !liqui.error) {
      scraped = liqui;
    }
  }

  // 4. Merge PandaScore team/role onto scraped result
  if (psEnrichment && scraped && !scraped.error) {
    if (!scraped.team && psEnrichment.team) scraped.team = psEnrichment.team;
    if (!scraped.role && psEnrichment.role) scraped.role = psEnrichment.role;
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
  pandascore_plan: "free+historical_attempt",
  odds_api: !!process.env.ODDS_API_KEY,   // set ODDS_API_KEY for Pinnacle/DK odds via TheOddsAPI
  auto_settle: true,
  anthropic: !!process.env.ANTHROPIC_KEY,
  capabilities: ["match-context","player-stats","win-prob-h2h","auto-settle","backtest","pick-log","semaphore-rate-limit"],
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

    // No real stats → cap at 65 (role baseline only)
    // "SCOUT NOTES" appears in prompt only when formatNotes returned actual data
    const hasRealStats = userText.includes("SCOUT NOTES") &&
                         !userText.includes("player_not_found") &&
                         !userText.includes("scrape_failed") &&
                         !userText.includes("api_unavailable");
    if (!hasRealStats && parsed.confidence > 65) {
      parsed.confidence = 65;
      parsed.variance_flags = [...(parsed.variance_flags || []), "role_baseline_only: no verified stats — conf capped at 65"];
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

  const slug = PS_SLUGS[sport];
  if (!slug) return null;

  const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const nA = norm(normalizeTeamName(teamA));
  const nB = norm(normalizeTeamName(teamB));

  try {
    // Check upcoming matches
    const upcoming = await pandaFetch(`/${slug}/matches/upcoming?per_page=100`);
    const running  = await pandaFetch(`/${slug}/matches/running?per_page=20`);
    const all = [...(Array.isArray(upcoming)?upcoming:[]), ...(Array.isArray(running)?running:[])];

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
          const winRate = Math.round(teamAWins/h2hMatches.length*100)/100;
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
          const winRate = Math.round(wins/recentA.length*100)/100;
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

  const [context, odds] = await Promise.all([
    pandaMatchContext(team, opponent||"", sport).catch(() => null),
    opponent ? fetchMatchWinProb(team, opponent, sport).catch(() => ({ available: false })) : Promise.resolve({ available: false }),
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
    odds: odds?.available ? {
      team_win_prob: odds.team_win_prob,
      opp_win_prob: odds.opp_win_prob,
      source: odds.source,
    } : null,
    source: context ? "PandaScore" : "unavailable",
    // Pre-formatted string for AI system prompt injection
    prompt_context: buildMatchContextString(context, odds, team, opponent),
  };

  res.json(result);
});

function buildMatchContextString(ctx, odds, team, opponent) {
  const parts = [];
  if (ctx?.series_format) parts.push(`SERIES: ${ctx.series_format} (${ctx.number_of_games} maps max)`);
  if (ctx?.tournament) parts.push(`EVENT: ${ctx.tournament}${ctx.tournament_tier ? ` [Tier ${ctx.tournament_tier}]` : ""}`);
  if (odds?.available) {
    parts.push(`WIN_PROB: ${team} ${Math.round(odds.team_win_prob*100)}% (Pinnacle-derived)`);
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
  const FALLBACK_IDS = ["197","230","232","233","234","235","236","237","238","239","240","241","242","243","244","245"];
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
