// =============================================================
// app.js — Écoute Intelligente
// Logique de l'app : accueil, lecteur YouTube + capture de phrases,
// dictionnaire au clic, gamification (XP, niveaux, streak, badges).
// =============================================================

/* ---------------------------------------------------------------
 * Helpers globaux
 * ------------------------------------------------------------- */

window.icon = function (name, size) {
  return `<span class="ms"${size ? ` style="font-size:${size}px"` : ''}>${name}</span>`;
};

// File d'attente : deux toasts déclenchés au même instant (ex. level-up + badge)
// s'affichent l'un après l'autre au lieu de s'écraser.
const _toastQueue = [];
let _toastShowing = false;
function showToast(msg) {
  _toastQueue.push(msg);
  if (!_toastShowing) _advanceToast();
}
function _advanceToast() {
  const msg = _toastQueue.shift();
  if (msg === undefined) { _toastShowing = false; return; }
  _toastShowing = true;
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(_advanceToast, 200);
  }, 2200);
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------
 * Extraction d'ID vidéo YouTube
 * ------------------------------------------------------------- */

function extractVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ---------------------------------------------------------------
 * Stockage local : vidéos récentes
 * ------------------------------------------------------------- */

const RECENT_KEY = 'ei-recent-v1';
const RECENT_MAX = 12;

/* ---------------------------------------------------------------
 * Police de lecture (confort dyslexie) — 3 choix persistés
 * ------------------------------------------------------------- */

const FONT_KEY = 'ei-font-v1';
const FONT_OPTIONS = [
  { id: 'lexend', family: "'Lexend', sans-serif", name: 'Lexend', desc: 'Fluide et moderne' },
  { id: 'atkinson', family: "'Atkinson Hyperlegible', sans-serif", name: 'Atkinson Hyperlegible', desc: 'Lettres impossibles à confondre' },
  { id: 'opendyslexic', family: "'OpenDyslexic', sans-serif", name: 'OpenDyslexic', desc: 'Conçue pour la dyslexie' }
];
const FONTS = FONT_OPTIONS.map(f => f.id);

// L'attribut vit sur <html> (pas <body>) : la variable CSS --reading-font en
// dépend et doit être disponible dès le premier rendu du <body>.
function applyReadingFont(font) {
  if (!FONTS.includes(font)) font = FONTS[0];
  document.documentElement.dataset.font = font;
  try { localStorage.setItem(FONT_KEY, font); } catch (_) {}
  document.querySelectorAll('#font-popover .font-option').forEach(b => {
    b.classList.toggle('active', b.dataset.font === font);
  });
}

function renderFontPopover() {
  const pop = document.getElementById('font-popover');
  pop.innerHTML = `
    <div class="font-popover-title">Confort de lecture</div>
    ${FONT_OPTIONS.map(f => `
      <button class="font-option" data-font="${f.id}">
        <span class="font-option-text">
          <span class="font-option-name" style="font-family:${f.family}">${escapeHtml(f.name)}</span>
          <span class="font-option-desc">${escapeHtml(f.desc)}</span>
        </span>
        <span class="ms font-option-check">check</span>
      </button>
    `).join('')}
  `;
  pop.querySelectorAll('.font-option').forEach(b => {
    b.onclick = () => { applyReadingFont(b.dataset.font); hideFontPopover(); };
  });
}

function positionFontPopover() {
  const pop = document.getElementById('font-popover');
  const btn = document.getElementById('btn-font');
  const rect = btn.getBoundingClientRect();
  const popW = pop.offsetWidth || 250;
  let left = rect.right - popW;
  left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));
  let top = rect.bottom + 8;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function showFontPopover() {
  const pop = document.getElementById('font-popover');
  pop.hidden = false;
  positionFontPopover();
  document.getElementById('btn-font').classList.add('active');
  document.getElementById('btn-font').setAttribute('aria-expanded', 'true');
}

function hideFontPopover() {
  document.getElementById('font-popover').hidden = true;
  document.getElementById('btn-font').classList.remove('active');
  document.getElementById('btn-font').setAttribute('aria-expanded', 'false');
}

function initFontPicker() {
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch (_) {}
  renderFontPopover();
  applyReadingFont(saved || FONTS[0]);

  document.getElementById('btn-font').onclick = (e) => {
    e.stopPropagation();
    const pop = document.getElementById('font-popover');
    if (pop.hidden) showFontPopover(); else hideFontPopover();
  };
  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('font-popover');
    const btn = document.getElementById('btn-font');
    if (!pop.hidden && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) hideFontPopover();
  });
}

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch (_) { return []; }
}

function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
  catch (_) { /* storage plein : tant pis */ }
}

function upsertRecent(entry) {
  let list = getRecent();
  list = list.filter(v => v.id !== entry.id);
  list.unshift(entry);
  saveRecent(list);
}

/* ---------------------------------------------------------------
 * Gamification — XP, niveaux, streak, badges
 * ------------------------------------------------------------- */

const STATS_KEY = 'ei-stats-v1';

function defaultStats() {
  return {
    xp: 0,
    lastActiveDay: null,
    streak: 0,
    longestStreak: 0,
    totalCaptures: 0,
    totalWords: 0,
    totalMinutes: 0,
    dailyCaptures: {},          // { 'YYYY-MM-DD': count }
    captures: {},               // { videoId: [start, ...] } — phrases déjà capturées
    completedVideos: [],        // ids de vidéos vues à >90%
    badges: []                  // ids de badges débloqués
  };
}

let stats = loadStats();

function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (!s) return defaultStats();
    return Object.assign(defaultStats(), s);
  } catch (_) { return defaultStats(); }
}

function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (_) {}
}

function levelOf(xp) { return Math.floor(Math.sqrt(xp / 50)); }
function xpForLevel(level) { return Math.pow(level, 2) * 50; }

