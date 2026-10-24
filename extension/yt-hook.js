// Dans le lecteur YouTube intégré au site : récupère les sous-titres que le lecteur télécharge
// lui-même (YouTube refuse de les donner à qui n'est pas son lecteur) et les transmet au site.
(() => {
  const SITE = /^https:\/\/augustinmarso\.github\.io$|^http:\/\/[a-z0-9-]+\.localhost(:\d+)?$/;
  const parent = location.ancestorOrigins && location.ancestorOrigins[0];
  if (!parent || !SITE.test(parent)) return; // lecteur intégré ailleurs : on ne touche à rien

  // Les sous-titres incrustés font doublon avec la phrase affichée par le site.
  const style = document.createElement('style');
  style.textContent = '.ytp-caption-window-container { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);

  const send = (url, text) => {
    try {
      const u = new URL(url, location.href);
      if (!u.pathname.includes('/api/timedtext') || u.searchParams.get('tlang') || !text) return;
      window.parent.postMessage({
        source: 'ei-yt', videoId: u.searchParams.get('v'), lang: u.searchParams.get('lang') || '',
        kind: u.searchParams.get('kind') || '', text
      }, parent);
    } catch {}
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try { send(String(url), typeof this.response === 'string' ? this.response : JSON.stringify(this.response)); } catch {}
      });
    }
    return open.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (url && url.includes('/api/timedtext')) res.clone().text().then(t => send(url, t), () => {});
    } catch {}
    return res;
  };
})();
