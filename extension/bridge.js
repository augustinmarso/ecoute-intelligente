// Pont entre la page Écoute Intelligente et l'extension : une page web ne peut pas appeler
// l'extension directement, elle passe par window.postMessage.
document.documentElement.dataset.eiExt = chrome.runtime.getManifest().version;

window.addEventListener('message', async e => {
  if (e.source !== window || !e.data || e.data.source !== 'ei-page') return;
  let res;
  try { res = await chrome.runtime.sendMessage(e.data.msg); }
  catch (err) { res = { error: err.message }; }
  window.postMessage({ source: 'ei-ext', id: e.data.id, res }, location.origin);
});

// Capture activée / coupée (clic sur l'icône, onglet fermé…).
chrome.runtime.onMessage.addListener(m => {
  if (m && m.type === 'capture-state') window.postMessage({ source: 'ei-ext', event: 'capture-state', on: m.on }, location.origin);
});