const LEVEL_TITLES = [
  { min: 0, title: 'Débutant', icon: 'eco' },
  { min: 3, title: 'Apprenti', icon: 'menu_book' },
  { min: 7, title: 'Oreille curieuse', icon: 'hearing' },
  { min: 12, title: 'Étudiant', icon: 'school' },
  { min: 20, title: 'Érudit', icon: 'library_books' },
  { min: 30, title: 'Polyglotte', icon: 'star' }
];

function levelInfo(level) {
  let cur = LEVEL_TITLES[0];
  for (const t of LEVEL_TITLES) if (level >= t.min) cur = t;
  return cur;
}

// Ajoute de l'XP, gère le passage de niveau et vérifie les badges.
function addXp(amount) {
  const before = levelOf(stats.xp);
  stats.xp += amount;
  const after = levelOf(stats.xp);
  saveStats();
  renderHeader();
  if (after > before) {
    const info = levelInfo(after);
    showToast(`Niveau ${after} — ${info.title} !`);
    pulseHeader();
  }
  checkBadges();
}

// Doit être appelé une fois par session (au chargement) pour mettre à jour le streak quotidien.
function tickDailyStreak() {
  const today = todayStr();
  if (stats.lastActiveDay === today) return;
  if (stats.lastActiveDay === yesterdayStr()) stats.streak += 1;
  else stats.streak = 1;
  stats.lastActiveDay = today;
  stats.longestStreak = Math.max(stats.longestStreak, stats.streak);
  saveStats();
  checkBadges();
}

function incrementDailyCapture() {
  const today = todayStr();
  stats.dailyCaptures[today] = (stats.dailyCaptures[today] || 0) + 1;
  stats.totalCaptures += 1;
  saveStats();
}

function todayCaptureCount() { return stats.dailyCaptures[todayStr()] || 0; }

function isSentenceCaptured(videoId, start) {
  const list = stats.captures[videoId];
  return !!list && list.some(s => Math.abs(s - start) < 0.05);
}

function markCaptured(videoId, start) {
  if (!stats.captures[videoId]) stats.captures[videoId] = [];
  if (!isSentenceCaptured(videoId, start)) stats.captures[videoId].push(start);
  saveStats();
}

function markVideoCompletedIfNeeded(videoId) {
  if (stats.completedVideos.includes(videoId)) return;
  stats.completedVideos.push(videoId);
  saveStats();
  checkBadges();
}

function pulseHeader() {
  const el = document.getElementById('topbar');
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

/* ---------- Badges ---------- */

const BADGES = [
  { id: 'first-capture', icon: 'photo_camera', name: 'Première capture', desc: 'Capture ta première phrase', check: s => s.totalCaptures >= 1 },
  { id: 'captures-10', icon: 'collections', name: '10 captures', desc: 'Capture 10 phrases', check: s => s.totalCaptures >= 10 },
  { id: 'captures-100', icon: 'workspace_premium', name: '100 captures', desc: 'Capture 100 phrases', check: s => s.totalCaptures >= 100 },
  { id: 'first-word', icon: 'translate', name: 'Premier mot', desc: 'Ajoute ton premier mot', check: s => s.totalWords >= 1 },
  { id: 'words-25', icon: 'menu_book', name: '25 mots', desc: 'Ajoute 25 mots au dictionnaire', check: s => s.totalWords >= 25 },
  { id: 'streak-3', icon: 'local_fire_department', name: 'Série de 3 jours', desc: '3 jours actifs d\'affilée', check: s => s.streak >= 3 },
  { id: 'streak-7', icon: 'bolt', name: 'Série de 7 jours', desc: '7 jours actifs d\'affilée', check: s => s.streak >= 7 },
  { id: 'streak-30', icon: 'diamond', name: 'Série de 30 jours', desc: '30 jours actifs d\'affilée', check: s => s.streak >= 30 },
  { id: 'video-1', icon: 'check_circle', name: 'Vidéo terminée', desc: 'Regarde une vidéo en entier', check: s => s.completedVideos.length >= 1 },
  { id: 'video-10', icon: 'movie', name: '10 vidéos', desc: 'Termine 10 vidéos', check: s => s.completedVideos.length >= 10 },
  { id: 'listen-60', icon: 'headphones', name: '1 heure d\'écoute', desc: 'Écoute 60 minutes cumulées', check: s => s.totalMinutes >= 60 },
  { id: 'level-5', icon: 'school', name: 'Niveau 5', desc: 'Atteins le niveau 5', check: s => levelOf(s.xp) >= 5 },
  { id: 'level-10', icon: 'star', name: 'Niveau 10', desc: 'Atteins le niveau 10', check: s => levelOf(s.xp) >= 10 }
];

function checkBadges() {
  let unlocked = false;
  for (const b of BADGES) {
    if (stats.badges.includes(b.id)) continue;
    if (b.check(stats)) {
      stats.badges.push(b.id);
      unlocked = true;
      queueCelebration(b);
    }
  }
  if (unlocked) saveStats();
}

const celebrationQueue = [];
function queueCelebration(badge) {
  celebrationQueue.push(badge);
  showToast(`Badge débloqué : ${badge.name}`);
  if (celebrationQueue.length === 1) showNextCelebration();
}
function showNextCelebration() {
  const b = celebrationQueue[0];
  if (!b) return;
  document.getElementById('celebration-icon').textContent = b.icon;
  document.getElementById('celebration-title').textContent = b.name;
  document.getElementById('celebration-desc').textContent = b.desc;
  document.getElementById('celebration-modal').hidden = false;
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('celebration-close').onclick = () => {
    document.getElementById('celebration-modal').hidden = true;
    celebrationQueue.shift();
    if (celebrationQueue.length) setTimeout(showNextCelebration, 250);
  };
});

