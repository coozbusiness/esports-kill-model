// ─── ESPORTS STATS SCRAPER FOR CHROME EXTENSION ──────────────────────────────
// Runs inside the extension — bypasses all Cloudflare/bot protection because
// extension fetch has host_permissions and uses the user's real browser headers.
//
// Strategy: scrape TEAM ROSTER PAGES not individual players
//   ~60 teams × 1 request = ~30s total vs 1000+ players × individual = 30min
//   24h cache in chrome.storage — next day near-instant (only new teams scraped)
//
// Sources by sport:
//   CS2      → HLTV team stats page   (Rating, KPR, ADR, KAST, HS%)
//   Valorant → VLR.gg team stats page (ACS, K/map, ADR, HS%, FK)
//   LoL      → gol.gg team stats      (K/D/A, KDA, role)
//   COD      → BreakingPoint.gg       (K/map, K/D, SnD kills)
//   R6       → siege.gg               (K/map, K/D, HS%, KOST)
//   Dota2    → OpenDota API            (kills/game from recent matches)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─── HLTV — CS2 ──────────────────────────────────────────────────────────────
// HLTV blocks server IPs (Cloudflare) but allows extension fetches.
// Team stats page: hltv.org/stats/teams/players/{id}/{slug}?startDate=...
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

async function getHltvSlug(teamName) {
  const key = s(teamName);
  // Check hardcoded first
  if (HLTV_TEAMS[key]) return HLTV_TEAMS[key];
  // Partial match on hardcoded
  for (const [k, slug] of Object.entries(HLTV_TEAMS)) {
    if (key.includes(k.slice(0,5)) || k.includes(key.slice(0,5))) return slug;
  }
  // Check slug cache
  const cached = await csGet(`hslug::${key}`);
  if (isFresh(cached, SLUG_TTL) && cached.slug) return cached.slug;
  // Search HLTV rankings
  try {
    const html = await xFetch('https://www.hltv.org/ranking/teams', 8000);
    const re = /\/team\/(\d+)\/([a-z0-9-]+)/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const slug = m[2].replace(/-/g,'');
      if (slug.includes(key.slice(0,5)) || key.includes(slug.slice(0,5))) {
        const full = `${m[1]}/${m[2]}`;
        await csSet(`hslug::${key}`, { slug: full, ts: Date.now() });
        return full;
      }
    }
  } catch {}
  return null;
}

async function scrapeHltvTeam(teamName) {
  const slugPath = await getHltvSlug(teamName);
  if (!slugPath) return null;

  const d90   = new Date(Date.now() - 90*24*3600*1000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  const url   = `https://www.hltv.org/stats/teams/players/${slugPath}?startDate=${d90}&endDate=${today}`;

  let html;
  try { html = await xFetch(url); }
  catch(e) { console.warn('[KM HLTV]', teamName, e.message); return null; }

  const result = {};

  // HLTV team stats table rows — each row is a player
  // Columns: Player | Maps | Rounds | K/D | KAST | Rating | DPR | Impact | ADR | KAST(%)
  const rowRe = /<tr[^>]*class="[^"]*teamstats-content[^"]*"[^>]*>([\s\S]*?)<\/tr>|<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1] || m[2];
    if (!row.includes('/stats/players/')) continue;

    const nameM = /\/stats\/players\/(\d+)\/([a-z0-9-]+)[^>]*>([^<]{2,30})</i.exec(row);
    if (!nameM) continue;
    const playerSlug = nameM[2];
    const playerName = nameM[3].trim();
    if (!playerName || playerName.length < 2) continue;

    const cells = parseRows(`<table><tr>${row}</tr></table>`)[0] || [];
    if (cells.length < 5) continue;

    // Rating is a reliable fallback — HLTV 1.0 = ~0.679 KPR, 25r/map → ~17 k/map
    // Find rating: usually index 5 or 6 (after K/D which is #3 or #4)
    let rating = null, kd = null, kast = null, adr = null;
    for (let i = 0; i < cells.length; i++) {
      const v = pf(cells[i]);
      if (v == null) continue;
      if (v >= 0.50 && v <= 2.50 && rating == null) rating = v;      // Rating range
      if (v >= 0.30 && v <= 3.50 && kd   == null && i >= 2) kd = v; // K/D range
      if (cells[i].includes('%') && v > 0 && v <= 100) kast = v;
      if (v > 40 && v < 150 && adr == null) adr = v; // ADR range
    }

    if (!rating && !kd) continue;

    const kpr = rating ? rating * 0.679 : (kd ? kd * 0.4 : null);
    const kills_per_map = kpr ? Math.round(kpr * 25 * 10) / 10 : null;

    result[playerName] = {
      source: 'HLTV',
      player: playerName,
      rating, kd, kast, adr,
      kpr: kpr ? Math.round(kpr*100)/100 : null,
      kills_per_map,
      hltv_player_slug: playerSlug,
    };
  }

  // Fallback: try simpler table parse if above found nothing
  if (!Object.keys(result).length) {
    const rows2 = parseRows(html);
    for (const cells of rows2) {
      if (cells.length < 4) continue;
      const name = cells[0];
      if (!name || name.length < 2 || name.includes(' ') === false && name.length > 20) continue;
      const rating = pf(cells[4]) || pf(cells[5]);
      if (!rating || rating < 0.5 || rating > 2.5) continue;
      const kpr = rating * 0.679;
      result[name] = {
        source: 'HLTV', player: name,
        rating, kills_per_map: Math.round(kpr * 25 * 10) / 10,
        kpr: Math.round(kpr*100)/100,
        adr: pf(cells[8]) || pf(cells[7]),
      };
    }
  }

  if (Object.keys(result).length)
    console.log(`[KM HLTV] ${teamName}: ${Object.keys(result).length} players scraped`);
  return Object.keys(result).length ? result : null;
}

