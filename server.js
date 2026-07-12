/* Écoute Intelligente — serveur local
 * - Récupère métadonnées + sous-titres YouTube (yt-dlp)
 * - Capture image + audio d'un passage (ffmpeg sur URLs de stream, sans télécharger la vidéo)
 * - Crée les cartes Anki via AnkiConnect (decks/modèles auto-créés, médias inclus)
 */
const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ffmpeg-static renvoie un chemin dans app.asar quand l'app est packagée
// (Electron), mais le binaire réel est dépaqueté dans app.asar.unpacked et
// execFile ne traverse pas l'asar : on redirige vers le chemin dépaqueté.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const PORT = +process.env.PORT || 3311;
// Racine INSCRIPTIBLE : en app packagée, __dirname est dans l'asar (lecture
// seule) — Electron fournit alors un dossier utilisateur via EI_DATA_ROOT.
// En mode `node server.js`, on écrit dans le dossier du projet comme avant.
const ROOT = process.env.EI_DATA_ROOT || __dirname;
const CACHE = path.join(ROOT, 'cache');
const DATA = path.join(ROOT, 'data');            // persistance locale (remplace le localStorage fragile)
const STORE = path.join(DATA, 'store.json');
const ANKI_URL = 'http://127.0.0.1:8765';
const DECK_PHRASES = 'Écoute Intelligente::Phrases';
const DECK_MOTS = 'Écoute Intelligente::Mots';
const DECK_THEME = 'Écoute Intelligente::Phrases générées';
const MODEL_PHRASE = 'EI Phrase';
const MODEL_MOT = 'EI Mot';
const MODEL_THEME = 'EI Phrase générée';

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

