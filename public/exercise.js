// =============================================================
// exercise.js — Page « Exercices »
// L'IA génère des phrases françaises que l'utilisateur traduit en
// anglais (écrit ou oral) ; l'IA corrige et note la réponse.
// Ouverture/fermeture de la vue (showExercise/hideExercise) vivent
// dans app.js — ce fichier ne gère que le contenu de #view-exercise.
// =============================================================

const EX_SYSTEM = "Tu es un professeur d'anglais pour un francophone. Tu crées des exercices de thème (français → anglais). Réponds en JSON strict.";

const EX_GEN_SCHEMA = {
  type: 'object',
  properties: { fr: { type: 'string' }, en: { type: 'string' } },
  required: ['fr', 'en'], additionalProperties: false
};

const EX_GRADE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    correction: { type: 'string' },
    feedback: { type: 'string' },
    errors: {
      type: 'array', items: {
        type: 'object',
        properties: { wrong: { type: 'string' }, right: { type: 'string' } },
        required: ['wrong', 'right'], additionalProperties: false
      }
    }
  },
  required: ['score', 'correction', 'feedback', 'errors'], additionalProperties: false
};

const EX_TENSE_LABEL = { present: 'présent', passe: 'passé', futur: 'futur' };
const EX_TENSE_CHIP = { present: 'Présent', passe: 'Passé', futur: 'Futur' };

/* ---------------------------------------------------------------
 * État (tout en mémoire, rien de persisté hors XP global)
 * ------------------------------------------------------------- */

let exWords = [];            // [{word, translation}] tiré de /api/cards
let exListState = null;      // null | 'loading' | 'empty' | 'error' | 'ready'
let exSessionPoints = 0;     // compteur de la session, pas persisté
let exSettings = { tense: 'alea', mode: 'ecrit' };
let exPhase = 'idle';        // 'idle' | 'generating' | 'gen-error' | 'answering' | 'grading' | 'grade-error' | 'corrected'
let exCurrent = null;        // { words, tense, fr, en }
let exAnswer = '';
let exCorrection = null;     // { score, correction, feedback, errors }
let exGenError = '';
let exGradeError = '';
let exRecognition = null;
let exRecognizing = false;
let exBlocks = null;         // mode « blocs » : { fr, en, words, bank, answer, result }

/* ---------------------------------------------------------------
 * Phrases générées enregistrées (rejouables en mode blocs)
 * ------------------------------------------------------------- */

const EX_SAVED_KEY = 'ei-sentences-v1';
// Une phrase redevient « à revoir » ~20 h après sa dernière révision réussie.
const EX_REVIEW_AFTER_MS = 20 * 3600 * 1000;
const _snoozedReviews = new Set(); // « Plus tard » — mémoire de session seulement
let _currentDue = null;            // phrase proposée par la carte Révision

function getSavedSentences() {
  try { return JSON.parse(localStorage.getItem(EX_SAVED_KEY) || '[]'); }
  catch (_) { return []; }
}

function writeSavedSentences(list) {
  try { localStorage.setItem(EX_SAVED_KEY, JSON.stringify(list.slice(0, 100))); } catch (_) {}
}

// Entrée : { fr, en, ts, reviews, lastReview, ankiId } (les anciennes entrées
// sans ts sont considérées dues immédiatement).
function saveGeneratedSentence(fr, en) {
  if (!fr || !en) return;
  const list = getSavedSentences().filter(s => s.en !== en);
  list.unshift({ fr, en, ts: Date.now(), reviews: 0, lastReview: null, ankiId: null });
  writeSavedSentences(list);
}

function updateSavedSentence(en, patch) {
  const list = getSavedSentences();
  const i = list.findIndex(s => s.en === en);
  if (i < 0) return;
  Object.assign(list[i], patch);
  writeSavedSentences(list);
}

// Révision réussie (thème corrigé ou blocs reconstruits) -> repousse l'échéance.
function markSentenceReviewed(en) {
  const cur = getSavedSentences().find(s => s.en === en);
  if (!cur) return;
  updateSavedSentence(en, { lastReview: Date.now(), reviews: (cur.reviews || 0) + 1 });
}