// Individual HLTV player — used when team is unknown
async function scrapeHltvPlayer(playerName) {
  const d90   = new Date(Date.now() - 90*24*3600*1000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  try {
    const listHtml = await xFetch(
      `https://www.hltv.org/stats/players?startDate=${d90}&endDate=${today}&rankingFilter=Top50`
    );
    const re = /href="\/stats\/players\/(\d+)\/([^"]+)"[^>]*>\s*([^<]+)\s*</gi;
    let m, pid = null, slug = null;
    while ((m = re.exec(listHtml)) !== null) {
      if (s(m[3]) === s(playerName)) { pid = m[1]; slug = m[2]; break; }
    }
    if (!pid) return null;

    const html = await xFetch(
      `https://www.hltv.org/stats/players/${pid}/${slug}?startDate=${d90}&endDate=${today}`
    );
    const stats = {};
    const statRe = /summaryStatBreakdownName[^>]*>([^<]+)<[\s\S]*?summaryStatBreakdownVal[^>]*>([^<]+)</gi;
    while ((m = statRe.exec(html)) !== null) stats[m[1].trim()] = m[2].trim();

    const rating = pf(stats['Rating 2.0'] || stats['Rating']);
    const kpr    = pf(stats['KPR']);
    const adr    = pf(stats['ADR']);
    const hsRaw  = stats['HS%'] || stats['Headshot %'];
    const hs_pct = hsRaw ? pf(hsRaw.replace('%','')) : null;
    const kast   = stats['KAST'] || null;

    if (!rating && !kpr) return null;
    return {
      source: 'HLTV', player: playerName, rating,
      kpr: kpr || (rating ? Math.round(rating*0.679*100)/100 : null),
      kills_per_map: kpr ? Math.round(kpr*25*10)/10 : (rating ? Math.round(rating*0.679*25*10)/10 : null),
      adr, hs_pct, kast,
    };
  } catch(e) { return null; }
}

// ─── VLR.GG — Valorant ───────────────────────────────────────────────────────
// Team stats URL: vlr.gg/stats?type=players&timespan=90d&team_id={id}
// All-stats URL (full leaderboard): vlr.gg/stats?type=players&timespan=90d

const VLR_TEAMS = {
  'sentinels':     '2',    'sen':        '2',
  'loud':          '4404', 
  'paperrex':      '1001', 'prx':        '1001',
  'nrg':           '4532',
  'cloud9':        '576',  'c9':         '576',
  'liquid':        '12',   'teamliquid': '12',
  'fnatic':        '1',
  'g2':            '6',    'g2esports':  '6',
  'vitality':      '4541', 'teamvitality': '4541',
  'evilegenius':   '7',    'eg':         '7',
  'drx':           '1014',
  't1':            '2',
  'geng':          '4534', 'gen.g':      '4534',
  'optic':         '14',
  'mibr':          '4407',
  'leviatan':      '4484',
  'xset':          '3',
  'kru':           '4408',
  '100thieves':    '19',   '100t':       '19',
  'faze':          '4550',
  'bilibiligaming':'4534',
};

