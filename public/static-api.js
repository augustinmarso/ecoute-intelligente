// =============================================================
// static-api.js — Version en ligne (GitHub Pages), sans serveur.
// Chargé EN PREMIER. Hors localhost, remplace les routes /api/* du serveur
// (server.js) par leur équivalent dans le navigateur :
// - vidéos : transcript + image/son de chaque phrase préparés par GitHub
//   Actions (scripts/prepare-video.js) dans videos/ ;
// - Anki : joint directement via AnkiConnect (127.0.0.1:8765), à condition
//   d'avoir ajouté l'adresse du site dans « webCorsOriginList » d'AnkiConnect.
// Avec l'extension Chrome (dossier extension/) : n'importe quelle vidéo s'ouvre sans
// préparation (sous-titres récupérés dans le lecteur YouTube), la capture enregistre
// l'image et le son de l'onglet, et Anki est joint par l'extension (aucun réglage).
// En local (npm start / app de bureau), ce fichier ne fait rien.
// =============================================================
(function () {
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  window.EI_STATIC = true;

  const ISSUES = 'https://github.com/augustinmarso/ecoute-intelligente/issues/new';
  const ANKI_URL = 'http://127.0.0.1:8765';
  const DECK_PHRASES = 'Écoute Intelligente::Phrases';
  const DECK_MOTS = 'Écoute Intelligente::Mots';
  const DECK_THEME = 'Écoute Intelligente::Phrases générées';
  const MODEL_PHRASE = 'EI Phrase';
  const MODEL_MOT = 'EI Mot';
  const MODEL_THEME = 'EI Phrase générée';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const _fetch = window.fetch.bind(window);

  /* ---------- Extension Chrome (bridge.js pose data-ei-ext sur <html>) ---------- */
  const hasExt = () => !!document.documentElement.dataset.eiExt;
  let extSeq = 0;
  const extWaiting = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'ei-ext' || !extWaiting.has(e.data.id)) return;
    extWaiting.get(e.data.id)(e.data.res || {});
    extWaiting.delete(e.data.id);
  });
  function extCall(msg) {
    const id = ++extSeq;
    return new Promise(resolve => {
      extWaiting.set(id, resolve);
      window.postMessage({ source: 'ei-page', id, msg }, location.origin);
    });
  }

  async function anki(action, params = {}) {
    let d;
    if (hasExt()) {
      d = await extCall({ type: 'anki', body: { action, version: 6, params } });
      if (d.error && !('result' in d) && /fetch/i.test(d.error)) throw new Error('Anki injoignable : ouvre Anki (avec AnkiConnect).');
    } else {
      let r;
      try {
        r = await _fetch(ANKI_URL, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
      } catch {
        throw new Error("Anki injoignable : ouvre Anki et ajoute « " + location.origin + " » dans webCorsOriginList d'AnkiConnect (ou installe l'extension)");
      }
      d = await r.json();
    }
    if (d.error) throw new Error(d.error);
    return d.result;
  }

  /* ---------- Sous-titres -> phrases (même logique que server.js) ---------- */
  function parseJson3(txt) {
    const cues = [];
    for (const ev of (JSON.parse(txt).events || [])) {
      if (!ev.segs) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      cues.push({ start: ev.tStartMs / 1000, end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000, text });
    }
    for (let i = 0; i < cues.length - 1; i++) if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    return cues;
  }
  function mergeSentences(cues) {
    const out = [];
    let cur = null;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (!cur) cur = { start: c.start, end: c.end, text: c.text };
      else { cur.text += ' ' + c.text; cur.end = c.end; }
      const next = cues[i + 1];
      const gap = next ? next.start - c.end : 99;
      const done = /[.!?…]["')\]]?$/.test(cur.text) || cur.text.length > 90 || gap > 2.5
        || (cur.text.length > 60 && /[,;:]$/.test(cur.text));
      if (done) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out.map(s => ({ start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100, text: s.text }));
  }
  function wordTimeline(txt) { // sous-titres auto : horodatage de chaque mot
    const times = [];
    for (const ev of (JSON.parse(txt).events || [])) {
      for (const seg of (ev.segs || [])) if ((seg.utf8 || '').trim()) times.push((ev.tStartMs + (seg.tOffsetMs || 0)) / 1000);
    }
    return times.sort((a, b) => a - b);
  }
  function refineAudioBounds(sentences, words) {
    if (!words.length) return;
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

  // Ouvre la vidéo dans un petit lecteur invisible, sous-titres anglais activés : le lecteur
  // télécharge les sous-titres et l'extension (yt-hook.js) nous les transmet.
  async function liveMeta(id) {
    for (let i = 0; !(window.YT && window.YT.Player) && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    if (!(window.YT && window.YT.Player)) throw new Error('Lecteur YouTube indisponible');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:180px;opacity:0.01;pointer-events:none;z-index:-1';
    host.appendChild(document.createElement('div'));
    document.body.appendChild(host);
    let player, onMsg, timer;
    try {
      const subs = new Promise((resolve, reject) => {
        onMsg = e => {
          const d = e.data;
          if (!d || d.source !== 'ei-yt' || d.videoId !== id || !/^en/.test(d.lang)) return;
          try { if ((JSON.parse(d.text).events || []).length) resolve(d); } catch {}
        };
        window.addEventListener('message', onMsg);
        timer = setTimeout(() => reject(new Error('pas de sous-titres anglais')), 20000);
      });
      const ready = new Promise(resolve => {
        player = new YT.Player(host.firstChild, {
          videoId: id, width: 320, height: 180,
          playerVars: { autoplay: 1, mute: 1, controls: 0, cc_load_policy: 1, cc_lang_pref: 'en', hl: 'en' },
          events: { onReady: e => {
            e.target.mute(); e.target.playVideo();
            try { e.target.loadModule('captions'); e.target.setOption('captions', 'track', { languageCode: 'en' }); } catch {}
            resolve();
          } }
        });
      });
      const [d] = await Promise.all([subs, ready]);
      const sentences = mergeSentences(parseJson3(d.text));
      if (d.kind === 'asr') refineAudioBounds(sentences, wordTimeline(d.text));
      const info = player.getVideoData ? player.getVideoData() : {};
      return { id, title: info.title || id, channel: info.author || '', duration: player.getDuration ? player.getDuration() : 0, sentences, live: true };
    } finally {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      try { player && player.destroy(); } catch {}
      host.remove();
    }
  }

  // Mêmes modèles de cartes que server.js (ensureAnki) — garder les deux alignés.
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
  const EI_FONTS = [
    { filename: '_ei-atkinson-400.woff2', url: 'https://cdn.jsdelivr.net/npm/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2' },
    { filename: '_ei-atkinson-700.woff2', url: 'https://cdn.jsdelivr.net/npm/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2' }
  ];
  const PHRASE_FRONT = `<div class="ei-text">{{Translation}}</div>{{Image}}`;
  const PHRASE_BACK = `{{FrontSide}}<hr id="answer">{{Audio}}<div class="ei-text">{{Text}}</div><div class="ei-src">{{Source}}</div>`;
  const MOT_FRONT = '<div class="ei-word">{{Word}}</div><div class="ei-phon">{{Phonetic}}</div>';
  const MOT_BACK = `{{FrontSide}}<hr id="answer"><div class="ei-trad" style="font-size:24px;font-style:normal">{{Translation}}</div><div class="ei-src">{{Source}}</div>`;

  let ankiReady = false;
  async function ensureAnki() {
    if (ankiReady) return;
    for (const deck of [DECK_PHRASES, DECK_MOTS, DECK_THEME]) await anki('createDeck', { deck });
    for (const f of EI_FONTS) {
      try { if (!(await anki('retrieveMediaFile', { filename: f.filename }))) await anki('storeMediaFile', f); } catch {}
    }
    const models = await anki('modelNames');
    if (!models.includes(MODEL_PHRASE)) {
      await anki('createModel', { modelName: MODEL_PHRASE, inOrderFields: ['Image', 'Audio', 'Text', 'Translation', 'Source', 'Url'],
        css: CARD_CSS, cardTemplates: [{ Name: 'Écoute', Front: PHRASE_FRONT, Back: PHRASE_BACK }] });
    }
    if (!models.includes(MODEL_MOT)) {
      await anki('createModel', { modelName: MODEL_MOT, inOrderFields: ['Word', 'Phonetic', 'Definition', 'Translation', 'Example', 'Source'],
        css: CARD_CSS, cardTemplates: [{ Name: 'Mot', Front: MOT_FRONT, Back: MOT_BACK }] });
    }
    if (!models.includes(MODEL_THEME)) {
      await anki('createModel', { modelName: MODEL_THEME, inOrderFields: ['Fr', 'En', 'Source'], css: CARD_CSS,
        cardTemplates: [{ Name: 'Thème', Front: '<div class="ei-text">{{Fr}}</div>',
          Back: `{{FrontSide}}<hr id="answer"><div class="ei-text">{{En}}</div><div class="ei-src">{{Source}}</div>` }] });
    }
    ankiReady = true;
  }

  async function addNote(note) {
    try { return { noteId: await anki('addNote', { note }), duplicate: false }; }
    catch (e) { if (/duplicate/i.test(e.message)) return { noteId: null, duplicate: true }; throw e; }
  }

  const metas = new Map(); // id -> meta déjà chargée (préparée ou lue en direct)
  async function videoMeta(id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Lien YouTube invalide');
    if (metas.has(id)) return metas.get(id);
    // no-store : GitHub Pages met les 404 en cache 10 min, la vidéo doit apparaître dès qu'elle est prête.
    const r = await _fetch(`videos/${id}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) { const m = await r.json(); metas.set(id, m); return m; }
    let why = '';
    if (hasExt()) {
      try { const m = await liveMeta(id); metas.set(id, m); return m; }
      catch (e) { why = ` (extension : ${e.message})`; }
    }
    setTimeout(() => offerPrepare(id), 500); // après l'affichage du message d'erreur par app.js
    throw new Error("Cette vidéo n'est pas encore prête : il faut la préparer une fois sur GitHub (2 à 3 minutes)." + why);
  }

  // Capture en direct (vidéo non préparée) : on rejoue la phrase et l'extension enregistre
  // l'image et le son de l'onglet.
  async function liveCapture(videoId, s) {
    const st = await extCall({ type: 'status' });
    if (!st.on) throw new Error("clique une fois sur l'icône de l'extension Écoute Intelligente (en haut à droite de Chrome) pour autoriser l'image et le son, puis recapture");
    const p = ytPlayer;
    const from = s.audioStart != null ? s.audioStart : Math.max(0, s.start - 0.25);
    const to = s.audioEnd != null ? s.audioEnd : s.end + 0.15;
    const btn = document.getElementById('btn-capture');
    btn.style.visibility = 'hidden'; // sinon il apparaît sur l'image
    try {
      p.seekTo(Math.max(0, from - 0.1), true);
      p.playVideo();
      for (let i = 0; i < 50 && !(p.getPlayerState() === 1 && p.getCurrentTime() >= from - 0.3); i++) await new Promise(r => setTimeout(r, 100));
      const cur = p.getCurrentTime();
      const box = document.querySelector('.yt-wrap').getBoundingClientRect();
      const res = await extCall({
        type: 'record',
        durationMs: Math.max(500, (to - cur) * 1000),
        frameAtMs: ((s.start + s.end) / 2 - cur) * 1000,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
      if (res.error === 'inactive') throw new Error("la capture a été coupée : reclique sur l'icône de l'extension");
      if (res.error) throw new Error(res.error);
      return res;
    } finally {
      btn.style.visibility = '';
    }
  }

  // Vidéo pas encore prête. Avec le jeton GitHub du propriétaire (collé une fois, gardé dans ce
  // navigateur), le site lance lui-même la préparation (workflow « Site »). Sans jeton : bouton qui
  // ouvre une issue pré-remplie. Dans les deux cas, le site guette la vidéo et l'ouvre dès qu'elle est en ligne.
  const TOKEN_KEY = 'ei-gh-token';
  const DISPATCH = 'https://api.github.com/repos/augustinmarso/ecoute-intelligente/actions/workflows/site.yml/dispatches';
  const TOKEN_NEW = 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent('Écoute Intelligente') +
    '&description=' + encodeURIComponent('Préparation automatique des vidéos') + '&expires_in=none';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  let poll = null, tick = null;

  async function dispatch(id, token) {
    const r = await _fetch(DISPATCH, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' },
      body: JSON.stringify({ ref: 'main', inputs: { video: 'https://www.youtube.com/watch?v=' + id } })
    });
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      throw new Error('Jeton GitHub refusé (expiré, ou sans le droit « Actions : lecture et écriture » sur ecoute-intelligente).');
    }
    if (!r.ok) throw new Error('GitHub a refusé le lancement (' + r.status + ').');
  }

  // Remet l'écran d'erreur d'app.js dans son état d'origine (titre, icône, bouton Réessayer).
  function resetBox(box) {
    box.querySelector('h3').textContent = 'Impossible de charger cette vidéo';
    box.querySelector('.ms').hidden = false;
    document.getElementById('btn-retry').hidden = false;
  }

  function waitFor(id, box) {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (box.hidden) { clearInterval(poll); clearInterval(tick); return; } // l'utilisateur est parti ailleurs
      try {
        const r = await _fetch(`videos/${id}.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) { clearInterval(poll); clearInterval(tick); resetBox(box); document.getElementById('btn-retry').click(); }
      } catch {}
    }, 10000);
  }

  function offerPrepare(id) {
    const box = document.getElementById('player-error');
    if (!box || box.hidden) return;
    box.querySelector('.ei-prepare')?.remove();
    clearInterval(tick);
    const div = document.createElement('div');
    div.className = 'ei-prepare';
    div.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;max-width:420px';
    box.querySelector('#btn-retry')?.before(div);
    const msg = document.getElementById('player-error-msg');
    const retry = document.getElementById('btn-retry');

    const token = getToken();
    if (token) {
      retry.hidden = true;
      box.querySelector('.ms').hidden = true;
      box.querySelector('h3').textContent = 'Préparation de la vidéo…';
      msg.textContent = 'Première ouverture : GitHub récupère les sous-titres, les images et le son. La vidéo s’ouvrira toute seule.';
      div.innerHTML = '<div class="spinner"></div><span class="ei-wait" style="font-size:13px;color:var(--text3)"></span>';
      const t0 = Date.now();
      const wait = div.querySelector('.ei-wait');
      const show = () => { const s = Math.round((Date.now() - t0) / 1000); wait.textContent = `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s — environ 2 min en tout`; };
      show(); tick = setInterval(show, 1000);
      dispatch(id, token).then(() => waitFor(id, box)).catch(e => {
        clearInterval(tick);
        div.remove();
        offerPrepare(id); // jeton effacé : repropose le bouton et le champ du jeton
        box.querySelector('h3').textContent = 'Impossible de lancer la préparation';
        msg.textContent = e.message;
      });
      return;
    }

    resetBox(box);
    const title = 'Préparer : https://www.youtube.com/watch?v=' + id;
    div.innerHTML = `<a class="btn-main ei-issue" style="height:40px;padding:0 22px;text-decoration:none" target="_blank" rel="noopener">
        <span class="ms" style="font-size:18px">rocket_launch</span> Préparer cette vidéo sur GitHub</a>
      <details style="width:100%;font-size:12.5px;color:var(--text2);text-align:left">
        <summary style="cursor:pointer;text-align:center;color:var(--text3)">Préparation automatique (propriétaire du dépôt)</summary>
        <p style="margin:10px 0 8px;line-height:1.5">Crée un <a class="ei-tok" target="_blank" rel="noopener">jeton GitHub</a> :
          « Only select repositories » → <b>ecoute-intelligente</b>, puis « Repository permissions » → <b>Actions : Read and write</b>.
          Colle-le ici une fois : il reste dans ce navigateur, et chaque nouveau lien se prépare tout seul.</p>
        <form style="display:flex;gap:6px">
          <input type="password" autocomplete="off" placeholder="github_pat_…" aria-label="Jeton GitHub"
            style="flex:1;min-width:0;height:36px;padding:0 12px;border:none;border-radius:999px;background:var(--bg2);color:var(--text);box-shadow:inset 0 0 0 1px var(--border2)"/>
          <button class="btn-main" type="submit">Enregistrer</button>
        </form>
      </details>`;
    div.querySelector('.ei-issue').href = ISSUES + '?title=' + encodeURIComponent(title) +
      '&body=' + encodeURIComponent('Valide cette issue (bouton « Create ») : la vidéo sera prête sur le site dans 2 à 3 minutes.');
    div.querySelector('.ei-tok').href = TOKEN_NEW;
    div.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      const v = div.querySelector('input').value.trim();
      if (!v) return;
      try { localStorage.setItem(TOKEN_KEY, v); } catch {}
      offerPrepare(id); // relance avec le jeton
    });
    waitFor(id, box);
  }

  const media = (id, ms, ext) => new URL(`videos/${id}/${ms}.${ext}`, location.href).href;
  // Médias des cartes : servis par le site (même nom que dans Anki : EI-<id>-<ms>.jpg|mp3).
  window.EI_MEDIA_URL = name => {
    if (/^(data|https?):/.test(name)) return name; // galerie : déjà une adresse complète
    const m = String(name).match(/^EI-([A-Za-z0-9_-]{11})-(\d+)\.(jpg|mp3)$/);
    return m ? media(m[1], m[2], m[3]) : '';
  };

  async function handle(route, query, method, body) {
    const [name, arg] = route.split('/');
    switch (name) {
      case 'health': {
        let ok = false;
        try { ok = (await anki('version')) >= 6; } catch {}
        return { ok: true, anki: ok };
      }
      case 'video': return videoMeta(decodeURIComponent(arg));
      case 'capture': {
        const { videoId, start, text, translation, videoTitle } = body;
        if (!videoId || start == null || !text) throw new Error('Paramètres manquants');
        await ensureAnki();
        const ms = Math.round(start * 1000);
        const t = Math.floor(start);
        const meta = metas.get(videoId) || await videoMeta(videoId);
        let picture = [{ url: media(videoId, ms, 'jpg'), filename: `EI-${videoId}-${ms}.jpg`, fields: ['Image'] }];
        let audio = [{ url: media(videoId, ms, 'mp3'), filename: `EI-${videoId}-${ms}.mp3`, fields: ['Audio'] }];
        let image = media(videoId, ms, 'jpg');
        if (meta.live) {
          const s = meta.sentences.find(x => Math.abs(x.start - start) < 0.05) || { start, end: body.end };
          const rec = await liveCapture(videoId, s);
          picture = [{ data: rec.image, filename: `EI-${videoId}-${ms}.jpg`, fields: ['Image'] }];
          audio = [{ data: rec.audio, filename: `EI-${videoId}-${ms}.webm`, fields: ['Audio'] }];
          image = 'data:image/jpeg;base64,' + rec.image;
        }
        const res = await addNote({
          deckName: DECK_PHRASES, modelName: MODEL_PHRASE,
          fields: { Image: '', Audio: '', Text: esc(text), Translation: esc(translation),
            Source: esc(`${videoTitle || videoId} — ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`),
            Url: `https://www.youtube.com/watch?v=${videoId}&t=${t}s` },
          tags: ['ecoute-intelligente'],
          options: { allowDuplicate: false, duplicateScope: 'deck' },
          picture, audio
        });
        return { ...res, image };
      }
      case 'word': {
        const { word, phonetic, definition, translation, example, videoTitle } = body;
        if (!word) throw new Error('Mot manquant');
        await ensureAnki();
        return addNote({
          deckName: DECK_MOTS, modelName: MODEL_MOT,
          fields: { Word: esc(word), Phonetic: esc(phonetic), Definition: esc(definition),
            Translation: esc(translation), Example: esc(example), Source: esc(videoTitle) },
          tags: ['ecoute-intelligente'], options: { allowDuplicate: false, duplicateScope: 'deck' }
        });
      }
      case 'sentence': {
        const { fr, en } = body;
        if (!fr || !en) throw new Error('fr et en requis');
        await ensureAnki();
        return addNote({
          deckName: DECK_THEME, modelName: MODEL_THEME,
          fields: { Fr: esc(fr), En: esc(en), Source: 'Exercice — phrase générée' },
          tags: ['ecoute-intelligente', 'theme'], options: { allowDuplicate: false, duplicateScope: 'deck' }
        });
      }
      case 'cards': {
        if (method === 'DELETE') {
          const id = +arg;
          if (!Number.isFinite(id) || id <= 0) throw new Error('noteId invalide');
          await anki('deleteNotes', { notes: [id] });
          return { ok: true };
        }
        const deck = async d => {
          const ids = await anki('findNotes', { query: `"deck:${d}"` });
          return ids.length ? (await anki('notesInfo', { notes: ids })).sort((a, b) => b.noteId - a.noteId) : [];
        };
        const [phrases, mots] = await Promise.all([deck(DECK_PHRASES), deck(DECK_MOTS)]);
        const f = (n, k) => (n.fields[k] ? n.fields[k].value : '');
        const TYPES = { jpg: 'image/jpeg', mp3: 'audio/mpeg', webm: 'audio/webm' };
        const fromAnki = async name => {
          if (!name) return '';
          try {
            const b64 = await anki('retrieveMediaFile', { filename: name });
            return b64 ? `data:${TYPES[name.split('.').pop()] || 'application/octet-stream'};base64,${b64}` : '';
          } catch { return ''; }
        };
        return {
          phrases: await Promise.all(phrases.map(async n => ({ id: n.noteId, text: f(n, 'Text'), translation: f(n, 'Translation'),
            source: f(n, 'Source'), url: f(n, 'Url'),
            image: await fromAnki((f(n, 'Image').match(/src="([^"]+)"/) || [])[1]),
            audio: await fromAnki((f(n, 'Audio').match(/\[sound:([^\]]+)\]/) || [])[1]) }))),
          mots: mots.map(n => ({ id: n.noteId, word: f(n, 'Word'), phonetic: f(n, 'Phonetic'),
            definition: f(n, 'Definition'), translation: f(n, 'Translation'), example: f(n, 'Example'), source: f(n, 'Source') }))
        };
      }
      case 'captures': {
        const vid = decodeURIComponent(arg);
        try {
          const ids = await anki('findNotes', { query: `"deck:${DECK_PHRASES}" "Audio:*EI-${vid}-*"` });
          const re = new RegExp(`EI-${vid}-(\\d+)\\.(mp3|webm)`, 'i'); // Anki peut passer les noms en minuscules
          const starts = ids.length ? (await anki('notesInfo', { notes: ids }))
            .map(n => (((n.fields.Audio || {}).value || '').match(re) || [])[1]).filter(Boolean).map(s => +s / 1000) : [];
          return { ok: true, starts };
        } catch { return { ok: false, starts: [] }; }
      }
      case 'anki': return { result: await anki(body.action, body.params || {}) };
      // LM Studio joint en direct : il faut cocher « Enable CORS » dans ses réglages serveur.
      case 'lm': {
        const base = (arg === 'models' ? query.get('url') : body.url || '').replace(/\/+$/, '');
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(base + '/')) throw new Error('URL LM Studio invalide (doit être locale)');
        try {
          const r = arg === 'models' ? await _fetch(base + '/models')
            : await _fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.payload) });
          return r.json();
        } catch { throw new Error('LM Studio injoignable — lance « Local Server » et active « Enable CORS »'); }
      }
      case 'state': return method === 'GET' ? {} : { ok: true }; // en ligne : progression dans le navigateur seulement
    }
    throw new Error('Route inconnue : ' + route);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return _fetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    try {
      const data = await handle(url.pathname.slice(5), url.searchParams, method, init.body ? JSON.parse(init.body) : {});
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  };

  // Accueil : liste des vidéos déjà préparées, à ouvrir d'un clic.
  document.addEventListener('DOMContentLoaded', async () => {
    if (!hasExt()) {
      const form = document.getElementById('url-form');
      const tip = document.createElement('details');
      tip.className = 'today-card';
      tip.style.cssText = 'display:block;margin:-1.4rem 0 2rem;font-size:13.5px;color:var(--text2);line-height:1.6';
      tip.innerHTML = `<summary style="cursor:pointer;color:var(--text)"><span class="ms" style="color:var(--accent)">extension</span>
          <b>Ouvre n'importe quelle vidéo instantanément</b> avec l'extension Chrome</summary>
        <ol style="margin:10px 0 4px 20px">
          <li><a href="ecoute-intelligente-extension.zip" download>Télécharge l'extension</a> et décompresse le fichier .zip</li>
          <li>Ouvre <b>chrome://extensions</b> et active le <b>Mode développeur</b> (en haut à droite)</li>
          <li>Clique <b>Charger l'extension non empaquetée</b> et choisis le dossier décompressé</li>
          <li>Recharge cette page. Pour capturer image et son, clique une fois sur l'icône de l'extension</li>
        </ol>`;
      form.after(tip);
    }
    let list = [];
    try { list = await (await _fetch('videos/index.json')).json(); } catch { return; }
    const recent = document.getElementById('recent-section');
    if (!recent || !list.length) return;
    const sec = document.createElement('div');
    sec.style.marginBottom = '2.4rem';
    sec.innerHTML = `<div class="section-title"><span class="ms" style="font-size:16px">video_library</span> Vidéos prêtes</div>
      <div class="recent-grid">${list.map(v => `
        <button class="recent-card" data-id="${esc(v.id)}">
          <div class="recent-thumb-wrap"><img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="" loading="lazy"/></div>
          <div class="recent-body"><div class="recent-title">${esc(v.title)}</div><div class="recent-meta">${esc(v.channel)}</div></div>
        </button>`).join('')}</div>`;
    recent.before(sec);
    sec.addEventListener('click', e => {
      const card = e.target.closest('[data-id]');
      if (!card) return;
      document.getElementById('url-input').value = card.dataset.id;
      document.getElementById('url-form').requestSubmit();
    });
  });
})();
