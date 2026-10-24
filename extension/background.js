// Relais entre le site (bridge.js), l'enregistreur de l'onglet (offscreen.html) et Anki.
const ANKI = 'http://127.0.0.1:8765';

// Le site n'a accès qu'à ses propres decks, modèles et médias dans Anki (liste blanche) :
// une page piégée ne peut ni lire tes autres cartes, ni lire des fichiers du PC, ni rien supprimer d'autre.
const EI_DECK = /^Écoute Intelligente::/;
const EI_MODEL = /^EI /;
const EI_FILE = /^_?ei-[\w.-]+$/i;
const SITE_MEDIA = /^https:\/\/augustinmarso\.github\.io\/ecoute-intelligente\/videos\//;
const FONT_URL = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@fontsource\//;
const READ_ONLY = new Set(['version', 'modelNames', 'findNotes', 'findCards', 'notesInfo']);

async function ankiRaw(action, params = {}) {
  const r = await fetch(ANKI, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
  return r.json();
}

async function ankiSafe(body) {
  const action = body && body.action, p = (body && body.params) || {};
  const refuse = why => ({ result: null, error: `Action Anki refusée (${action}) : ${why}` });
  if (READ_ONLY.has(action)) {
    const d = await ankiRaw(action, p);
    if (action === 'notesInfo' && Array.isArray(d.result)) d.result = d.result.filter(n => EI_MODEL.test(n.modelName || ''));
    return d;
  }
  switch (action) {
    case 'createDeck': if (!EI_DECK.test(p.deck || '')) return refuse('deck'); break;
    case 'createModel': if (!EI_MODEL.test(p.modelName || '')) return refuse('modèle'); break;
    case 'retrieveMediaFile': if (!EI_FILE.test(p.filename || '')) return refuse('fichier'); break;
    case 'storeMediaFile':
      if (!EI_FILE.test(p.filename || '') || p.path || (p.url && !FONT_URL.test(p.url))) return refuse('fichier');
      break;
    case 'addNote': {
      const n = p.note || {};
      if (!EI_DECK.test(n.deckName || '') || !EI_MODEL.test(n.modelName || '')) return refuse('deck');
      const files = [...(n.picture || []), ...(n.audio || []), ...(n.video || [])];
      if (files.some(f => f.path || !EI_FILE.test(f.filename || '') || (f.url && !SITE_MEDIA.test(f.url)))) return refuse('média');
      break;
    }
    case 'deleteNotes': {
      const ids = Array.isArray(p.notes) ? p.notes : [];
      const infos = (await ankiRaw('notesInfo', { notes: ids })).result || [];
      if (!ids.length || infos.length !== ids.length || infos.some(n => !EI_MODEL.test(n.modelName || ''))) return refuse('note');
      break;
    }
    default: return refuse('non autorisée');
  }
  return ankiRaw(action, p);
}

// Chrome n'autorise la capture d'un onglet qu'après un geste sur l'extension :
// un clic sur l'icône active la capture image + son pour l'onglet courant.
chrome.action.onClicked.addListener(async tab => {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, tabId: tab.id });
    if (r && r.error) throw new Error(r.error);
    chrome.action.setBadgeBackgroundColor({ color: '#FF5A5F' });
    chrome.action.setBadgeText({ tabId: tab.id, text: 'ON' });
    chrome.tabs.sendMessage(tab.id, { type: 'capture-state', on: true }).catch(() => {});
  } catch (e) {
    console.error(e);
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
  }
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['USER_MEDIA'],
    justification: "Enregistrer l'image et le son de la phrase capturée"
  });
}

async function captureTab() {
  if (!(await chrome.offscreen.hasDocument())) return null;
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' });
  return r && r.tabId;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target === 'offscreen') return;
  (async () => {
    if (msg.type === 'anki') return ankiSafe(msg.body);
    if (msg.type === 'status') return { on: (await captureTab()) === sender.tab.id };
    if (msg.type === 'record') {
      if ((await captureTab()) !== sender.tab.id) return { error: 'inactive' };
      const durationMs = Math.min(30000, Math.max(0, +msg.durationMs || 0)); // une phrase, pas un enregistrement sans fin
      return chrome.runtime.sendMessage({
        target: 'offscreen', type: 'record', durationMs,
        frameAtMs: Math.min(durationMs, Math.max(0, +msg.frameAtMs || 0)), rect: msg.rect, viewport: msg.viewport
      });
    }
    if (msg.type === 'stopped' && !sender.tab) { // envoyé par offscreen.js quand l'onglet n'est plus capturé
      chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
      chrome.tabs.sendMessage(msg.tabId, { type: 'capture-state', on: false }).catch(() => {});
      return {};
    }
    return { error: 'type inconnu : ' + msg.type };
  })().then(reply, e => reply({ error: e.message }));
  return true; // réponse asynchrone
});