/* ---------- Rendu de l'en-tête ---------- */

function renderHeader() {
  const level = levelOf(stats.xp);
  const info = levelInfo(level);
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  const pct = next > base ? Math.min(100, Math.round(((stats.xp - base) / (next - base)) * 100)) : 100;

  document.getElementById('lvl-icon').textContent = info.icon;
  document.getElementById('xp-fill').style.width = pct + '%';
  document.getElementById('xp-label').textContent = `Niv. ${level}`;
  document.getElementById('xp-chip').title = `${info.title} — ${stats.xp} XP (prochain niveau : ${next} XP)`;

  const streakEl = document.getElementById('streak-chip');
  if (stats.streak > 0) {
    streakEl.classList.remove('off');
    streakEl.innerHTML = `${icon('local_fire_department', 16)} ${stats.streak}`;
    streakEl.title = `Série de ${stats.streak} jour(s) — record : ${stats.longestStreak}`;
  } else {
    streakEl.classList.add('off');
    streakEl.innerHTML = `${icon('local_fire_department', 16)} 0`;
    streakEl.title = 'Reviens demain pour démarrer une série';
  }
}

/* ---------- Modale stats ---------- */

function openStatsModal() {
  const level = levelOf(stats.xp);
  const info = levelInfo(level);
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  const pct = next > base ? Math.min(100, Math.round(((stats.xp - base) / (next - base)) * 100)) : 100;

  document.getElementById('stats-lvl-icon').textContent = info.icon;
  document.getElementById('stats-lvl-title').innerHTML = `Niveau ${level} <small>— ${escapeHtml(info.title)}</small>`;
  document.getElementById('stats-xp-fill').style.width = pct + '%';
  document.getElementById('stats-xp-caption').textContent = `${stats.xp} XP · encore ${Math.max(0, next - stats.xp)} XP avant le niveau ${level + 1}`;

  const totalWordsAll = stats.totalWords;
  const tiles = [
    { icon: 'local_fire_department', num: stats.streak, lbl: 'Série actuelle' },
    { icon: 'emoji_events', num: stats.longestStreak, lbl: 'Record de série' },
    { icon: 'photo_camera', num: stats.totalCaptures, lbl: 'Phrases capturées' },
    { icon: 'translate', num: totalWordsAll, lbl: 'Mots ajoutés' },
    { icon: 'headphones', num: Math.round(stats.totalMinutes), lbl: 'Minutes écoutées' },
    { icon: 'movie', num: stats.completedVideos.length, lbl: 'Vidéos terminées' }
  ];
  document.getElementById('stats-grid').innerHTML = tiles.map(t =>
    `<div class="stats-tile">${icon(t.icon)}<div class="num">${t.num}</div><div class="lbl">${t.lbl}</div></div>`
  ).join('');

  document.getElementById('badge-grid').innerHTML = BADGES.map(b => {
    const unlocked = stats.badges.includes(b.id);
    return `<div class="badge-tile${unlocked ? '' : ' locked'}">
      <div class="badge-icon">${icon(unlocked ? b.icon : 'lock', 20)}</div>
      <div class="badge-name">${escapeHtml(b.name)}</div>
      <div class="badge-desc">${escapeHtml(b.desc)}</div>
    </div>`;
  }).join('');

  document.getElementById('stats-modal').hidden = false;
}

/* ---------------------------------------------------------------
 * Router accueil / lecteur
 * ------------------------------------------------------------- */

function showHome() {
  stopPolling();
  // On coupe la lecture avant de quitter l'écran : le lecteur YouTube n'est
  // que masqué (display:none), il continuerait sinon à jouer l'audio en fond.
  if (ytPlayer && ytPlayer.pauseVideo) { try { ytPlayer.pauseVideo(); } catch (_) {} }
  currentVideoId = null;
  document.getElementById('view-player').hidden = true;
  document.getElementById('view-home').hidden = false;
  renderRecent();
}

function showPlayerView() {
  document.getElementById('view-home').hidden = true;
  document.getElementById('view-player').hidden = false;
}

/* ---------- Accueil ---------- */

function renderRecent() {
  const grid = document.getElementById('recent-grid');
  const list = getRecent();
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state">${icon('subscriptions', 26)}<br><br>Aucune vidéo récente. Colle une URL YouTube ci-dessus pour commencer.</div>`;
    return;
  }
  grid.innerHTML = list.map(v => {
    const pct = v.duration ? Math.min(100, Math.round((v.position / v.duration) * 100)) : 0;
    return `<button class="recent-card" data-id="${v.id}">
      <div class="recent-thumb-wrap">
        <img src="https://img.youtube.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy"/>
        <div class="recent-progress"><div class="recent-progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="recent-body">
        <div class="recent-title">${escapeHtml(v.title || v.id)}</div>
        <div class="recent-meta">${fmtTime(v.position)} / ${fmtTime(v.duration)}</div>
      </div>
    </button>`;
  }).join('');
  grid.querySelectorAll('.recent-card').forEach(card => {
    card.onclick = () => {
      const v = list.find(x => x.id === card.dataset.id);
      openVideo(v.id, v.position || 0);
    };
  });
}