// Phrases dues, la plus « en retard » d'abord.
function getDueSentences() {
  const now = Date.now();
  return getSavedSentences()
    .filter(s => !_snoozedReviews.has(s.en) && now - (s.lastReview || s.ts || 0) > EX_REVIEW_AFTER_MS)
    .sort((a, b) => (a.lastReview || a.ts || 0) - (b.lastReview || b.ts || 0));
}

function _hasSpeechRecognition() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/* ---------------------------------------------------------------
 * Point d'entrée — appelé par app.js à chaque ouverture de la vue
 * ------------------------------------------------------------- */

function initExercise() {
  exPhase = 'idle';
  exCurrent = null;
  exAnswer = '';
  exCorrection = null;
  exGenError = '';
  exGradeError = '';
  if (window.aiIsConfigured && window.aiIsConfigured()) {
    loadExerciseWordList();
  } else {
    renderExercise();
  }
}
window.initExercise = initExercise;

/* ---------------------------------------------------------------
 * Chargement de la liste de mots (Anki)
 * ------------------------------------------------------------- */

async function loadExerciseWordList() {
  exListState = 'loading';
  renderExercise();
  try {
    const r = await fetch('/api/cards');
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Erreur inconnue');
    exWords = (data.mots || []).filter(m => m && m.word);
    exListState = exWords.length < 3 ? 'empty' : 'ready';
  } catch (_) {
    exListState = 'error';
  }
  renderExercise();
}

function pickWords() {
  const n = exWords.length >= 8 ? 3 : 2;
  const pool = exWords.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/* ---------------------------------------------------------------
 * Génération de phrase (IA)
 * ------------------------------------------------------------- */

function generateSentence() {
  const words = pickWords();
  let tense = exSettings.tense;
  if (tense === 'alea') tense = ['present', 'passe', 'futur'][Math.floor(Math.random() * 3)];
  return runGeneration(words, tense);
}

function retryGeneration() {
  if (!exCurrent) return generateSentence();
  return runGeneration(exCurrent.words, exCurrent.tense);
}

async function runGeneration(words, tense) {
  exCurrent = { words, tense, fr: '', en: '' };
  exAnswer = '';
  exCorrection = null;
  exPhase = 'generating';
  renderExercise();

  const tenseLabel = EX_TENSE_LABEL[tense];
  const wordsStr = words.map(w => w.word).join(', ');
  try {
    const result = await window.aiCall({
      system: EX_SYSTEM,
      user: `Écris UNE phrase française naturelle et simple (10 à 16 mots), au temps ${tenseLabel}, dont la traduction anglaise idiomatique utilise les mots anglais suivants : ${wordsStr}. La phrase doit être du quotidien, concrète, sans nom propre. Donne aussi la traduction anglaise de référence.`,
      schema: EX_GEN_SCHEMA,
      maxTokens: 400
    });
    exCurrent.fr = result.fr || '';
    exCurrent.en = result.en || '';
    saveGeneratedSentence(exCurrent.fr, exCurrent.en); // rejouable en mode blocs
    exPhase = 'answering';
  } catch (e) {
    exGenError = e.message || 'Erreur inconnue';
    exPhase = 'gen-error';
  }
  renderExercise();
}

/* ---------------------------------------------------------------
 * Validation + correction (IA)
 * ------------------------------------------------------------- */

function validateAnswer() {
  const ta = document.getElementById('ex-answer');
  const val = (ta ? ta.value : exAnswer || '').trim();
  if (!val) { showToast('Écris ta réponse avant de valider'); return; }
  exAnswer = val;
  gradeAnswer();
}

async function gradeAnswer() {
  exPhase = 'grading';
  renderExercise();
  try {
    const result = await window.aiCall({
      system: EX_SYSTEM,
      user: `Phrase française : "${exCurrent.fr}". Traduction de référence : "${exCurrent.en}". Réponse de l'élève : "${exAnswer}". Note la réponse de 0 à 10 (sens, temps verbal, grammaire, usage des mots imposés ; sois encourageant mais juste). Donne la correction complète et un retour bref en français (1-2 phrases). Liste les erreurs (segment erroné → correction).`,
      schema: EX_GRADE_SCHEMA,
      maxTokens: 700
    });
    exCorrection = result;
    exPhase = 'corrected';
    markSentenceReviewed(exCurrent.en); // thème travaillé -> échéance repoussée
    const points = (result.score || 0) * 2;
    exSessionPoints += points;
    addXp(points);
    showToast(`+${points} XP`);
    if (result.score === 10) showToast('Parfait !');
  } catch (e) {
    exGradeError = e.message || 'Erreur inconnue';
    exPhase = 'grade-error';
  }
  renderExercise();
}

/* ---------------------------------------------------------------
 * Reconnaissance vocale (mode Oral)
 * ------------------------------------------------------------- */

function ensureRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (exRecognition) return exRecognition;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    const ta = document.getElementById('ex-answer');
    if (ta) ta.value = text;
  };
  rec.onend = () => { exRecognizing = false; updateMicButton(); };
  rec.onerror = () => { exRecognizing = false; updateMicButton(); };
  exRecognition = rec;
  return rec;
}

