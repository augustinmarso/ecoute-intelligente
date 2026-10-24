// =============================================================
// static-api.js — Version en ligne (GitHub Pages), sans serveur.
// Chargé EN PREMIER. Hors localhost, remplace les routes /api/* du serveur
// (server.js) par leur équivalent dans le navigateur :
// - vidéos : transcript + image/son de chaque phrase préparés par GitHub
//   Actions (scripts/prepare-video.js) dans videos/ ;
// - Anki : joint directement via AnkiConnect (127.0.0.1:8765), à condition
//   d'avoir ajouté l'adresse du site dans « webCorsOriginList » d'AnkiConnect.
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

  async function anki(action, params = {}) {
    let r;
    try {
      r = await _fetch(ANKI_URL, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
    } catch {
      throw new Error("Anki injoignable : ouvre Anki et ajoute « " + location.origin + " » dans webCorsOriginList d'AnkiConnect");
    }
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.result;
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

  async function videoMeta(id) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Lien YouTube invalide');
    // no-store : GitHub Pages met les 404 en cache 10 min, la vidéo doit apparaître dès qu'elle est prête.
    const r = await _fetch(`videos/${id}.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) {
      setTimeout(() => offerPrepare(id), 500); // après l'affichage du message d'erreur par app.js
      throw new Error("Cette vidéo n'est pas encore prête : il faut la préparer une fois sur GitHub (2 à 3 minutes).");
    }
    return r.json();
  }

  // Bouton « Préparer » : ouvre une issue pré-remplie (le workflow « Site » la traite, réservé au
  // propriétaire du dépôt), puis le site guette la vidéo et l'ouvre dès qu'elle est en ligne.
  let poll = null;
  function offerPrepare(id) {
    const box = document.getElementById('player-error');
    if (!box || box.hidden) return;
    box.querySelector('.ei-prepare')?.remove();
    clearInterval(poll);
    const title = 'Préparer : https://www.youtube.com/watch?v=' + id;
    const href = ISSUES + '?title=' + encodeURIComponent(title) +
      '&body=' + encodeURIComponent('Valide cette issue (bouton « Create ») : la vidéo sera prête sur le site dans 2 à 3 minutes.');
    const div = document.createElement('div');
    div.className = 'ei-prepare';
    div.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px';
    div.innerHTML = `<a class="btn-main" style="height:40px;padding:0 22px;text-decoration:none" target="_blank" rel="noopener">
        <span class="ms" style="font-size:18px">rocket_launch</span> Préparer cette vidéo sur GitHub</a>
      <span style="font-size:12.5px;color:var(--text3)">Valide sur GitHub, puis reste ici : la vidéo s'ouvrira toute seule.</span>`;
    div.querySelector('a').href = href;
    box.querySelector('#btn-retry')?.before(div);
    poll = setInterval(async () => {
      if (box.hidden) return clearInterval(poll); // l'utilisateur est parti ailleurs
      try {
        const r = await _fetch(`videos/${id}.json?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) { clearInterval(poll); document.getElementById('btn-retry')?.click(); }
      } catch {}
    }, 15000);
  }

  const media = (id, ms, ext) => new URL(`videos/${id}/${ms}.${ext}`, location.href).href;
  // Médias des cartes : servis par le site (même nom que dans Anki : EI-<id>-<ms>.jpg|mp3).
  window.EI_MEDIA_URL = name => {
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
        const res = await addNote({
          deckName: DECK_PHRASES, modelName: MODEL_PHRASE,
          fields: { Image: '', Audio: '', Text: esc(text), Translation: esc(translation),
            Source: esc(`${videoTitle || videoId} — ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`),
            Url: `https://www.youtube.com/watch?v=${videoId}&t=${t}s` },
          tags: ['ecoute-intelligente'],
          options: { allowDuplicate: false, duplicateScope: 'deck' },
          picture: [{ url: media(videoId, ms, 'jpg'), filename: `EI-${videoId}-${ms}.jpg`, fields: ['Image'] }],
          audio: [{ url: media(videoId, ms, 'mp3'), filename: `EI-${videoId}-${ms}.mp3`, fields: ['Audio'] }]
        });
        return { ...res, image: media(videoId, ms, 'jpg') };
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
        return {
          phrases: phrases.map(n => ({ id: n.noteId, text: f(n, 'Text'), translation: f(n, 'Translation'),
            source: f(n, 'Source'), url: f(n, 'Url'),
            image: (f(n, 'Image').match(/src="([^"]+)"/) || [])[1] || '',
            audio: (f(n, 'Audio').match(/\[sound:([^\]]+)\]/) || [])[1] || '' })),
          mots: mots.map(n => ({ id: n.noteId, word: f(n, 'Word'), phonetic: f(n, 'Phonetic'),
            definition: f(n, 'Definition'), translation: f(n, 'Translation'), example: f(n, 'Example'), source: f(n, 'Source') }))
        };
      }
      case 'captures': {
        const vid = decodeURIComponent(arg);
        try {
          const ids = await anki('findNotes', { query: `"deck:${DECK_PHRASES}" "Audio:*EI-${vid}-*"` });
          const re = new RegExp(`EI-${vid}-(\\d+)\\.mp3`);
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
