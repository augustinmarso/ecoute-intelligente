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
// Aucune balise dans les champs : le site échappe tout son texte et Anki insère lui-même image et son.
const HAS_TAG = /</;

// Modèles de cartes : définis ICI, jamais repris de la page (mêmes gabarits que server.js et
// public/static-api.js — garder les trois alignés).
const CARD_CSS = `
@font-face { font-family: "EIAtkinson"; src: url("_ei-atkinson-400.woff2"); font-weight: 400; font-style: normal; }
@font-face { font-family: "EIAtkinson"; src: url("_ei-atkinson-700.woff2"); font-weight: 700; font-style: normal; }
.card { font-family: "EIAtkinson", "Atkinson Hyperlegible", "Segoe UI", Arial, sans-serif;
  font-size: 21px; line-height: 1.55; letter-spacing: .01em; text-align: center;
  color: #2A2520; background: #FBF8F2; padding: 12px; }
img { max-width: 100%; border-radius: 12px; }
.ei-text { font-size: 22px; margin: 14px 0 6px; }
.ei-trad { color: #6F665A; font-size: 18px; }
.ei-src { color: #9C8F78; font-size: 13px; margin-top: 14px; }
.ei-word { font-size: 30px; color: #C0603A; font-weight: bold; }
.ei-phon { color: #9C8F78; font-size: 16px; }
.ei-def { text-align: left; font-size: 17px; margin: 10px 0; }
.ei-ex { color: #6F665A; font-style: italic; font-size: 16px; }`;
const MODELS = {
  'EI Phrase': { inOrderFields: ['Image', 'Audio', 'Text', 'Translation', 'Source', 'Url'], cardTemplates: [{ Name: 'Écoute',
    Front: '<div class="ei-text">{{Translation}}</div>{{Image}}',
    Back: '{{FrontSide}}<hr id="answer">{{Audio}}<div class="ei-text">{{Text}}</div><div class="ei-src">{{Source}}</div>' }] },
  'EI Mot': { inOrderFields: ['Word', 'Phonetic', 'Definition', 'Translation', 'Example', 'Source'], cardTemplates: [{ Name: 'Mot',
    Front: '<div class="ei-word">{{Word}}</div><div class="ei-phon">{{Phonetic}}</div>',
    Back: '{{FrontSide}}<hr id="answer"><div class="ei-trad" style="font-size:24px;font-style:normal">{{Translation}}</div><div class="ei-src">{{Source}}</div>' }] },
  'EI Phrase générée': { inOrderFields: ['Fr', 'En', 'Source'], cardTemplates: [{ Name: 'Thème',
    Front: '<div class="ei-text">{{Fr}}</div>',
    Back: '{{FrontSide}}<hr id="answer"><div class="ei-text">{{En}}</div><div class="ei-src">{{Source}}</div>' }] }
};

async function ankiRaw(action, params = {}) {
  const r = await fetch(ANKI, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
  return r.json();
}

async function ankiSafe(body) {
  const action = body && body.action, p = (body && body.params) || {};
  const refuse = why => ({ result: null, error: `Action Anki refusée (${action}) : ${why}` });
  if (READ_ONLY.has(action)) {
    const d = await ankiRaw(action, p);
    // Résultats limités aux cartes de l'app : une recherche libre ne révèle rien du reste d'Anki.
    if (action === 'notesInfo' && Array.isArray(d.result)) d.result = d.result.filter(n => EI_MODEL.test(n.modelName || ''));
    if (action === 'findNotes' && Array.isArray(d.result) && d.result.length) {
      const infos = (await ankiRaw('notesInfo', { notes: d.result })).result || [];
      d.result = infos.filter(n => EI_MODEL.test(n.modelName || '')).map(n => n.noteId);
    }
    if (action === 'findCards' && Array.isArray(d.result) && d.result.length) {
      const infos = (await ankiRaw('cardsInfo', { cards: d.result })).result || [];
      d.result = infos.filter(c => EI_DECK.test((c.deckName || '') + '::') || EI_MODEL.test(c.modelName || '')).map(c => c.cardId);
    }
    return d;
  }
  switch (action) {
    case 'createDeck': if (!EI_DECK.test(p.deck || '')) return refuse('deck'); break;
    case 'createModel': {
      const m = MODELS[p.modelName];
      if (!m) return refuse('modèle');
      return ankiRaw('createModel', { modelName: p.modelName, css: CARD_CSS, ...m });
    }
    case 'retrieveMediaFile': if (!EI_FILE.test(p.filename || '')) return refuse('fichier'); break;
    case 'storeMediaFile':
      if (!EI_FILE.test(p.filename || '') || p.path || (p.url && !FONT_URL.test(p.url))) return refuse('fichier');
      break;
    case 'addNote': {
      const n = p.note || {};
      if (!EI_DECK.test(n.deckName || '') || !MODELS[n.modelName]) return refuse('deck');
      if (Object.values(n.fields || {}).some(v => HAS_TAG.test(String(v)))) return refuse('contenu');
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
