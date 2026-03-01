(function() {
  if (window.__killModelBridgeLoaded) return;
  window.__killModelBridgeLoaded = true;

  console.log("[Kill Model] Content script loaded");

  // ─── PROP CAPTURE ──────────────────────────────────────────────────────────
  window.addEventListener("__killModelData", (event) => {
    const { projections, url } = event.detail;
    if (!projections?.data) return;

    const count = projections.data.length;

    function trySend(attempts) {
      try {
        chrome.runtime.sendMessage({ type: "PRIZEPICKS_DATA", projections, url, count }, (response) => {
          if (chrome.runtime.lastError) {
            if (attempts > 0) setTimeout(() => trySend(attempts - 1), 600);
            return;
          }
          if (response?.count > 0) showIndicator(response.count);
        });
      } catch(e) {
        if (attempts > 0) setTimeout(() => trySend(attempts - 1), 600);
      }
    }
    trySend(3);
  });

  // ─── AUTO-CAPTURE COMPLETE ────────────────────────────────────────────────
  window.addEventListener("__killModelAutoCaptureComplete", (event) => {
    const { total, tabs } = event.detail;
    chrome.runtime.sendMessage({ type: "AUTO_CAPTURE_DONE", total, tabs });
  });

  function showIndicator(count) {
    const existing = document.getElementById("kill-model-indicator");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "kill-model-indicator";
    el.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#0a1a0a,#060e06);border:1px solid #4ade8066;border-radius:9px;padding:9px 16px;z-index:2147483647;font-family:monospace;font-size:11px;color:#4ade80;box-shadow:0 4px 24px rgba(0,0,0,0.7);letter-spacing:0.5px;white-space:nowrap;";
    el.textContent = `⚡ ${count} esports props ready — click extension to send`;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity 0.4s"; setTimeout(() => el.remove(), 400); }, 5000);
  }
})();
