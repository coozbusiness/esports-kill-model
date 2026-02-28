// Runs in MAIN world (same as page JS) at document_start
// Patches fetch BEFORE PrizePicks app code runs
(function() {
  if (window.__killModelPatched) return;
  window.__killModelPatched = true;

  const _fetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const res = await _fetch(input, init);

    if (url && url.includes('api.prizepicks.com') && url.includes('projection')) {
      try {
        const clone = res.clone();
        clone.json().then(data => {
          if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
            // Post to content script via custom event
            window.dispatchEvent(new CustomEvent('__killModelData', {
              detail: { projections: data, url }
            }));
          }
        }).catch(() => {});
      } catch(e) {}
    }
    return res;
  };

  // Also patch XMLHttpRequest
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__url = url;
    return _XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const url = this.__url || '';
    if (url.includes('api.prizepicks.com') && url.includes('projection')) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
            window.dispatchEvent(new CustomEvent('__killModelData', {
              detail: { projections: data, url }
            }));
          }
        } catch(e) {}
      });
    }
    return _XHRSend.apply(this, arguments);
  };
})();
