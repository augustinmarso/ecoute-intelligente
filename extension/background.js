// Relais entre le site (bridge.js), l'enregistreur de l'onglet (offscreen.html) et Anki.
const ANKI = 'http://127.0.0.1:8765';

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
    if (msg.type === 'anki') {
      const r = await fetch(ANKI, { method: 'POST', body: JSON.stringify(msg.body) });
      return r.json();
    }
    if (msg.type === 'status') return { on: (await captureTab()) === sender.tab.id };
    if (msg.type === 'record') {
      if ((await captureTab()) !== sender.tab.id) return { error: 'inactive' };
      return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
    }
    if (msg.type === 'stopped') { // envoyé par offscreen.js quand l'onglet n'est plus capturé
      chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
      chrome.tabs.sendMessage(msg.tabId, { type: 'capture-state', on: false }).catch(() => {});
      return {};
    }
    return { error: 'type inconnu : ' + msg.type };
  })().then(reply, e => reply({ error: e.message }));
  return true; // réponse asynchrone
});