/* ---------- Store local (progression) : fichier JSON sur disque ----------
 * Remplace le localStorage du navigateur : la progression (XP, série, phrases
 * capturées, phrases générées, police, clé IA…) survit à un vidage de cache et
 * ne dépend plus du navigateur. Chaque valeur est la chaîne localStorage brute. */
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function writeStore(obj) {
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, STORE); // écriture atomique
}

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${(stderr || err.message).slice(0, 600)}`));
      else resolve({ stdout, stderr });
    });
  });
}

let YTDLP = null;
async function ytdlp(args, timeoutMs) {
  if (!YTDLP) {
    for (const cand of [['yt-dlp'], ['python', '-m', 'yt_dlp']]) {
      try { await run(cand[0], [...cand.slice(1), '--version'], 15000); YTDLP = cand; break; } catch {}
    }
    if (!YTDLP) throw new Error("yt-dlp introuvable (pip install yt-dlp)");
  }
  return run(YTDLP[0], [...YTDLP.slice(1), ...args], timeoutMs);
}

/* ---------- Sous-titres ---------- */

function parseJson3(txt) {
  const cues = [];
  for (const ev of (JSON.parse(txt).events || [])) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // json3 : la durée est dans dDurationMs (dDurMs n'existe pas)
    cues.push({ start: ev.tStartMs / 1000, end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000, text });
  }
  // Les sous-titres auto « déroulants » restent affichés pendant le cue suivant :
  // leur durée déborde. On borne la fin de chaque cue au début du suivant pour
  // que la fin d'une phrase colle au moment où la parole suivante démarre.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues;
}

// Regroupe les cues en phrases : coupe sur ponctuation finale, longueur ou silence.
function mergeSentences(cues) {
  const out = [];
  let cur = null;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (!cur) cur = { start: c.start, end: c.end, text: c.text };
    else { cur.text += ' ' + c.text; cur.end = c.end; }
    const next = cues[i + 1];
    const gap = next ? next.start - c.end : 99;
    // Phrases courtes, lisibles d'un coup d'œil sous la vidéo : coupe à la
    // ponctuation finale, à une virgule passé 60 caractères, ou à 90 max.
    const done = /[.!?…]["')\]]?$/.test(cur.text) || cur.text.length > 90 || gap > 2.5
      || (cur.text.length > 60 && /[,;:]$/.test(cur.text));
    if (done) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map(s => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100, text: s.text }));
}

// Timeline mot-à-mot depuis les sous-titres auto (en-orig) : chaque seg porte
// son horodatage précis. Sert à affiner les bornes de découpe audio.
function buildWordTimeline(id) {
  const f = path.join(CACHE, `${id}.en-orig.json3`);
  if (!fs.existsSync(f)) return null;
  try {
    const times = [];
    for (const ev of (JSON.parse(fs.readFileSync(f, 'utf8')).events || [])) {
      if (!ev.segs) continue;
      for (const seg of ev.segs) {
        if ((seg.utf8 || '').trim()) times.push((ev.tStartMs + (seg.tOffsetMs || 0)) / 1000);
      }
    }
    times.sort((a, b) => a - b);
    return times.length ? times : null;
  } catch { return null; }
}

// Bornes audio par phrase : on démarre juste avant son premier mot réel et on
// coupe juste avant le premier mot réel de la phrase suivante (l'écart médian
// entre deux phrases n'est que de ~0,14 s : tout padding fixe déborde).
function refineAudioBounds(sentences, words) {
  if (!words) return;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i], next = sentences[i + 1];
    const first = words.find(t => t >= s.start - 0.3);
    const nextFirst = next ? words.find(t => t >= next.start - 0.1) : null;
    const a = Math.max(0, (first != null ? first : s.start) - 0.2);
    let b = nextFirst != null ? Math.min(nextFirst - 0.05, s.end + 0.35) : s.end + 0.35;
    if (b < a + 0.4) b = a + 0.4;
    s.audioStart = Math.round(a * 100) / 100;
    s.audioEnd = Math.round(b * 100) / 100;
  }
}

async function getVideoInfo(id) {
  const infoFile = path.join(CACHE, `${id}.meta.json`);
  if (fs.existsSync(infoFile)) return JSON.parse(fs.readFileSync(infoFile, 'utf8'));

  const url = `https://www.youtube.com/watch?v=${id}`;
  const { stdout } = await ytdlp([
    '--no-playlist', '--skip-download', '--no-simulate', '-j',
    '--write-subs', '--write-auto-subs', '--sub-langs', 'en,en-orig',
    '--sub-format', 'json3', '-P', CACHE, '-o', '%(id)s', url
  ], 120000);
  const info = JSON.parse(stdout);

  let cues = null;
  for (const lang of ['en', 'en-orig']) {
    const f = path.join(CACHE, `${id}.${lang}.json3`);
    if (fs.existsSync(f)) {
      const parsed = parseJson3(fs.readFileSync(f, 'utf8'));
      if (parsed.length) { cues = parsed; break; }
    }
  }
  if (!cues) throw new Error('Pas de sous-titres anglais pour cette vidéo');

  const sentences = mergeSentences(cues);
  refineAudioBounds(sentences, buildWordTimeline(id));
  const meta = {
    id, title: info.title, channel: info.channel || info.uploader || '',
    duration: info.duration, sentences
  };
  fs.writeFileSync(infoFile, JSON.stringify(meta));
  return meta;
}

/* ---------- Capture image + audio ---------- */

const streamCache = new Map(); // id -> {vurl, aurl, ts}

async function getStreamUrls(id, force = false) {
  const hit = streamCache.get(id);
  if (!force && hit && Date.now() - hit.ts < 2 * 3600 * 1000) return hit;
  const { stdout } = await ytdlp([
    '--no-playlist', '-g',
    '-f', 'b[height<=480][ext=mp4]/b[height<=480]/b,ba[ext=m4a]/ba',
    `https://www.youtube.com/watch?v=${id}`
  ], 60000);
  const lines = stdout.trim().split(/\r?\n/);
  const urls = { vurl: lines[0], aurl: lines[1] || lines[0], ts: Date.now() };
  streamCache.set(id, urls);
  return urls;
}

