// ─── BACKGROUND SERVICE WORKER ───────────────────────────────────────────────
// Intercepts PrizePicks API calls and stores the projections data
// Then pushes it to the kill model app when available

let latestProjections = null;
let latestLeagues = null;
let latestTimestamp = null;

// ─── INTERCEPT PRIZEPICKS API ─────────────────────────────────────────────────
// PrizePicks loads projections from: https://api.prizepicks.com/projections
// We intercept the response using a declarativeNetRequest approach via content script
// The content script patches fetch() on the page and messages us with the data

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRIZEPICKS_DATA") {
    latestProjections = message.projections;
    latestLeagues = message.leagues;
    latestTimestamp = new Date().toISOString();

    const count = message.projections?.data?.length || 0;
    const esportsCount = countEsportsProps(message.projections);

    // Store in chrome.storage for popup access
    chrome.storage.local.set({
      projections: message.projections,
      leagues: message.leagues,
      timestamp: latestTimestamp,
      count,
      esportsCount,
    });

    // Show notification
    if (esportsCount > 0) {
      chrome.notifications.create("pp-capture", {
        type: "basic",
        iconUrl: "icon48.png",
        title: "PrizePicks Captured",
        message: `${esportsCount} esports props ready — click extension to send to Kill Model`,
      });
    }

    console.log(`[Kill Model] Captured ${count} props (${esportsCount} esports)`);
    sendResponse({ ok: true, count, esportsCount });
  }

  if (message.type === "GET_LATEST") {
    chrome.storage.local.get(["projections", "leagues", "timestamp", "count", "esportsCount"], (data) => {
      sendResponse(data);
    });
    return true; // async response
  }

  if (message.type === "CLEAR") {
    chrome.storage.local.clear();
    latestProjections = null;
    latestLeagues = null;
    latestTimestamp = null;
    sendResponse({ ok: true });
  }
});

// Count how many props are esports-related
function countEsportsProps(data) {
  if (!data?.included) return 0;
  const esportsSlugs = ["league-of-legends", "counter-strike", "valorant", "dota-2", "rainbow-six", "call-of-duty", "apex-legends"];
  const leagues = data.included.filter(item =>
    item.type === "league" &&
    esportsSlugs.some(slug => (item.attributes?.name || "").toLowerCase().includes(slug) ||
    (item.attributes?.sport || "").toLowerCase().includes(slug) ||
    (item.id || "").toLowerCase().includes(slug))
  );
  return leagues.length > 0 ? (data.data?.length || 0) : 0;
}

// ─── OPEN KILL MODEL WHEN EXTENSION ICON CLICKED ─────────────────────────────
chrome.action.onClicked.addListener(() => {
  // This is only triggered if no popup — with popup defined in manifest this won't fire
});