function toggleMic() {
  const rec = ensureRecognition();
  if (!rec) return;
  if (exRecognizing) {
    try { rec.stop(); } catch (_) {}
    exRecognizing = false;
  } else {
    try { rec.start(); exRecognizing = true; } catch (_) {}
  }
  updateMicButton();
}

function updateMicButton() {
  const btn = document.getElementById('ex-mic-btn');
  if (!btn) return;
  btn.classList.toggle('recording', exRecognizing);
  const iconEl = btn.querySelector('.ms');
  if (iconEl) iconEl.textContent = exRecognizing ? 'stop' : 'mic';
}

/* ---------------------------------------------------------------
 * Rendu
 * ------------------------------------------------------------- */

function renderExercise() {
  const pointsEl = document.getElementById('exercise-points');
  if (pointsEl) pointsEl.textContent = `Points de la session : ${exSessionPoints}`;

  const body = document.getElementById('exercise-body');
  if (!body) return;

  if (!window.aiIsConfigured || !window.aiIsConfigured()) {
    body.innerHTML = renderConfigState();
    wireConfigState();
    return;
  }

  if (exListState === 'loading' || exListState === null) {
    body.innerHTML = `<div class="ex-loading-block"><div class="spinner"></div><p>Chargement de tes mots…</p></div>`;
    return;
  }
  if (exListState === 'error') {
    body.innerHTML = `<div class="ex-error-state">${icon('warning', 26)}<br><br>Impossible de charger tes mots — vérifie qu'Anki est ouvert.<br><br><button class="btn-main" id="ex-retry-list">${icon('refresh', 15)} Réessayer</button></div>`;
    document.getElementById('ex-retry-list').onclick = loadExerciseWordList;
    return;
  }
  if (exListState === 'empty') {
    body.innerHTML = `<div class="ex-empty-state">${icon('style', 30)}<br>Ajoute d'abord des mots à Anki en regardant des vidéos.<br><br><button class="btn-main" id="ex-back-empty">${icon('arrow_back', 15)} Retour</button></div>`;
    document.getElementById('ex-back-empty').onclick = () => window.hideExercise();
    return;
  }

  // exListState === 'ready'
  let html = '';
  if (exPhase === 'idle') {
    // Carte « Révision » : redonne de temps en temps les phrases générées
    // (dues ~20 h après leur dernière révision réussie).
    const due = getDueSentences();
    _currentDue = due[0] || null;
    const reviewHtml = _currentDue ? `
      <div class="ex-review-card">
        <div class="ex-review-head">${icon('history_edu', 16)} Révision — ${due.length} phrase${due.length > 1 ? 's' : ''} à revoir</div>
        <div class="ex-review-fr">${escapeHtml(_currentDue.fr)}</div>
        <div class="ex-next-actions">
          <button class="btn-main" id="ex-review-play">${icon('extension', 15)} Rejouer en blocs</button>
          <button class="btn-main" id="ex-review-later">${icon('schedule', 15)} Plus tard</button>
        </div>
      </div>` : '';
    html = renderSettingsRow(false) + reviewHtml +
      `<div class="ex-main-actions">
        <button class="btn-main" id="ex-new-sentence">${icon('auto_awesome', 16)} Nouvelle phrase</button>
        ${getSavedSentences().length ? `<button class="btn-main" id="ex-replay-blocks">${icon('extension', 16)} Rejouer en blocs</button>` : ''}
      </div>`;
  } else if (exPhase === 'blocks') {
    html = renderBlocks();
  } else if (exPhase === 'generating') {
    html = renderSettingsRow(true) + renderChips() +
      `<div class="ex-loading-block"><div class="spinner"></div><p>Génération de la phrase…</p></div>`;
  } else if (exPhase === 'gen-error') {
    html = renderSettingsRow(false) + renderChips() +
      `<div class="ex-error-state">${icon('warning', 26)}<br><br>${escapeHtml(exGenError)}<br><br><button class="btn-main" id="ex-retry-gen">${icon('refresh', 15)} Réessayer</button></div>`;
  } else if (exPhase === 'answering') {
    html = renderAnswering();
  } else if (exPhase === 'grading') {
    html = renderSettingsRow(true) + renderChips() +
      `<div class="ex-fr-sentence">${escapeHtml(exCurrent.fr)}</div>
      <div class="ex-loading-block"><div class="spinner"></div><p>Correction en cours…</p></div>`;
  } else if (exPhase === 'grade-error') {
    html = renderSettingsRow(true) + renderChips() +
      `<div class="ex-fr-sentence">${escapeHtml(exCurrent.fr)}</div>
      <div class="ex-error-state">${icon('warning', 26)}<br><br>${escapeHtml(exGradeError)}<br><br><button class="btn-main" id="ex-retry-grade">${icon('refresh', 15)} Réessayer</button></div>`;
  } else if (exPhase === 'corrected') {
    html = renderSettingsRow(false) + renderChips() + renderCorrected();
  }
  body.innerHTML = html;
  wireReadyState(body);
}