// audioFrom/audioTo : fenêtre audio EXACTE (padding déjà inclus par l'appelant).
// frameAt : instant du screenshot.
async function captureMedia(id, frameAt, audioFrom, audioTo) {
  const doIt = async (urls) => {
    const jpg = path.join(CACHE, `cap-${id}-${Math.round(audioFrom * 1000)}.jpg`);
    const mp3 = path.join(CACHE, `cap-${id}-${Math.round(audioFrom * 1000)}.mp3`);
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-ss', String(frameAt), '-i', urls.vurl,
      '-frames:v', '1', '-q:v', '3', jpg], 45000);
    await run(ffmpegPath, ['-y', '-loglevel', 'error',
      '-ss', String(audioFrom), '-to', String(audioTo),
      '-i', urls.aurl, '-vn', '-b:a', '96k', mp3], 60000);
    const image = fs.readFileSync(jpg).toString('base64');
    const audio = fs.readFileSync(mp3).toString('base64');
    fs.unlinkSync(jpg); fs.unlinkSync(mp3);
    return { image, audio };
  };
  try { return await doIt(await getStreamUrls(id)); }
  catch { return doIt(await getStreamUrls(id, true)); } // URLs expirées → refresh et on retente
}

/* ---------- Anki ---------- */

async function anki(action, params = {}) {
  const r = await fetch(ANKI_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

const CARD_CSS = `
.card { font-family: Georgia, serif; font-size: 20px; text-align: center;
  color: #2A2520; background: #FBF8F2; padding: 12px; }
img { max-width: 100%; border-radius: 12px; }
.ei-text { font-size: 22px; margin: 14px 0 6px; }
.ei-trad { color: #6F665A; font-size: 17px; font-style: italic; }
.ei-src { color: #9C8F78; font-size: 13px; margin-top: 14px; }
.ei-word { font-size: 30px; color: #C0603A; font-weight: bold; }
.ei-phon { color: #9C8F78; font-size: 16px; }
.ei-def { text-align: left; font-size: 17px; margin: 10px 0; }
.ei-ex { color: #6F665A; font-style: italic; font-size: 16px; }`;

let ankiReady = false;
async function ensureAnki() {
  if (ankiReady) return;
  await anki('createDeck', { deck: DECK_PHRASES });
  await anki('createDeck', { deck: DECK_MOTS });
  await anki('createDeck', { deck: DECK_THEME });
  const models = await anki('modelNames');
  // Carte phrase (thème inversé, demande utilisateur) : recto = traduction
  // française + screenshot ; verso = image + audio (joué automatiquement) +
  // phrase anglaise. La traduction FR n'apparaît qu'au recto (PAS de
  // {{FrontSide}} au verso, sinon elle serait affichée deux fois).
  // updateModelTemplates aligne aussi les cartes déjà créées.
  const PHRASE_FRONT = `<div class="ei-text">{{Translation}}</div>{{Image}}`;
  const PHRASE_BACK = `{{Image}}<hr id="answer">{{Audio}}<div class="ei-text">{{Text}}</div><div class="ei-src">{{Source}}</div>`;
  if (!models.includes(MODEL_PHRASE)) {
    await anki('createModel', {
      modelName: MODEL_PHRASE,
      inOrderFields: ['Image', 'Audio', 'Text', 'Translation', 'Source', 'Url'],
      css: CARD_CSS,
      cardTemplates: [{ Name: 'Écoute', Front: PHRASE_FRONT, Back: PHRASE_BACK }]
    });
  } else {
    await anki('updateModelTemplates', {
      model: { name: MODEL_PHRASE, templates: { 'Écoute': { Front: PHRASE_FRONT, Back: PHRASE_BACK } } }
    });
  }
  // Verso volontairement minimal : uniquement la traduction française (pas de
  // définition ni d'exemple — demande utilisateur), les champs restent stockés.
  const MOT_FRONT = '<div class="ei-word">{{Word}}</div><div class="ei-phon">{{Phonetic}}</div>';
  const MOT_BACK = `{{FrontSide}}<hr id="answer"><div class="ei-trad" style="font-size:24px;font-style:normal">{{Translation}}</div><div class="ei-src">{{Source}}</div>`;
  if (!models.includes(MODEL_MOT)) {
    await anki('createModel', {
      modelName: MODEL_MOT,
      inOrderFields: ['Word', 'Phonetic', 'Definition', 'Translation', 'Example', 'Source'],
      css: CARD_CSS,
      cardTemplates: [{ Name: 'Mot', Front: MOT_FRONT, Back: MOT_BACK }]
    });
  } else {
    // Aligne le modèle déjà présent dans Anki sur le gabarit courant.
    await anki('updateModelTemplates', {
      model: { name: MODEL_MOT, templates: { Mot: { Front: MOT_FRONT, Back: MOT_BACK } } }
    });
  }
  // Phrases générées par l'IA (exercice de thème) : recto = phrase française,
  // verso = traduction anglaise de référence. Dédup Anki sur le 1er champ (Fr).
  if (!models.includes(MODEL_THEME)) {
    await anki('createModel', {
      modelName: MODEL_THEME,
      inOrderFields: ['Fr', 'En', 'Source'],
      css: CARD_CSS,
      cardTemplates: [{
        Name: 'Thème',
        Front: '<div class="ei-text">{{Fr}}</div>',
        Back: `{{FrontSide}}<hr id="answer"><div class="ei-text">{{En}}</div><div class="ei-src">{{Source}}</div>`
      }]
    });
  }
  ankiReady = true;
}

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- Routes ---------- */

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e.message);
  res.status(500).json({ error: e.message });
});

