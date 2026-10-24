// Pont entre la page Écoute Intelligente et l'extension : une page web ne peut pas appeler
// l'extension directement, elle passe par window.postMessage.
document.documentElement.dataset.eiExt = chrome.runtime.getManifest().version;

window.addEventListener('message', async e => {
  if (e.source !== window || !e.data || e.data.source !== 'ei-page') return;
  // Seuls ces trois types passent, sans champ « target » (réservé au service de l'extension).
  const { target, ...msg } = e.data.msg || {};
  let res;
  if (!['anki', 'status', 'record'].includes(msg.type)) res = { error: 'type refusé' };
  else {
    try { res = await chrome.runtime.sendMessage(msg); }
    catch (err) { res = { error: err.message }; }
  }
  window.postMessage({ source: 'ei-ext', id: e.data.id, res }, location.origin);
});

// Capture activée / coupée (clic sur l'icône, onglet fermé…).
chrome.runtime.onMessage.addListener(m => {
  if (m && m.type === 'capture-state') window.postMessage({ source: 'ei-ext', event: 'capture-state', on: m.on }, location.origin);
});