function renderSettingsRow(disabled) {
  const tenses = [['present', 'Présent'], ['passe', 'Passé'], ['futur', 'Futur'], ['alea', 'Aléatoire']];
  const hasSpeech = _hasSpeechRecognition();
  return `
    <div class="ex-settings-row">
      <div class="ex-pill-group">
        <span class="ex-pill-label">Temps</span>
        ${tenses.map(([id, label]) => `<button type="button" class="ex-pill${exSettings.tense === id ? ' active' : ''}" data-tense="${id}"${disabled ? ' disabled' : ''}>${label}</button>`).join('')}
      </div>
      <div class="ex-pill-group">
        <span class="ex-pill-label">Réponse</span>
        <button type="button" class="ex-pill${exSettings.mode === 'ecrit' ? ' active' : ''}" data-mode="ecrit"${disabled ? ' disabled' : ''}>Écrit</button>
        <button type="button" class="ex-pill${exSettings.mode === 'oral' ? ' active' : ''}" data-mode="oral"${(disabled || !hasSpeech) ? ' disabled' : ''}${!hasSpeech ? ' title="Reconnaissance vocale non disponible sur ce navigateur"' : ''}>Oral</button>
      </div>
    </div>
  `;
}

function renderChips() {
  if (!exCurrent) return '';
  const tenseLabel = EX_TENSE_CHIP[exCurrent.tense] || '';
  return `<div class="ex-chips-row">
    ${exCurrent.words.map(w => `<span class="ex-chip">${escapeHtml(w.word)}</span>`).join('')}
    <span class="ex-chip tense">${escapeHtml(tenseLabel)}</span>
  </div>`;
}

function renderAnswering() {
  const hasSpeech = _hasSpeechRecognition();
  return renderSettingsRow(false) + renderChips() + `
    <div class="ex-fr-sentence">${escapeHtml(exCurrent.fr)}</div>
    <div class="ex-answer-zone">
      <div class="ex-answer-row">
        <textarea id="ex-answer" placeholder="Écris la phrase en anglais…">${escapeHtml(exAnswer)}</textarea>
        ${exSettings.mode === 'oral' && hasSpeech ? `<button type="button" class="ex-mic-btn" id="ex-mic-btn" title="Dicter la réponse">${icon('mic')}</button>` : ''}
      </div>
      <div class="ex-answer-actions">
        <button class="btn-main" id="ex-submit">Valider</button>
      </div>
    </div>
  `;
}