app.get('/api/health', wrap(async (req, res) => {
  let anki_ok = false;
  try { anki_ok = (await anki('version')) >= 6; } catch {}
  res.json({ ok: true, anki: anki_ok });
}));

app.get('/api/video/:id', wrap(async (req, res) => {
  res.json(await getVideoInfo(req.params.id));
}));

// Capture un passage -> carte Anki recto (image+audio) / verso (texte+traduction)
app.post('/api/capture', wrap(async (req, res) => {
  const { videoId, start, end, text, translation, videoTitle } = req.body;
  if (!videoId || start == null || end == null || !text) throw new Error('Paramètres manquants');
  await ensureAnki();
  // Fenêtre audio : bornes affinées mot-à-mot si dispo, sinon padding fixe
  let audioFrom = Math.max(0, +start - 0.25), audioTo = +end + 0.15;
  try {
    const sent = (await getVideoInfo(videoId)).sentences.find(x => Math.abs(x.start - start) < 0.05);
    if (sent && sent.audioStart != null) { audioFrom = sent.audioStart; audioTo = sent.audioEnd; }
  } catch { /* meta indisponible : fallback padding fixe */ }
  const { image, audio } = await captureMedia(videoId, (+start + +end) / 2, audioFrom, audioTo);
  const stamp = `${videoId}-${Math.round(start * 1000)}`;
  const t = Math.floor(start);
  const src = `${videoTitle || videoId} — ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${t}s`;
  let noteId = null, duplicate = false;
  try {
    noteId = await anki('addNote', {
      note: {
        deckName: DECK_PHRASES, modelName: MODEL_PHRASE,
        fields: { Image: '', Audio: '', Text: esc(text), Translation: esc(translation), Source: esc(src), Url: url },
        tags: ['ecoute-intelligente'],
        options: { allowDuplicate: false, duplicateScope: 'deck' },
        picture: [{ data: image, filename: `EI-${stamp}.jpg`, fields: ['Image'] }],
        audio: [{ data: audio, filename: `EI-${stamp}.mp3`, fields: ['Audio'] }]
      }
    });
  } catch (e) {
    if (/duplicate/i.test(e.message)) duplicate = true; else throw e;
  }
  res.json({ noteId, duplicate, image: `data:image/jpeg;base64,${image}` });
}));

