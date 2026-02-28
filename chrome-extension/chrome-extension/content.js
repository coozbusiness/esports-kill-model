// Runs in ISOLATED world - bridges between page (MAIN world) and background
(function() {
  if (window.__killModelBridgeLoaded) return;
  window.__killModelBridgeLoaded = true;

  console.log('[Kill Model Extension] Loaded — watching for PrizePicks API calls');

  window.addEventListener('__killModelData', (event) => {
    const { projections, url } = event.detail;
    if (!projections || !projections.data) return;

    const count = projections.data.length;
    const leagues = (projections.included || []).filter(i => i.type === 'league');

    console.log(`[Kill Model] Captured ${count} props from ${url}`);

    chrome.runtime.sendMessage({
      type: 'PRIZEPICKS_DATA',
      projections,
      leagues,
      url,
      count,
      esportsCount: count,
    }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.count > 0) {
        showIndicator(count);
      }
    });
  });

  function showIndicator(count) {
    const existing = document.getElementById('kill-model-indicator');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'kill-model-indicator';
    el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:linear-gradient(135deg,#0a1a0a,#060e06);border:1px solid #4ade8066;border-radius:9px;padding:10px 15px;z-index:2147483647;font-family:monospace;font-size:11px;color:#4ade80;box-shadow:0 4px 24px rgba(0,0,0,0.6);cursor:pointer;letter-spacing:0.5px;';
    el.textContent = `⚡ Kill Model: ${count} props captured — click extension icon to send`;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 6000);
  }
})();