function renderCorrected() {
  const c = exCorrection;
  const cls = c.score >= 8 ? 'good' : (c.score >= 5 ? 'mid' : 'low');
  const tokens = String(c.correction || '').split(/(\s+)/);
  const wordsHtml = tokens.map(w => {
    if (!w.trim()) return escapeHtml(w);
    const clean = window.cleanWord ? window.cleanWord(w) : w.toLowerCase().replace(/[^a-z']/g, '');
    return `<span class="w" data-word="${escapeHtml(clean)}">${escapeHtml(w)}</span>`;
  }).join('');
  const errorsHtml = (c.errors && c.errors.length)
    ? `<div class="ex-errors-list">${c.errors.map(e => `
        <div class="ex-error-item"><span class="ex-error-wrong">${escapeHtml(e.wrong)}</span> ${icon('arrow_forward', 14)} <span class="ex-error-right">${escapeHtml(e.right)}</span></div>
      `).join('')}</div>`
    : '';
  return `
    <div class="ex-correction-card">
      <div class="ex-score-badge ${cls}">${c.score}/10</div>
      <div class="ex-correction-text">${wordsHtml}</div>
      <div class="ex-feedback">${escapeHtml(c.feedback)}</div>
      ${errorsHtml}
      <div class="ex-next-actions">
        <button class="btn-main" id="ex-to-blocks">${icon('extension', 16)} Reconstruire en blocs</button>
        ${sentenceAnkiBtnHtml(exCurrent.en)}
        <button class="btn-main" id="ex-next-sentence">${icon('arrow_forward', 16)} Phrase suivante</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------
 * Mode « blocs » — reconstruire la phrase anglaise façon Duolingo
 * ------------------------------------------------------------- */

function startBlocks(fr, en) {
  const words = String(en || '').trim().split(/\s+/);
  const order = words.map((_, i) => i);
  // Mélange (en évitant de retomber sur l'ordre d'origine quand c'est possible)
  for (let tries = 0; tries < 5; tries++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    if (order.some((v, i) => v !== i) || words.length < 2) break;
  }
  // order = disposition FIXE de la banque (les blocs pris laissent une case
  // fantôme, comme sur Duolingo) ; answer = indices choisis, dans l'ordre.
  exBlocks = { fr, en, words, order, answer: [], result: null };
  exPhase = 'blocks';
  renderExercise();
}

function renderBlocks() {
  const b = exBlocks;
  const inAnswer = new Set(b.answer);
  const answerHtml = b.answer.map((wi, pos) =>
    `<button type="button" class="ex-block in-answer" data-pos="${pos}" data-word="${escapeHtml(b.words[wi])}">${escapeHtml(b.words[wi])}</button>`).join('');
  const bankHtml = b.order.map((wi, pos) =>
    `<button type="button" class="ex-block${inAnswer.has(wi) ? ' ghost' : ''}" data-wi="${wi}" data-word="${escapeHtml(b.words[wi])}" style="animation-delay:${pos * 35}ms"${inAnswer.has(wi) && !b.result ? ' disabled' : ''}>${escapeHtml(b.words[wi])}</button>`).join('');

  let footer;
  const ankiHint = `<div class="ex-blocks-hint">${icon('style', 14)} Clique un mot pour l'ajouter à Anki</div>`;
  if (b.result === 'ok') {
    footer = `<div class="ex-blocks-result ok">${icon('check_circle', 18)} Parfait ! +8 XP</div>
      ${ankiHint}
      <div class="ex-next-actions">
        ${sentenceAnkiBtnHtml(b.en)}
        <button class="btn-main" id="ex-next-sentence">${icon('arrow_forward', 16)} Phrase suivante</button>
      </div>`;
  } else if (b.result === 'ko') {
    footer = `<div class="ex-blocks-result ko">${icon('cancel', 18)}&nbsp;Pas tout à fait — réponse : <strong>${escapeHtml(b.en)}</strong></div>
      ${ankiHint}
      <div class="ex-next-actions">
        <button class="btn-main" id="ex-blocks-retry">${icon('refresh', 16)} Réessayer</button>
        ${sentenceAnkiBtnHtml(b.en)}
        <button class="btn-main" id="ex-next-sentence">${icon('arrow_forward', 16)} Phrase suivante</button>
      </div>`;
  } else {
    footer = `<div class="ex-next-actions"><button class="btn-main" id="ex-blocks-check"${b.answer.length === b.words.length ? '' : ' disabled'}>${icon('check', 16)} Vérifier</button></div>`;
  }

  return `
    <div class="ex-fr-sentence">${escapeHtml(b.fr)}</div>
    <div class="ex-blocks-hint">Reconstruis la phrase anglaise en cliquant les blocs dans l'ordre :</div>
    <div class="ex-answer-line${b.result === 'ko' ? ' shake' : ''}${b.result === 'ok' ? ' ok' : ''}">${answerHtml || '<span class="ex-answer-placeholder">Clique les blocs ci-dessous…</span>'}</div>
    <div class="ex-bank">${bankHtml}</div>
    ${footer}
  `;
}

function checkBlocks() {
  const b = exBlocks;
  const guess = b.answer.map(i => b.words[i]).join(' ');
  if (guess === b.words.join(' ')) {
    b.result = 'ok';
    exSessionPoints += 8;
    addXp(8);
    markSentenceReviewed(b.en); // révision réussie -> échéance repoussée
  } else {
    b.result = 'ko';
  }
  renderExercise();
}

// Après vérification, cliquer un mot (banque ou réponse) l'ajoute à Anki.
function blockWordToAnki(raw) {
  const clean = window.cleanWord ? window.cleanWord(raw) : String(raw || '').toLowerCase();
  if (!clean) return;
  window.addWordDirect(clean, exBlocks ? exBlocks.en : '', 'Exercice blocs');
}

/* ---------- Phrase générée -> carte Anki (deck « Phrases générées ») ---------- */

function sentenceAnkiBtnHtml(en) {
  const saved = getSavedSentences().find(x => x.en === en);
  const added = !!(saved && saved.ankiId);
  return `<button class="btn-main" id="ex-sentence-anki" data-en="${escapeHtml(en)}"${added ? ' disabled' : ''}>${icon(added ? 'check' : 'style', 15)} ${added ? 'Phrase dans Anki' : 'Phrase → Anki'}</button>`;
}

async function sentenceToAnki(btn) {
  const en = btn.dataset.en;
  const saved = getSavedSentences().find(x => x.en === en);
  const fr = saved ? saved.fr
    : (exBlocks && exBlocks.en === en ? exBlocks.fr : (exCurrent && exCurrent.en === en ? exCurrent.fr : ''));
  if (!fr) { showToast('Phrase introuvable'); return; }
  btn.disabled = true;
  try {
    const res = await fetch('/api/sentence', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fr, en })
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    updateSavedSentence(en, { ankiId: res.noteId || true });
    if (res.duplicate) showToast('Phrase déjà dans Anki');
    else { addXp(5); showToast('Phrase ajoutée à Anki +5 XP'); }
    btn.innerHTML = `${icon('check', 15)} Phrase dans Anki`;
  } catch (e) {
    btn.disabled = false;
    showToast('Erreur : ' + (e.message || 'Anki est-il ouvert ?'));
  }
}

function replaySavedBlocks() {
  const due = getDueSentences();
  const list = due.length ? due : getSavedSentences();
  if (!list.length) { showToast("Aucune phrase enregistrée pour l'instant"); return; }
  // priorité aux phrases dues (la plus ancienne), sinon au hasard
  const s = due.length ? due[0] : list[Math.floor(Math.random() * list.length)];
  startBlocks(s.fr, s.en);
}

function wireReadyState(body) {
  body.querySelectorAll('[data-tense]').forEach(btn => {
    btn.onclick = () => { exSettings.tense = btn.dataset.tense; renderExercise(); };
  });
  body.querySelectorAll('[data-mode]').forEach(btn => {
    btn.onclick = () => { if (btn.disabled) return; exSettings.mode = btn.dataset.mode; renderExercise(); };
  });

  const newBtn = document.getElementById('ex-new-sentence'); if (newBtn) newBtn.onclick = generateSentence;
  const retryGen = document.getElementById('ex-retry-gen'); if (retryGen) retryGen.onclick = retryGeneration;

  // Mode blocs
  const toBlocks = document.getElementById('ex-to-blocks');
  if (toBlocks) toBlocks.onclick = () => startBlocks(exCurrent.fr, exCurrent.en);
  const replayBlocks = document.getElementById('ex-replay-blocks');
  if (replayBlocks) replayBlocks.onclick = replaySavedBlocks;

  // Carte « Révision » (accueil des exercices) + bouton « Phrase → Anki »
  const reviewPlay = document.getElementById('ex-review-play');
  if (reviewPlay) reviewPlay.onclick = () => { if (_currentDue) startBlocks(_currentDue.fr, _currentDue.en); };
  const reviewLater = document.getElementById('ex-review-later');
  if (reviewLater) reviewLater.onclick = () => { if (_currentDue) _snoozedReviews.add(_currentDue.en); renderExercise(); };
  const sentenceAnki = document.getElementById('ex-sentence-anki');
  if (sentenceAnki) sentenceAnki.onclick = () => sentenceToAnki(sentenceAnki);
  const blocksCheck = document.getElementById('ex-blocks-check');
  if (blocksCheck) blocksCheck.onclick = checkBlocks;
  const blocksRetry = document.getElementById('ex-blocks-retry');
  if (blocksRetry) blocksRetry.onclick = () => startBlocks(exBlocks.fr, exBlocks.en);
  body.querySelectorAll('.ex-block[data-wi]').forEach(btn => {
    btn.onclick = () => {
      if (!exBlocks) return;
      // Après vérification : un clic sur un mot l'ajoute à Anki.
      if (exBlocks.result) { blockWordToAnki(btn.dataset.word); return; }
      const wi = +btn.dataset.wi;
      if (exBlocks.answer.includes(wi)) return; // case fantôme
      exBlocks.answer.push(wi);
      renderExercise();
    };
  });
  body.querySelectorAll('.ex-block.in-answer').forEach(btn => {
    btn.onclick = () => {
      if (!exBlocks) return;
      if (exBlocks.result) { blockWordToAnki(btn.dataset.word); return; }
      exBlocks.answer.splice(+btn.dataset.pos, 1);
      renderExercise();
    };
  });
  const submitBtn = document.getElementById('ex-submit'); if (submitBtn) submitBtn.onclick = validateAnswer;
  const retryGrade = document.getElementById('ex-retry-grade'); if (retryGrade) retryGrade.onclick = gradeAnswer;
  const micBtn = document.getElementById('ex-mic-btn'); if (micBtn) micBtn.onclick = toggleMic;
  const nextBtn = document.getElementById('ex-next-sentence'); if (nextBtn) nextBtn.onclick = generateSentence;

  const ta = document.getElementById('ex-answer');
  if (ta) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); validateAnswer(); }
    });
    ta.focus();
  }

  body.querySelectorAll('.ex-correction-text .w').forEach(span => {
    span.addEventListener('click', () => {
      const word = span.dataset.word;
      if (!word) return;
      // Pas d'ajout automatique : barre de confirmation « Ajouter à Anki ? »
      window.offerWordToAnki(word, exCorrection.correction, 'Exercice');
    });
  });
}