// Mot difficile -> carte Anki mot
app.post('/api/word', wrap(async (req, res) => {
  const { word, phonetic, definition, translation, example, videoTitle } = req.body;
  if (!word) throw new Error('Mot manquant');
  await ensureAnki();
  let noteId = null, duplicate = false;
  try {
    noteId = await anki('addNote', {
      note: {
        deckName: DECK_MOTS, modelName: MODEL_MOT,
        fields: {
          Word: esc(word), Phonetic: esc(phonetic), Definition: esc(definition),
          Translation: esc(translation), Example: esc(example), Source: esc(videoTitle)
        },
        tags: ['ecoute-intelligente'],
        options: { allowDuplicate: false, duplicateScope: 'deck' }
      }
    });
  } catch (e) {
    if (/duplicate/i.test(e.message)) duplicate = true; else throw e;
  }
  res.json({ noteId, duplicate });
}));

// Cartes déjà créées (les deux decks), pour la galerie « Mes cartes »
app.get('/api/cards', wrap(async (req, res) => {
  const fetchDeck = async (deck) => {
    const ids = await anki('findNotes', { query: `"deck:${deck}"` });
    if (!ids.length) return [];
    const infos = await anki('notesInfo', { notes: ids });
    return infos.sort((a, b) => b.noteId - a.noteId); // noteId = timestamp de création
  };
  const [phrases, mots] = await Promise.all([fetchDeck(DECK_PHRASES), fetchDeck(DECK_MOTS)]);
  const f = (n, k) => (n.fields[k] ? n.fields[k].value : '');
  res.json({
    phrases: phrases.map(n => ({
      id: n.noteId,
      text: f(n, 'Text'), translation: f(n, 'Translation'),
      source: f(n, 'Source'), url: f(n, 'Url'),
      image: (f(n, 'Image').match(/src="([^"]+)"/) || [])[1] || '',
      audio: (f(n, 'Audio').match(/\[sound:([^\]]+)\]/) || [])[1] || ''
    })),
    mots: mots.map(n => ({
      id: n.noteId,
      word: f(n, 'Word'), phonetic: f(n, 'Phonetic'), definition: f(n, 'Definition'),
      translation: f(n, 'Translation'), example: f(n, 'Example'), source: f(n, 'Source')
    }))
  });
}));

// Captures encore présentes dans Anki pour une vidéo — source de vérité pour
// les coches « déjà capturée » du transcript. Le start de chaque phrase est
// encodé dans le nom du fichier audio (EI-<videoId>-<startMs>.mp3).
app.get('/api/captures/:videoId', wrap(async (req, res) => {
  const vid = req.params.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return res.status(400).json({ error: 'videoId invalide' });
  try {
    const ids = await anki('findNotes', { query: `"deck:${DECK_PHRASES}" "Audio:*EI-${vid}-*"` });
    const starts = [];
    if (ids.length) {
      const infos = await anki('notesInfo', { notes: ids });
      const re = new RegExp(`EI-${vid}-(\\d+)\\.mp3`);
      for (const n of infos) {
        const m = ((n.fields.Audio || {}).value || '').match(re);
        if (m) starts.push(+m[1] / 1000);
      }
    }
    res.json({ ok: true, starts });
  } catch {
    res.json({ ok: false, starts: [] }); // Anki fermé : le client garde son état local
  }
}));

// Supprime une note depuis l'app -> supprimée aussi dans Anki
app.delete('/api/cards/:noteId', wrap(async (req, res) => {
  const id = +req.params.noteId;
  if (!Number.isFinite(id) || id <= 0) throw new Error('noteId invalide');
  await anki('deleteNotes', { notes: [id] });
  res.json({ ok: true });
}));