async function checkAnkiHealth() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    document.getElementById('anki-banner').hidden = !!d.anki;
  } catch (_) {
    document.getElementById('anki-banner').hidden = true; // pas d'info, pas de bandeau
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('url-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('url-input');
    const errorEl = document.getElementById('url-error');
    const id = extractVideoId(input.value);
    if (!id) {
      errorEl.textContent = "URL YouTube non reconnue. Colle un lien watch/shorts/youtu.be ou un ID de 11 caractères.";
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;
    input.value = '';
    openVideo(id, 0);
  });

  document.getElementById('btn-back').onclick = () => showHome();
  document.getElementById('btn-stats').onclick = openStatsModal;
  document.getElementById('btn-cards').onclick = showCards;
  document.getElementById('btn-cards-back').onclick = hideCards;
  document.getElementById('btn-exercise').onclick = showExercise;
  document.getElementById('btn-exercise-back').onclick = hideExercise;
  document.getElementById('tab-phrases').onclick = () => setCardsTab('phrases');
  document.getElementById('tab-mots').onclick = () => setCardsTab('mots');
  document.getElementById('stats-close').onclick = () => { document.getElementById('stats-modal').hidden = true; };
  document.getElementById('stats-modal').addEventListener('click', (e) => {
    if (e.target.id === 'stats-modal') document.getElementById('stats-modal').hidden = true;
  });

  document.getElementById('btn-toggle-panel').onclick = () => {
    document.getElementById('side-panel').classList.toggle('collapsed');
  };

  document.getElementById('btn-retry').onclick = () => { if (currentVideoId) openVideo(currentVideoId, resumeAtLoad); };

  initFontPicker();

  // Plein écran navigateur (F11-like) sur toute l'app
  const fsBtn = document.getElementById('btn-fullscreen');
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  document.addEventListener('fullscreenchange', () => {
    document.getElementById('fullscreen-icon').textContent =
      document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
  });

  tickDailyStreak();
  renderHeader();
  renderRecent();
  checkAnkiHealth();
});

/* ---------------------------------------------------------------
 * Lecteur — état
 * ------------------------------------------------------------- */

let ytPlayer = null;
let ytApiReady = false;
let pendingVideoId = null;

let currentVideoId = null;
let currentVideoMeta = null;   // {id, title, channel, duration, sentences}
let currentSentence = null;
let currentSentenceIndex = -1;
let resumeAtLoad = 0;

let pollTimer = null;
let saveTimer = null;
let listenAccumSec = 0; // secondes écoutées non encore converties en minutes d'XP

// Callback global attendu par l'IFrame API YouTube.
window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  if (pendingVideoId) createPlayer(pendingVideoId, resumeAtLoad);
};

// Coupe les sous-titres incrustés par le player YouTube (font doublon avec
// notre zone de phrase). `cc_load_policy` n'est pas fiable/documenté ; la
// méthode qui marche est de décharger les modules captions/cc juste après
// chaque chargement de vidéo — l'un ou l'autre selon la version du player,
// d'où les deux tentatives en try/catch (silencieux si le module n'existe pas).
function disableCaptions(player) {
  if (!player) return;
  try { player.unloadModule('captions'); } catch (_) {}
  try { player.unloadModule('cc'); } catch (_) {}
}

function createPlayer(videoId, startAt) {
  if (ytPlayer) {
    ytPlayer.loadVideoById({ videoId, startSeconds: startAt || 0 });
    disableCaptions(ytPlayer);
    return;
  }
  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { rel: 0, start: Math.floor(startAt || 0) },
    events: {
      onReady: (e) => { disableCaptions(e.target); startPolling(); },
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerStateChange(e) {
  // 1 = playing
  if (e.data === YT.PlayerState.PLAYING) startPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollTick, 200);
  saveTimer = setInterval(savePositionTick, 5000);
}
function stopPolling() {
  clearInterval(pollTimer); pollTimer = null;
  clearInterval(saveTimer); saveTimer = null;
}

let lastPollTime = null;
function pollTick() {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const state = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
  const t = ytPlayer.getCurrentTime();

  // Accumulation du temps d'écoute réel (seulement pendant la lecture).
  if (state === 1 && lastPollTime != null) {
    const delta = t - lastPollTime;
    if (delta > 0 && delta < 1.5) listenAccumSec += delta;
  }
  lastPollTime = t;
  while (listenAccumSec >= 60) {
    listenAccumSec -= 60;
    stats.totalMinutes += 1;
    saveStats();
    addXp(1);
  }

  updateCurrentSentence(t);

  const dur = currentVideoMeta?.duration;
  if (dur && t / dur > 0.9) markVideoCompletedIfNeeded(currentVideoId);
}

function findSentenceIndex(t) {
  const sentences = currentVideoMeta?.sentences || [];
  for (let i = 0; i < sentences.length; i++) {
    if (t >= sentences[i].start && t <= sentences[i].end) return i;
  }
  // entre deux phrases : garde la dernière passée
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (t >= sentences[i].start) return i;
  }
  return -1;
}

function updateCurrentSentence(t) {
  const idx = findSentenceIndex(t);
  if (idx === currentSentenceIndex) return;
  currentSentenceIndex = idx;
  currentSentence = idx >= 0 ? currentVideoMeta.sentences[idx] : null;
  renderSentenceZone();
  renderTranscriptHighlight();
}

// Taille de police par paliers selon la longueur de la phrase : c'est la
// SEULE chose qui varie avec le contenu — la zone (.sentence-zone) et donc
// la vidéo au-dessus gardent toujours la même taille (cf. CSS).
function sentenceFontSize(text) {
  const len = (text || '').length;
  if (len <= 60) return 30;
  if (len <= 90) return 26;
  return 22;
}

// Affiche uniquement la phrase courante (celle en cours de lecture ou celle
// cliquée dans le transcript) — pas de contexte précédent/suivant.
function renderSentenceZone() {
  const curEl = document.getElementById('sentence-current');

  if (!currentSentence) {
    curEl.classList.add('empty');
    curEl.style.fontSize = '';
    curEl.textContent = 'En attente de sous-titres…';
    return;
  }
  curEl.classList.remove('empty');
  curEl.style.fontSize = sentenceFontSize(currentSentence.text) + 'px';
  const hardWords = window.findComplexWords ? new Set(window.findComplexWords(currentSentence.text, 3)) : new Set();
  const words = currentSentence.text.split(/(\s+)/);
  curEl.innerHTML = words.map(w => {
    if (!w.trim()) return w;
    const clean = window.cleanWord ? window.cleanWord(w) : w.toLowerCase();
    let cls = hardWords.has(clean) ? 'w w-hard' : 'w';
    if (isWordSeen(currentVideoId, clean)) cls += ' w-seen';
    return `<span class="${cls}">${escapeHtml(w)}</span>`;
  }).join('');
  curEl.querySelectorAll('.w').forEach(span => {
    span.addEventListener('click', (e) => onWordClick(e, span));
  });
}

