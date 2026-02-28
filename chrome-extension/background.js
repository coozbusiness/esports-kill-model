let latestTimestamp = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRIZEPICKS_DATA") {
    const count = message.projections?.data?.length || 0;

    chrome.storage.local.set({
      projections: message.projections,
      timestamp: new Date().toISOString(),
      count,
      esportsCount: count, // treat all captured props as valid
    });

    console.log(`[Kill Model] Captured ${count} props from ${message.url}`);
    sendResponse({ ok: true, count, esportsCount: count });
  }

  if (message.type === "GET_LATEST") {
    chrome.storage.local.get(["projections", "timestamp", "count", "esportsCount"], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (message.type === "CLEAR") {
    chrome.storage.local.clear();
    sendResponse({ ok: true });
  }
});