// Sert un média stocké dans Anki (image/audio des cartes)
const mediaCache = new Map();
app.get('/api/media/:filename', wrap(async (req, res) => {
  const name = req.params.filename;
  if (!/^EI-[\w.-]+\.(jpg|mp3)$/.test(name)) return res.status(400).end();
  let buf = mediaCache.get(name);
  if (!buf) {
    const b64 = await anki('retrieveMediaFile', { filename: name });
    if (!b64) return res.status(404).end();
    buf = Buffer.from(b64, 'base64');
    if (mediaCache.size > 300) mediaCache.clear();
    mediaCache.set(name, buf);
  }
  res.set('Content-Type', name.endsWith('.jpg') ? 'image/jpeg' : 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
}));

// Proxy générique AnkiConnect (stats, recherches...)
app.post('/api/anki', wrap(async (req, res) => {
  res.json({ result: await anki(req.body.action, req.body.params || {}) });
}));

// --- Proxy LM Studio (modèle local) ---
// LM Studio ne renvoie pas d'en-têtes CORS : un fetch direct depuis le
// navigateur est bloqué. On relaie donc serveur→serveur (pas de CORS). URL
// restreinte au localhost par sécurité.
function isLocalUrl(u) {
  try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '::1'; }
  catch { return false; }
}
app.post('/api/lm/chat', wrap(async (req, res) => {
  const { url, payload } = req.body || {};
  if (!isLocalUrl(url)) throw new Error('URL LM Studio invalide (doit être locale)');
  let r;
  try {
    r = await fetch(url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
  } catch { throw new Error('LM Studio injoignable — lance-le et active « Local Server »'); }
  res.status(r.status).type('application/json').send(await r.text());
}));
app.get('/api/lm/models', wrap(async (req, res) => {
  const url = req.query.url;
  if (!isLocalUrl(url)) throw new Error('URL LM Studio invalide (doit être locale)');
  let r;
  try { r = await fetch(url.replace(/\/+$/, '') + '/models'); }
  catch { throw new Error('LM Studio injoignable'); }
  res.status(r.status).type('application/json').send(await r.text());
}));

// Phrase générée (exercice de thème) -> carte Anki Fr/En
app.post('/api/sentence', wrap(async (req, res) => {
  const { fr, en } = req.body;
  if (!fr || !en) throw new Error('fr et en requis');
  await ensureAnki();
  let noteId = null, duplicate = false;
  try {
    noteId = await anki('addNote', {
      note: {
        deckName: DECK_THEME, modelName: MODEL_THEME,
        fields: { Fr: esc(fr), En: esc(en), Source: 'Exercice — phrase générée' },
        tags: ['ecoute-intelligente', 'theme'],
        options: { allowDuplicate: false, duplicateScope: 'deck' }
      }
    });
  } catch (e) {
    if (/duplicate/i.test(e.message)) duplicate = true; else throw e;
  }
  res.json({ noteId, duplicate });
}));

// --- Persistance de la progression (store local) ---
// GET : renvoie tout le store. POST : applique un patch (clé -> valeur ;
// valeur null = suppression), fusionné dans le fichier.
app.get('/api/state', wrap(async (req, res) => {
  res.json(readStore());
}));
app.post('/api/state', wrap(async (req, res) => {
  const store = readStore();
  const patch = req.body || {};
  for (const k of Object.keys(patch)) {
    if (patch[k] == null) delete store[k];
    else store[k] = patch[k];
  }
  writeStore(store);
  res.json({ ok: true });
}));

// Démarre le serveur ; résout avec l'instance http (utilisé par Electron).
function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      console.log(`Écoute Intelligente → http://localhost:${port}`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { app, startServer, PORT, parseJson3, mergeSentences, refineAudioBounds, buildWordTimeline };
