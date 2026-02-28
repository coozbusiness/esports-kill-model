// ─── CONTENT SCRIPT ──────────────────────────────────────────────────────────
// Runs on app.prizepicks.com
// Patches window.fetch to intercept projections API response
// Sends data to background service worker

(function() {
  'use strict';

  // Avoid double-injection
  if (window.__killModelInjected) return;
  window.__killModelInjected = true;

  const originalFetch = window.fetch;

  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const response = await originalFetch.apply(this, args);

    // Intercept projections endpoint
    if (url.includes('prizepicks.com') && url.includes('projection')) {
      try {
        const clone = response.clone();
        clone.json().then(data => {
          if (data?.data && Array.isArray(data.data)) {
            // Send to background
            chrome.runtime.sendMessage({
              type: 'PRIZEPICKS_DATA',
              projections: data,
              leagues: data.included?.filter(i => i.type === 'league') || [],
              url,
            }, (response) => {
              if (chrome.runtime.lastError) return; // Extension might be updating
              if (response?.esportsCount > 0) {
                showCaptureIndicator(response.esportsCount);
              }
            });
          }
        }).catch(() => {});
      } catch (e) {}
    }

    return response;
  };

  // Also intercept XMLHttpRequest for older API calls
  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return XHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && this._url.includes('prizepicks.com') && this._url.includes('projection')) {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          if (data?.data && Array.isArray(data.data)) {
            chrome.runtime.sendMessage({
              type: 'PRIZEPICKS_DATA',
              projections: data,
              leagues: data.included?.filter(i => i.type === 'league') || [],
              url: this._url,
            }, () => { if (chrome.runtime.lastError) {} });
          }
        } catch (e) {}
      });
    }
    return XHRSend.apply(this, args);
  };

  // Visual indicator when data is captured
  function showCaptureIndicator(count) {
    // Remove existing
    const existing = document.getElementById('kill-model-indicator');
    if (existing) existing.remove();

    const indicator = document.createElement('div');
    indicator.id = 'kill-model-indicator';
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: linear-gradient(135deg, #1a2a1a, #0a1a0a);
      border: 1px solid #4ade8060;
      border-radius: 8px;
      padding: 10px 14px;
      z-index: 999999;
      font-family: monospace;
      font-size: 11px;
      color: #4ade80;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      cursor: pointer;
      transition: all 0.2s;
    `;
    indicator.innerHTML = `⚡ Kill Model: ${count} esports props captured — click to send`;
    indicator.addEventListener('click', () => {
      indicator.innerHTML = '◌ Sending to Kill Model…';
      chrome.runtime.sendMessage({ type: 'GET_LATEST' }, (data) => {
        if (data?.projections) {
          // Open kill model app with data
          chrome.storage.local.get(['killModelUrl'], (result) => {
            const appUrl = result.killModelUrl || 'https://esports-kill-model.vercel.app';
            // Store data for app to pick up
            chrome.storage.local.set({ pendingImport: data.projections }, () => {
              window.open(appUrl, '_blank');
              indicator.innerHTML = '✓ Opened Kill Model — paste ready';
              setTimeout(() => indicator.remove(), 3000);
            });
          });
        }
      });
    });

    document.body.appendChild(indicator);

    // Auto-hide after 8 seconds
    setTimeout(() => {
      if (indicator.parentNode) indicator.style.opacity = '0';
      setTimeout(() => indicator.remove(), 500);
    }, 8000);
  }

  console.log('[Kill Model Extension] Loaded — watching for PrizePicks API calls');
})();
