// Runs in MAIN world at document_start — patches fetch/XHR before PrizePicks code runs
(function() {
  if (window.__killModelPatched) return;
  window.__killModelPatched = true;

  // ─── FETCH INTERCEPTOR ─────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const res = await _fetch(input, init);

    if (url.includes("api.prizepicks.com") && url.includes("projection")) {
      try {
        res.clone().json().then(data => {
          if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
            window.dispatchEvent(new CustomEvent("__killModelData", { detail: { projections: data, url } }));
          }
        }).catch(() => {});
      } catch(e) {}
    }
    return res;
  };

  // ─── XHR INTERCEPTOR ──────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__url = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if ((this.__url||"").includes("api.prizepicks.com") && (this.__url||"").includes("projection")) {
      this.addEventListener("load", () => {
        try {
          const data = JSON.parse(this.responseText);
          if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
            window.dispatchEvent(new CustomEvent("__killModelData", { detail: { projections: data, url: this.__url } }));
          }
        } catch(e) {}
      });
    }
    return _send.apply(this, arguments);
  };

  // ─── AUTO-CAPTURE: click all esports tabs in sequence ─────────────────────
  // Waits for page to load, then finds and clicks each sport tab one at a time
  // Each click triggers PrizePicks to fire a new API request which we intercept above

  function autoCapture() {
    // PrizePicks esports tab labels we want to capture
    // Exhaustive list of every tab label PrizePicks could use:
    // game names, abbreviations, region codes, league/circuit names, tournament organizers
    const ESPORTS_TABS = [

      // ── LEAGUE OF LEGENDS ──────────────────────────────────────────────────
      "League of Legends", "LOL", "LoL", "Lol",
      // Regional leagues (2025: LCK, LPL, LEC, LTA, LCP)
      "LCK",  // Korea
      "LPL",  // China
      "LEC",  // EMEA
      "LCS",  // North America (returns 2026; still shown on PrizePicks)
      "LTA",  // Americas (2025 merged league)
      "LCP",  // Asia-Pacific (2025 new league: PCS+VCS+LJL+LCO)
      "CBLOL",// Brazil
      "LLA",  // Latin America
      "PCS",  // Pacific Championship Series
      "VCS",  // Vietnam
      "LJL",  // Japan
      // International events
      "Worlds", "World Championship",
      "MSI", "Mid-Season Invitational",
      "First Stand",
      "LCK CL",   // Challengers Korea
      "NACL",     // NA Challengers

      // ── VALORANT ─────────────────────────────────────────────────────────
      "Valorant", "VAL", "VCT", "Champions Tour",
      // Regions
      "VCT Americas", "VCT EMEA", "VCT Pacific", "VCT CN", "VCT China",
      "AMER", "EMEA", "Pacific", "PAC",
      // International events
      "Valorant Champions", "Masters Bangkok", "Masters Toronto",
      "Masters Madrid", "Masters Berlin", "Masters Reykjavik",
      "Masters Shanghai", "Masters",
      // Challengers
      "Challengers", "Ascension",
      // Short codes PrizePicks might use
      "VALM", "VCT AM", "VCT EU", "VCT PAC",

      // ── COUNTER-STRIKE 2 ─────────────────────────────────────────────────
      "Counter-Strike", "CS2", "CSGO", "CS:GO",
      // Tournament organizers (all run CS2 events on PrizePicks)
      "ESL", "BLAST", "PGL", "IEM",
      "ESL Pro League",
      "IEM Katowice", "IEM Cologne", "IEM Dallas", "IEM Rio",
      "IEM Chengdu", "IEM Atlanta",
      "BLAST Premier", "BLAST Open", "BLAST Rivals", "BLAST Bounty",
      "PGL Major", "PGL Bucharest", "PGL Cluj", "PGL Belgrade",
      "StarLadder",
      "Pro League",  // ESL Pro League shorthand

      // ── DOTA 2 ───────────────────────────────────────────────────────────
      "Dota 2", "Dota2", "DOTA", "DOTA2",
      // Tournaments
      "The International", "TI",
      "DreamLeague",
      "ESL One",
      "PGL Wallachia",
      "BLAST Slam",
      "FISSURE",
      "EPT", // ESL Pro Tour
      // Regions PrizePicks may use as tab labels
      "Dota",

      // ── RAINBOW SIX SIEGE ────────────────────────────────────────────────
      "Rainbow Six", "Rainbow 6", "R6", "Siege", "R6S",
      // Regional leagues
      "EUL",   // Europe League
      "NAL",   // North America League
      "BR6",   // Brazil League
      "SAL",   // South America League
      "APL",   // Asia-Pacific League
      "EML",   // Europe MENA League
      "NAL",   // North America League
      "Six Invitational", "Six Major", "SI",
      "R6 Share",
      "RE:LO:AD", "Reload",
      // PrizePicks may show these league names verbatim
      "Rainbow Six Siege",

      // ── CALL OF DUTY ─────────────────────────────────────────────────────
      "Call of Duty", "COD", "CDL", "Call of Duty League",
      "Black Ops", "BO6",
      "CDL Major", "CDL Champs", "CDL Championship",
      "Challengers",   // CDL Challengers (may appear as tab)

      // ── APEX LEGENDS ─────────────────────────────────────────────────────
      "Apex Legends", "Apex", "APEX", "ALGS",
      "Apex Legends Global Series",
      "Pro League",    // ALGS Pro League
      "ALGS Championship", "ALGS Open",
      // ALGS regions
      "Americas",       // ALGS Americas
      "APAC North", "APAC South",
    ];

    // Find all clickable tab/category elements on the page
    function findEsportsTabs() {
      const candidates = [];
      // PrizePicks uses various selectors for sport tabs
      const selectors = [
        "button", "a", "[role='tab']", "[class*='league']",
        "[class*='sport']", "[class*='tab']", "[class*='category']"
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const text = (el.textContent || el.innerText || el.getAttribute("aria-label") || "").trim();
          if (ESPORTS_TABS.some(tab => text.toLowerCase().includes(tab.toLowerCase()))) {
            // Avoid duplicates
            if (!candidates.some(c => c.el === el)) {
              candidates.push({ el, text });
            }
          }
        });
      }
      return candidates;
    }

    let tabsFound = [];
    let capturedTotal = 0;
    let tabsProcessed = 0;

    function clickNextTab(idx) {
      if (idx >= tabsFound.length) {
        // All done — notify background
        window.dispatchEvent(new CustomEvent("__killModelAutoCaptureComplete", {
          detail: { total: capturedTotal, tabs: tabsProcessed }
        }));
        // Show completion toast
        showToast(`⚡ Auto-capture done: ${capturedTotal} props across ${tabsProcessed} sport tabs`);
        return;
      }

      const { el, text } = tabsFound[idx];
      console.log(`[Kill Model] Clicking tab: ${text}`);
      el.click();
      tabsProcessed++;

      // Wait for API response (2.5s per tab — generous for slow connections)
      setTimeout(() => clickNextTab(idx + 1), 2500);
    }

    // Wait for page to be ready, then find and click all tabs
    function start() {
      tabsFound = findEsportsTabs();
      if (tabsFound.length === 0) {
        console.log("[Kill Model] No esports tabs found — browsing manually will still capture");
        return;
      }
      console.log(`[Kill Model] Found ${tabsFound.length} esports tabs — auto-capturing all...`);
      showToast(`⚡ Auto-capturing ${tabsFound.length} esports tabs...`);
      clickNextTab(0);
    }

    // Track how many props we've captured so far
    window.addEventListener("__killModelData", () => { capturedTotal++; });

    // Start after page fully loads
    if (document.readyState === "complete") {
      setTimeout(start, 2000);
    } else {
      window.addEventListener("load", () => setTimeout(start, 2000));
    }
  }

  function showToast(msg) {
    const existing = document.getElementById("__km_toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "__km_toast";
    el.style.cssText = "position:fixed;bottom:24px;right:24px;background:linear-gradient(135deg,#0a1a0a,#060e06);border:1px solid #4ade8066;border-radius:9px;padding:11px 16px;z-index:2147483647;font-family:monospace;font-size:11px;color:#4ade80;box-shadow:0 4px 24px rgba(0,0,0,0.7);letter-spacing:0.5px;transition:opacity 0.4s;";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 400); }, 7000);
  }

  // Only auto-capture on the main PrizePicks app page
  if (window.location.hostname === "app.prizepicks.com") {
    autoCapture();
  }
})();
