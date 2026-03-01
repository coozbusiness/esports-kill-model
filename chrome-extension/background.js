let latestTimestamp = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRIZEPICKS_DATA") {
    const incoming = message.projections;
    const incomingIds = new Set((incoming.data || []).map(p => p.id));

    // Merge with existing — keep existing props that aren't in this batch, add new ones
    chrome.storage.local.get(['projections'], (stored) => {
      const existing = stored.projections;
      let merged;

      if (existing && existing.data && Array.isArray(existing.data)) {
        // Keep existing props not in this batch + all incoming props
        const kept = existing.data.filter(p => !incomingIds.has(p.id));
        merged = {
          ...incoming,
          data: [...kept, ...(incoming.data || [])],
          included: [
            ...(existing.included || []),
            ...(incoming.included || []).filter(i => {
              const existingIds = new Set((existing.included || []).map(x => x.id + x.type));
              return !existingIds.has(i.id + i.type);
            })
          ]
        };
      } else {
        merged = incoming;
      }

      const count = merged.data.length;
      chrome.storage.local.set({
        projections: merged,
        timestamp: new Date().toISOString(),
        count,
        esportsCount: count,
      });

      console.log(`[Kill Model] Merged — now ${count} total props (added ${incoming.data?.length || 0} from ${message.url})`);
      sendResponse({ ok: true, count, esportsCount: count });
    });
    return true; // async response
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