/* ---------------------------------------------------------------
 * Chargement d'une vidéo
 * ------------------------------------------------------------- */

async function openVideo(id, resumeAt) {
  currentVideoId = id;
  currentVideoMeta = null;
  currentSentence = null;
  currentSentenceIndex = -1;
  resumeAtLoad = resumeAt || 0;
  listenAccumSec = 0;
  lastPollTime = null;

  showPlayerView();
  document.getElementById('player-loading').hidden = false;
  document.getElementById('player-error').hidden = true;
  document.getElementById('player-content').hidden = true;
  document.getElementById('player-video-title').textContent = '';

  try {
    const r = await fetch(`/api/video/${encodeURIComponent(id)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur inconnue');

    currentVideoMeta = data;
    document.getElementById('player-video-title').textContent = data.title || id;

    upsertRecent({
      id, title: data.title, channel: data.channel, duration: data.duration,
      position: resumeAt || 0, updatedAt: Date.now()
    });

    document.getElementById('player-loading').hidden = true;
    document.getElementById('player-content').hidden = false;

    renderTranscriptList();
    renderSessionProgress();

    // Anki est la source de vérité : une carte supprimée dans Anki fait
    // disparaître la coche du transcript et la phrase redevient capturable.
    syncCapturesFromAnki(id).then(changed => {
      if (changed && currentVideoId === id) {
        renderTranscriptList();
        renderTranscriptHighlight();
      }
    });

    if (ytApiReady) createPlayer(id, resumeAtLoad);
    else pendingVideoId = id;
  } catch (err) {
    document.getElementById('player-loading').hidden = true;
    document.getElementById('player-error').hidden = false;
    document.getElementById('player-error-msg').textContent = err.message || "Cette vidéo n'a pas de sous-titres anglais exploitables.";
  }
}

// Remplace les marques locales « déjà capturée » d'une vidéo par ce qui existe
// réellement dans Anki. Renvoie true si quelque chose a changé. Si Anki est
// fermé (ok:false), on ne touche à rien.
async function syncCapturesFromAnki(videoId) {
  try {
    const r = await fetch(`/api/captures/${encodeURIComponent(videoId)}`);
    const d = await r.json();
    if (!d.ok) return false;
    const before = JSON.stringify((stats.captures[videoId] || []).slice().sort((a, b) => a - b));
    const starts = (d.starts || []).sort((a, b) => a - b);
    if (starts.length) stats.captures[videoId] = starts;
    else delete stats.captures[videoId];
    saveStats();
    return JSON.stringify(starts) !== before;
  } catch (_) { return false; }
}

function savePositionTick() {
  if (!ytPlayer || !ytPlayer.getCurrentTime || !currentVideoMeta) return;
  const position = ytPlayer.getCurrentTime();
  upsertRecent({
    id: currentVideoId, title: currentVideoMeta.title, channel: currentVideoMeta.channel,
    duration: currentVideoMeta.duration, position, updatedAt: Date.now()
  });
}

/* ---------------------------------------------------------------
 * Panneau transcript
 * ------------------------------------------------------------- */

function renderTranscriptList() {
  const list = document.getElementById('transcript-list');
  const sentences = currentVideoMeta?.sentences || [];
  list.innerHTML = sentences.map((s, i) => {
    const captured = isSentenceCaptured(currentVideoId, s.start);
    return `<button class="transcript-item" data-i="${i}">
      <span class="transcript-time">${fmtTime(s.start)}</span>
      <span class="transcript-text">${escapeHtml(s.text)}</span>
      ${captured ? `<span class="ms transcript-check" style="font-size:15px">check_circle</span>` : ''}
    </button>`;
  }).join('');
  list.querySelectorAll('.transcript-item').forEach(btn => {
    btn.onclick = () => {
      const s = sentences[+btn.dataset.i];
      if (ytPlayer && ytPlayer.seekTo) { ytPlayer.seekTo(s.start, true); ytPlayer.playVideo(); }
      // Affiche tout de suite la phrase cliquée sous la vidéo, sans attendre le polling.
      updateCurrentSentence(s.start + 0.01);
    };
  });
}

function renderTranscriptHighlight() {
  const list = document.getElementById('transcript-list');
  list.querySelectorAll('.transcript-item').forEach(btn => {
    const active = +btn.dataset.i === currentSentenceIndex;
    btn.classList.toggle('active', active);
    if (active) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function renderSessionProgress() {
  const goal = 10;
  const count = todayCaptureCount();
  document.getElementById('session-count').textContent = count;
  document.getElementById('session-ring-count').textContent = count;
  const circumference = 113; // 2*pi*18 environ
  const pct = Math.min(1, count / goal);
  document.getElementById('session-ring-fg').style.strokeDashoffset = String(circumference * (1 - pct));
}

/* ---------------------------------------------------------------
 * Capture d'une phrase → Anki
 * ------------------------------------------------------------- */

let capturing = false;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-capture').addEventListener('click', doCapture);
});

function setCaptureState(state) {
  const btn = document.getElementById('btn-capture');
  const iconEl = document.getElementById('capture-icon');
  const labelEl = document.getElementById('capture-label');
  if (state === 'loading') {
    btn.disabled = true;
    iconEl.outerHTML = `<span class="capture-spin" id="capture-icon"></span>`;
    labelEl.textContent = 'Capture en cours…';
  } else {
    btn.disabled = false;
    const cur = document.getElementById('capture-icon');
    cur.outerHTML = `<span class="ms" id="capture-icon">photo_camera</span>`;
    labelEl.textContent = 'Capturer cette phrase';
  }
}

async function doCapture() {
  if (capturing) return;
  const sentence = currentSentence;
  if (!sentence) { showToast('Aucune phrase à capturer pour le moment'); return; }

  if (isSentenceCaptured(currentVideoId, sentence.start)) {
    showToast('Déjà capturée');
    return;
  }

  capturing = true;
  setCaptureState('loading');
  const btnRect = document.getElementById('btn-capture').getBoundingClientRect();

  try {
    const translation = await translateToFr(sentence.text).catch(() => '');
    const res = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        videoId: currentVideoId, start: sentence.start, end: sentence.end,
        text: sentence.text, translation, videoTitle: currentVideoMeta?.title
      })
    }).then(r => r.json());

    if (res.error) throw new Error(res.error);

    markCaptured(currentVideoId, sentence.start);
    renderTranscriptList();
    renderTranscriptHighlight();

    if (res.duplicate) {
      showToast('Déjà capturée');
    } else {
      incrementDailyCapture();
      renderSessionProgress();
      addXp(10);
      showToast('Carte créée +10 XP');
      if (res.image) flyThumbnail(res.image, btnRect);
      // (plus d'ajout automatique des mots difficiles : les mots ne partent
      // dans Anki que via le bouton du popup de traduction)
    }
  } catch (err) {
    showToast('Erreur de capture : ' + (err.message || 'inconnue'));
  } finally {
    capturing = false;
    setCaptureState('idle');
  }
}

// Petite animation : la vignette capturée « vole » vers le compteur de cartes du panneau.
function flyThumbnail(dataUrl, fromRect) {
  const target = document.getElementById('session-ring-wrap') || document.getElementById('session-count');
  const targetRect = (target || document.getElementById('btn-toggle-panel')).getBoundingClientRect();

  const img = document.createElement('img');
  img.src = dataUrl;
  img.className = 'fly-thumb';
  img.style.left = fromRect.left + fromRect.width / 2 - 30 + 'px';
  img.style.top = fromRect.top - 20 + 'px';
  img.style.width = '60px';
  img.style.height = '40px';
  img.style.opacity = '1';
  document.body.appendChild(img);

  requestAnimationFrame(() => {
    img.style.transform = `translate(${targetRect.left - fromRect.left}px, ${targetRect.top - fromRect.top - 20}px) scale(.15)`;
    img.style.opacity = '0';
  });
  setTimeout(() => img.remove(), 700);
}

/* ---------------------------------------------------------------
 * Popup dictionnaire (clic sur un mot)
 * ------------------------------------------------------------- */

// Mots déjà consultés (traduction FR déjà montrée une fois) par vidéo — en
// mémoire seulement (pas de localStorage) : survit au changement de phrase et
// au retour en arrière tant que la page n'est pas rechargée.
const _seenWordsByVideo = new Map();
function markWordSeen(videoId, word) {
  let set = _seenWordsByVideo.get(videoId);
  if (!set) { set = new Set(); _seenWordsByVideo.set(videoId, set); }
  set.add(word);
}
function isWordSeen(videoId, word) {
  const set = _seenWordsByVideo.get(videoId);
  return !!set && set.has(word);
}

// Clic sur un mot anglais : pause vidéo, traduction française affichée EN
// PLACE dans la phrase (orange), retour au mot anglais après 8 s (le mot
// reste orange), et ajout direct de la carte Anki. Pas de popup.
function onWordClick(e, span) {
  e.stopPropagation();
  const raw = span.textContent;
  const clean = window.cleanWord ? window.cleanWord(raw) : raw.toLowerCase();
  if (!clean) return;
  if (span.classList.contains('w-fr')) return; // déjà en train d'afficher le FR

  if (ytPlayer && ytPlayer.pauseVideo) { try { ytPlayer.pauseVideo(); } catch (_) {} }

  // Une seule requête dictionnaire, partagée entre l'affichage et l'ajout Anki.
  const lookupPromise = lookupWord(clean);
  showFrenchInPlace(span, raw, lookupPromise);
  markWordSeen(currentVideoId, clean);
  addWordDirect(clean, currentSentence?.text || '', currentVideoMeta?.title || '', lookupPromise);
}

// « Hypothèse, supposition. » -> « Hypothèse »
function shortenFrTranslation(t) {
  return String(t || '').split(/[;,]/)[0].replace(/\.\s*$/, '').trim();
}

async function showFrenchInPlace(span, originalText, lookupPromise) {
  span.classList.add('w-fr');
  let data = null;
  try { data = await lookupPromise; } catch (_) {}
  const fr = data && shortenFrTranslation(data.translation);
  if (!fr || !span.isConnected) {
    span.classList.remove('w-fr');
    span.classList.add('w-seen');
    return;
  }
  span.textContent = fr;
  setTimeout(() => {
    if (!span.isConnected) return; // la phrase affichée a changé entre-temps
    span.textContent = originalText;
    span.classList.remove('w-fr');
    span.classList.add('w-seen');
  }, 8000);
}

// Ajout direct d'un mot à Anki (traduction dictionnaire), sans popup.
// Utilisé au clic sur un mot du sous-titre et dans la page d'exercices.
// `lookupPromise` est optionnel : si fourni (clic sur un mot du sous-titre),
// on le réutilise au lieu de relancer lookupWord (cf. showFrenchInPlace).
const _addingWords = new Set();
async function addWordDirect(word, example, sourceTitle, lookupPromise) {
  if (_addingWords.has(word)) return; // anti double-clic
  _addingWords.add(word);
  try {
    const data = await (lookupPromise || lookupWord(word));
    if (!data.translation) { showToast(`« ${word} » : pas de traduction au dictionnaire`); return; }
    const res = await fetch('/api/word', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        word: data.word, phonetic: data.phonetic, translation: data.translation,
        example: example || '', videoTitle: sourceTitle || ''
      })
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    if (res.duplicate) {
      showToast(`« ${word} » est déjà dans Anki`);
    } else {
      stats.totalWords += 1;
      saveStats();
      addXp(5);
      showToast(`${word} → ${data.translation.replace(/\.$/, '')} · ajouté +5 XP`);
    }
  } catch (err) {
    showToast('Erreur : ' + (err.message || 'inconnue'));
  } finally {
    _addingWords.delete(word);
  }
}
window.addWordDirect = addWordDirect;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  hideFontPopover();
  hideWordPopup();
  if (!document.getElementById('view-cards').hidden) hideCards();
  if (!document.getElementById('view-exercise').hidden) hideExercise();
});

/* ---------------------------------------------------------------
 * Galerie « Mes cartes »
 * ------------------------------------------------------------- */

let cardsPreviousView = null;   // 'home' | 'player' — pour le bouton retour
let cardsData = null;           // null | 'loading' | 'error' | {phrases, mots}
let cardsActiveTab = 'phrases';
let cardsAudio = null;
let cardsAudioBtn = null;

function showCards() {
  cardsPreviousView = document.getElementById('view-player').hidden ? 'home' : 'player';
  document.getElementById('view-home').hidden = true;
  document.getElementById('view-player').hidden = true;
  document.getElementById('view-cards').hidden = false;
  loadCardsGallery();
}

function hideCards() {
  stopCardsAudio();
  document.getElementById('view-cards').hidden = true;
  if (cardsPreviousView === 'player') document.getElementById('view-player').hidden = false;
  else document.getElementById('view-home').hidden = false;
}

/* ---------------------------------------------------------------
 * Page « Exercices » (logique dans exercise.js — ici, juste la nav)
 * ------------------------------------------------------------- */

let exercisePreviousView = null;   // 'home' | 'player' — pour le bouton retour

function showExercise() {
  exercisePreviousView = document.getElementById('view-player').hidden ? 'home' : 'player';
  // Contrairement à showCards, on ne coupe pas la vidéo : elle continue en fond.
  document.getElementById('view-home').hidden = true;
  document.getElementById('view-player').hidden = true;
  document.getElementById('view-exercise').hidden = false;
  if (window.initExercise) window.initExercise();
}

function hideExercise() {
  document.getElementById('view-exercise').hidden = true;
  if (exercisePreviousView === 'player') document.getElementById('view-player').hidden = false;
  else document.getElementById('view-home').hidden = false;
}
window.showExercise = showExercise;
window.hideExercise = hideExercise;

function setCardsTab(tab) {
  if (cardsActiveTab === tab) return;
  stopCardsAudio();
  cardsActiveTab = tab;
  document.getElementById('tab-phrases').classList.toggle('active', tab === 'phrases');
  document.getElementById('tab-mots').classList.toggle('active', tab === 'mots');
  renderCardsBody();
}

async function loadCardsGallery() {
  stopCardsAudio();
  cardsData = 'loading';
  renderCardsBody();
  try {
    const r = await fetch('/api/cards');
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Erreur inconnue');
    cardsData = data;
    document.getElementById('tab-phrases-count').textContent = data.phrases.length;
    document.getElementById('tab-mots-count').textContent = data.mots.length;
  } catch (_) {
    cardsData = 'error';
  }
  renderCardsBody();
}

function renderCardsBody() {
  const body = document.getElementById('cards-body');
  if (cardsData === 'loading' || cardsData === null) { body.innerHTML = cardsSkeletonHtml(); return; }
  if (cardsData === 'error') {
    body.innerHTML = `<div class="cards-error-state">${icon('warning', 30)}<br><br>Impossible de charger — Anki est-il ouvert ?<br><br><button class="btn-main" id="cards-retry">${icon('refresh', 15)} Réessayer</button></div>`;
    document.getElementById('cards-retry').onclick = loadCardsGallery;
    return;
  }
  if (cardsActiveTab === 'phrases') renderPhraseGrid(body, cardsData.phrases);
  else renderWordList(body, cardsData.mots);
}

function cardsSkeletonHtml() {
  const card = `<div class="cards-skel-card"><div class="cards-skel-thumb"></div><div class="cards-skel-lines"><div style="width:88%"></div><div style="width:65%"></div><div style="width:40%"></div></div></div>`;
  return `<div class="cards-skel-grid">${card.repeat(6)}</div>`;
}

function renderPhraseGrid(body, phrases) {
  if (!phrases.length) {
    body.innerHTML = `<div class="cards-empty-state">${icon('subscriptions', 26)}<br><br>Aucune phrase capturée pour l'instant — appuie sur C pendant une vidéo !</div>`;
    return;
  }
  body.innerHTML = `<div class="phrase-grid">${phrases.map(p => `
    <div class="phrase-card" data-card-id="${p.id}">
      <div class="phrase-thumb">
        ${p.image ? `<img src="/api/media/${encodeURIComponent(p.image)}" alt="" loading="lazy"/>` : ''}
        ${p.audio ? `<button class="phrase-play" data-audio="${escapeHtml(p.audio)}" title="Écouter">${icon('play_circle')}</button>` : ''}
        <button class="card-del" data-id="${p.id}" data-audio="${escapeHtml(p.audio || '')}" data-kind="phrases" title="Supprimer (aussi dans Anki)">${icon('delete', 17)}</button>
      </div>
      <div class="phrase-body">
        <div class="phrase-text">${escapeHtml(p.text)}</div>
        ${p.translation ? `<div class="phrase-translation">${escapeHtml(p.translation)}</div>` : ''}
        <div class="phrase-source">
          <span>${escapeHtml(p.source)}</span>
          ${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${icon('open_in_new', 12)}</a>` : ''}
        </div>
      </div>
    </div>
  `).join('')}</div>`;

  body.querySelectorAll('.phrase-play').forEach(btn => {
    btn.onclick = () => toggleCardAudio(btn, btn.dataset.audio);
  });
  bindDeleteButtons(body);
}

function renderWordList(body, mots) {
  if (!mots.length) {
    body.innerHTML = `<div class="cards-empty-state">${icon('translate', 26)}<br><br>Aucun mot ajouté pour l'instant — clique sur un mot pendant une vidéo !</div>`;
    return;
  }
  body.innerHTML = `<div class="word-list">${mots.map(m => `
    <div class="word-card" data-card-id="${m.id}">
      <div class="word-card-head">
        <span class="word-card-word">${escapeHtml(m.word)}</span>
        ${m.phonetic ? `<span class="word-card-phonetic">${escapeHtml(m.phonetic)}</span>` : ''}
        <button class="card-del word-del" data-id="${m.id}" data-kind="mots" title="Supprimer (aussi dans Anki)">${icon('delete', 17)}</button>
      </div>
      ${m.translation ? `<div class="word-card-translation">${escapeHtml(m.translation)}</div>` : ''}
      ${m.definition ? `<div class="word-card-def">${escapeHtml(m.definition)}</div>` : ''}
      ${m.example ? `<div class="word-card-example">${icon('format_quote', 14)} ${escapeHtml(m.example)}</div>` : ''}
    </div>
  `).join('')}</div>`;
  bindDeleteButtons(body);
}