async function getVlrTeamId(teamName) {
  const key = s(teamName);
  if (VLR_TEAMS[key]) return VLR_TEAMS[key];
  for (const [k, id] of Object.entries(VLR_TEAMS)) {
    if (key.includes(k.slice(0,4)) || k.includes(key.slice(0,4))) return id;
  }
  const cached = await csGet(`vslug::${key}`);
  if (isFresh(cached, SLUG_TTL) && cached.id) return cached.id;
  try {
    const html = await xFetch(`https://www.vlr.gg/search/?q=${encodeURIComponent(teamName)}&type=teams`, 8000);
    const m = /href="\/team\/(\d+)\/[^"]+"/i.exec(html);
    if (m) {
      await csSet(`vslug::${key}`, { id: m[1], ts: Date.now() });
      return m[1];
    }
  } catch {}
  return null;
}

async function scrapeVlrTeam(teamName) {
  const teamId = await getVlrTeamId(teamName);
  const url = teamId
    ? `https://www.vlr.gg/stats/?type=players&timespan=90d&team_id=${teamId}`
    : `https://www.vlr.gg/stats/?type=players&timespan=90d`;

  let html;
  try { html = await xFetch(url); }
  catch(e) { console.warn('[KM VLR]', teamName, e.message); return null; }

  return parseVlrStatsHtml(html, null);
}

// Parse VLR stats table — synchronous, works for both team-filtered and full leaderboard
function parseVlrStatsHtml(html, playerFilter) {
  const result = {};
  const rows = parseRows(html);
  for (const cells of rows) {
    if (cells.length < 6) continue;
    // VLR columns: Player | Org | Rounds | Rating | ACS | K | D | A | KD | KAST | ADR | HS% | FK | FD
    const name = cells[0].split('\n')[0].replace(/\s+/g,' ').trim();
    if (!name || name.length < 2 || name.length > 30) continue;
    if (playerFilter && !s(name).includes(s(playerFilter)) && !s(playerFilter).includes(s(name).slice(0,4))) continue;

    const rating = pf(cells[3]);
    const acs    = pf(cells[4]);
    const kpm    = pf(cells[5]);
    const dpm    = pf(cells[6]);
    const apm    = pf(cells[7]);
    // KAST usually col 9, ADR col 10, HS% col 11 — but varies by VLR layout version
    const kast   = cells[9]  || cells[8]  || null;
    const adr    = pf(cells[10]) || pf(cells[9]);
    const hs     = pf((cells[11]||'').replace('%','')) || pf((cells[10]||'').replace('%',''));
    const fk     = pf(cells[12]) || pf(cells[11]);

    if (!acs && !kpm && !rating) continue;

    result[name] = {
      source: 'VLR', player: name,
      rating, acs, kills_per_map: kpm,
      deaths_per_map: dpm, assists_per_map: apm,
      adr, hs_pct: hs, fk_per_map: fk, kast,
    };
    if (playerFilter && Object.keys(result).length >= 1) break; // found our player
  }
  return result;
}

