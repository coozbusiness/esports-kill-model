// Runs in MAIN world at document_start — patches fetch/XHR before PrizePicks code runs
(function() {
  if (window.__killModelPatched) return;
  window.__killModelPatched = true;

  function maybeCapture(url, data) {
    if (!url || !data?.data || !Array.isArray(data.data) || data.data.length === 0) return;
    // Capture ANY projection-like response from prizepicks API
    if (!url.includes("prizepicks.com")) return;
    if (!url.includes("proj") && !url.includes("pick") && !url.includes("lineup") && !url.includes("prop")) return;
    window.dispatchEvent(new CustomEvent("__killModelData", { detail: { projections: data, url } }));
  }

  // ─── FETCH INTERCEPTOR ─────────────────────────────────────────────────────
  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const res = await _fetch(input, init);

    // Capture projections and ANY esports-looking API call
    if (url.includes("prizepicks.com")) {
      try {
        res.clone().json().then(data => {
          maybeCapture(url, data);
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
    if ((this.__url || "").includes("prizepicks.com")) {
      this.addEventListener("load", () => {
        try {
          const data = JSON.parse(this.responseText);
          maybeCapture(this.__url, data);
        } catch(e) {}
      });
    }
    return _send.apply(this, arguments);
  };
})();