/* ---------- Suppression d'une carte (app -> Anki) ---------- */

// Premier clic : le bouton passe en rouge « confirmer » 2,5 s ; second clic :
// suppression réelle dans Anki puis retrait local (galerie + coche transcript).
function bindDeleteButtons(root) {
  root.querySelectorAll('.card-del').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.title = 'Cliquer à nouveau pour supprimer définitivement';
        clearTimeout(btn._confirmTimer);
        btn._confirmTimer = setTimeout(() => btn.classList.remove('confirm'), 2500);
        return;
      }
      clearTimeout(btn._confirmTimer);
      deleteCard(+btn.dataset.id, btn.dataset.kind, btn.dataset.audio || '');
    };
  });
}

async function deleteCard(noteId, kind, audioFilename) {
  try {
    const res = await fetch(`/api/cards/${noteId}`, { method: 'DELETE' }).then(r => r.json());
    if (res.error) throw new Error(res.error);

    // Retire la carte de la galerie sans re-fetch
    if (cardsData && typeof cardsData === 'object') {
      cardsData[kind] = (cardsData[kind] || []).filter(c => c.id !== noteId);
      document.getElementById(`tab-${kind}-count`).textContent = cardsData[kind].length;
      renderCardsBody();
    }

    // Désamorce la coche « déjà capturée » de la phrase correspondante
    if (kind === 'phrases' && audioFilename) {
      const m = audioFilename.match(/^EI-([A-Za-z0-9_-]{11})-(\d+)\.mp3$/);
      if (m) {
        const vid = m[1], start = +m[2] / 1000;
        const list = stats.captures[vid];
        if (list) {
          stats.captures[vid] = list.filter(s => Math.abs(s - start) >= 0.05);
          if (!stats.captures[vid].length) delete stats.captures[vid];
          saveStats();
          if (currentVideoId === vid) { renderTranscriptList(); renderTranscriptHighlight(); }
        }
      }
    }
    showToast('Carte supprimée (aussi dans Anki)');
  } catch (err) {
    showToast('Suppression impossible : ' + (err.message || 'Anki est-il ouvert ?'));
  }
}