async function scrapeVlrAllStats(playerName) {
  try {
    const html = await xFetch('https://www.vlr.gg/stats/?type=players&timespan=90d');
    const result = parseVlrStatsHtml(html, playerName);
    if (playerName) return result[playerName] || null;
    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

// ─── GOL.GG — League of Legends ──────────────────────────────────────────────

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
  const key  = s(teamName);
  let slug   = GOLGG_TEAMS[key];
  if (!slug) {
    for (const [k, v] of Object.entries(GOLGG_TEAMS)) {
      if (key.includes(k.slice(0,4)) || k.includes(key.slice(0,4))) { slug = v; break; }
    }
  }
  if (!slug) {
    const cached = await csGet(`gslug::${key}`);
    if (isFresh(cached, SLUG_TTL) && cached.slug) slug = cached.slug;
  }
  if (!slug) slug = teamName.replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-]/g,'');

  try {
    const html = await xFetch(`https://gol.gg/teams/${slug}/statistics/season/`);
    const result = {};
    const rows = parseRows(html);
    for (const cells of rows) {
      if (cells.length < 6) continue;
      // gol.gg: Player | Role | GP | W% | KDA | K | D | A | CS | Gold | KP%
      const name = cells[0].trim();
      if (!name || name.length < 2 || name.includes('Player') || name.includes('Name')) continue;
      const games = pi(cells[2]);
      const kda   = pf(cells[4]);
      const kpg   = pf(cells[5]);
      const dpg   = pf(cells[6]);
      const apg   = pf(cells[7]);
      if (!kpg && !kda) continue;
      const role  = cells[1]?.trim() || null;
      result[name] = {
        source: 'gol.gg', player: name,
        games, kda, kills_per_game: kpg, deaths_per_game: dpg,
        assists_per_game: apg, role,
        // LoL series totals — PP counts MAPS 1-3 Kills (series total not per game)
        // kills_per_game here = kills per map for LoL
        kills_per_map: kpg,
      };
    }
    const count = Object.keys(result).length;
    if (count) console.log(`[KM gol.gg] ${teamName}: ${count} players`);
    return count ? result : null;
  } catch(e) {
    console.warn('[KM gol.gg]', teamName, e.message);
    return null;
  }
}

// ─── BREAKINGPOINT — COD ─────────────────────────────────────────────────────

const BP_TEAMS = {
  'atlantafaze':   'atlanta-faze',   'atlf':       'atlanta-faze',
  'opticgaming':   'optic-texas',    'optic':      'optic-texas',
  'oprictexas':    'optic-texas',
  'dallaempire':   'dallas-empire',  'dal':        'dallas-empire',
  'losangelesfaze':'los-angeles-faze','lafaze':    'los-angeles-faze',
  'bostonbreach':  'boston-breach',  'bos':        'boston-breach',
  'seattlesurge':  'seattle-surge',  'sea':        'seattle-surge',
  'torontoultra':  'toronto-ultra',  'tor':        'toronto-ultra',
  'minnesotarokkr':'minnesota-rokkr','rokkr':      'minnesota-rokkr',
  'newyorksubliners':'new-york-subliners','nysl':  'new-york-subliners',
  'losangeleslegion':'los-angeles-legion','lal':   'los-angeles-legion',
  'lasvegas':      'las-vegas-legion','lv':        'las-vegas-legion',
};

async function scrapeBreakingPointTeam(teamName) {
  const key  = s(teamName);
  const slug = BP_TEAMS[key] || Object.entries(BP_TEAMS).find(([k])=>key.includes(k.slice(0,5)))?.[1]
              || teamName.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  try {
    const html = await xFetch(`https://www.breakingpoint.gg/teams/${slug}`);
    const result = {};
    const rows = parseRows(html);
    for (const cells of rows) {
      if (cells.length < 4) continue;
      const name = cells[0].trim();
      if (!name || name.length < 2) continue;
      const kpg = pf(cells[2]) || pf(cells[3]);
      const kd  = pf(cells[4]) || pf(cells[3]);
      if (!kpg && !kd) continue;
      result[name] = {
        source: 'BreakingPoint', player: name,
        kills_per_map: kpg, kills_per_game: kpg, kd,
        snd_kills: pf(cells[5]) || null,
      };
    }
    const count = Object.keys(result).length;
    if (count) console.log(`[KM BP] ${teamName}: ${count} players`);
    return count ? result : null;
  } catch(e) { return null; }
}

// ─── SIEGE.GG — R6 ───────────────────────────────────────────────────────────
async function scrapeSiegeGGTeam(teamName) {
  const slug = teamName.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  try {
    const html = await xFetch(`https://siege.gg/competitions/teams/${slug}`);
    const result = {};
    const rows = parseRows(html);
    for (const cells of rows) {
      if (cells.length < 4) continue;
      const name = cells[0].trim();
      if (!name || name.length < 2) continue;
      const kpg = pf(cells[2]);
      if (!kpg) continue;
      result[name] = {
        source: 'siege.gg', player: name,
        kills_per_map: kpg, kills_per_game: kpg,
        kd: pf(cells[3]),
        kost: cells[4] || null,
        hs_pct: pf((cells[5]||'').replace('%','')),
      };
    }
    return Object.keys(result).length ? result : null;
  } catch { return null; }
}

// ─── OPENDOTA — Dota2 ────────────────────────────────────────────────────────
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