/* ---------------------------------------------------------------
 * État 1 — configuration de l'assistant IA
 * ------------------------------------------------------------- */

function renderConfigState() {
  const models = window.AI_MODELS || {};
  const groups = { anthropic: [], openai: [], lmstudio: [] };
  Object.entries(models).forEach(([id, m]) => {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push([id, m.label]);
  });
  const s = window.aiSettings ? window.aiSettings() : { model: '', lm: {} };
  const lm = s.lm || { url: 'http://localhost:1234/v1', model: '' };
  const optHtml = (arr) => arr.map(([id, label]) => `<option value="${id}" ${s.model === id ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `
    <div class="ex-config-wrap">
      <div class="ex-config-card">
        <h3>Configurer l'assistant IA</h3>
        <div class="ex-field">
          <label>Modèle</label>
          <select id="ex-ai-model">
            <optgroup label="Claude">${optHtml(groups.anthropic || [])}</optgroup>
            <optgroup label="OpenAI">${optHtml(groups.openai || [])}</optgroup>
            <optgroup label="Local (gratuit)">${optHtml(groups.lmstudio || [])}</optgroup>
          </select>
        </div>
        <div class="ex-field" id="ex-ai-key-field">
          <label>Clé API</label>
          <input type="password" id="ex-ai-key" placeholder="Clé API" autocomplete="off"/>
        </div>
        <div class="ex-field" id="ex-lm-fields" hidden>
          <label>Serveur LM Studio</label>
          <input type="text" id="ex-lm-url" value="${escapeHtml(lm.url || 'http://localhost:1234/v1')}" autocomplete="off"/>
          <label style="margin-top:10px">Modèle chargé <button type="button" class="ex-lm-detect" id="ex-lm-detect">détecter</button></label>
          <input type="text" id="ex-lm-model" value="${escapeHtml(lm.model || '')}" placeholder="laisser vide = modèle chargé (ex : qwen2.5-7b-instruct)" autocomplete="off"/>
        </div>
        <button class="btn-main" id="ex-ai-test">${icon('check', 16)} Tester et enregistrer</button>
        <p class="ex-config-hint" id="ex-config-hint">La clé reste sur ton ordinateur (localStorage).</p>
      </div>
    </div>
  `;
}

function wireConfigState() {
  const modelSel = document.getElementById('ex-ai-model');
  const keyInput = document.getElementById('ex-ai-key');
  if (!modelSel) return;
  const models = window.AI_MODELS || {};
  const providerOf = (m) => (models[m] || {}).provider || 'anthropic';
  const keyField = document.getElementById('ex-ai-key-field');
  const lmFields = document.getElementById('ex-lm-fields');
  const hint = document.getElementById('ex-config-hint');

  // Bascule entre « clé API » (cloud) et « URL + modèle » (LM Studio) selon
  // le fournisseur du modèle sélectionné.
  const sync = () => {
    const provider = providerOf(modelSel.value);
    const isLm = provider === 'lmstudio';
    keyField.hidden = isLm;
    lmFields.hidden = !isLm;
    if (isLm) {
      hint.textContent = 'Lance LM Studio, charge un modèle (ex. Qwen 2.5 Instruct), active « Local Server ». Aucune clé, tout reste sur ta machine.';
    } else {
      const s = window.aiSettings ? window.aiSettings() : { keys: {} };
      keyInput.value = (s.keys && s.keys[provider]) || '';
      keyInput.placeholder = provider === 'openai' ? 'Clé API OpenAI (sk-…)' : 'Clé API Claude (sk-ant-…)';
      hint.textContent = 'La clé reste sur ton ordinateur (localStorage).';
    }
  };
  sync();
  modelSel.onchange = sync;

  const detectBtn = document.getElementById('ex-lm-detect');
  if (detectBtn) detectBtn.onclick = async () => {
    try {
      const ids = await window.aiListLocalModels(document.getElementById('ex-lm-url').value.trim());
      if (ids.length) { document.getElementById('ex-lm-model').value = ids[0]; showToast('Modèle détecté : ' + ids[0]); }
      else showToast('Aucun modèle chargé dans LM Studio');
    } catch (_) { showToast('LM Studio injoignable — « Local Server » activé ?'); }
  };

  document.getElementById('ex-ai-test').onclick = async () => {
    const model = modelSel.value;
    const provider = providerOf(model);
    if (provider === 'lmstudio') {
      const url = document.getElementById('ex-lm-url').value.trim() || 'http://localhost:1234/v1';
      const lmModel = document.getElementById('ex-lm-model').value.trim();
      window.aiSaveSettings({ model, lm: { url, model: lmModel } });
      showToast('Test de LM Studio…');
    } else {
      const keys = {}; keys[provider] = keyInput.value.trim();
      window.aiSaveSettings({ model, keys });
      if (!window.aiIsConfigured()) { showToast('Colle d\'abord ta clé API'); return; }
      showToast('Test de la clé…');
    }
    try {
      await window.aiCall({ user: 'Réponds uniquement : ok', maxTokens: 16 });
      showToast(provider === 'lmstudio' ? 'LM Studio connecté — assistant IA actif' : 'Clé valide — assistant IA actif');
      initExercise();
    } catch (e) {
      showToast(e.message);
    }
  };
}

/* ---------------------------------------------------------------
 * Raccourci « Entrée » = phrase suivante quand la correction est affichée
 * ------------------------------------------------------------- */

document.addEventListener('keydown', (e) => {
  const view = document.getElementById('view-exercise');
  if (!view || view.hidden) return;
  if (e.key !== 'Enter') return;
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
  if (exPhase === 'corrected') { e.preventDefault(); generateSentence(); }
  else if (exPhase === 'blocks' && exBlocks) {
    e.preventDefault();
    if (exBlocks.result === 'ok') generateSentence();
    else if (!exBlocks.bank.length && !exBlocks.result) checkBlocks();
  }
});