function stopCardsAudio() {
  if (cardsAudio) { try { cardsAudio.pause(); } catch (_) {} }
  if (cardsAudioBtn) cardsAudioBtn.innerHTML = icon('play_circle');
  cardsAudio = null;
  cardsAudioBtn = null;
}

function toggleCardAudio(btn, filename) {
  if (cardsAudioBtn === btn) { stopCardsAudio(); return; }
  stopCardsAudio();
  const audio = new Audio(`/api/media/${encodeURIComponent(filename)}`);
  cardsAudio = audio;
  cardsAudioBtn = btn;
  btn.innerHTML = icon('stop_circle');
  const onDone = () => { if (cardsAudioBtn === btn) stopCardsAudio(); };
  audio.addEventListener('ended', onDone);
  audio.addEventListener('error', onDone);
  audio.play().catch(onDone);
}

/* ---------------------------------------------------------------
 * Raccourcis clavier
 * ------------------------------------------------------------- */

function isTypingContext() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('view-player').hidden) return;
  if (isTypingContext()) return;

  const key = e.key.toLowerCase();

  if (key === 'c') {
    e.preventDefault();
    doCapture();
  } else if (key === 'r') {
    e.preventDefault();
    if (ytPlayer && currentSentence) ytPlayer.seekTo(currentSentence.start, true);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekRelativeSentence(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekRelativeSentence(1);
  } else if (e.key === ' ') {
    e.preventDefault();
    togglePlayPause();
  }
});

function seekRelativeSentence(delta) {
  if (!ytPlayer || !currentVideoMeta) return;
  const sentences = currentVideoMeta.sentences || [];
  let idx = currentSentenceIndex + delta;
  idx = Math.max(0, Math.min(sentences.length - 1, idx));
  const s = sentences[idx];
  if (s) ytPlayer.seekTo(s.start, true);
}

function togglePlayPause() {
  if (!ytPlayer || !ytPlayer.getPlayerState) return;
  const state = ytPlayer.getPlayerState();
  if (state === 1) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}
