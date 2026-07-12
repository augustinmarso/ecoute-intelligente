// =============================================================
// ai.js — Client IA minimal (API Claude ou OpenAI directement
// depuis le navigateur, clé stockée en local). Adapté de
// Lecture Intelligente : ne garde que l'appel générique aiCall()
// et la gestion des réglages, utilisés par la page Exercices.
// =============================================================

const AI_STORE_KEY = 'ei-ai';
const AI_DEFAULTS = {
  keys: { anthropic: '', openai: '' },
  model: 'claude-haiku-4-5',
  lm: { url: 'http://localhost:1234/v1', model: '' } // LM Studio (local)
};

// Catalogue des modèles proposés (le fournisseur est déduit du modèle choisi)
const AI_MODELS = {
  'claude-haiku-4-5':  { provider: 'anthropic', label: 'Claude Haiku 4.5 (éco)' },
  'claude-opus-4-8':   { provider: 'anthropic', label: 'Claude Opus 4.8 (qualité)' },
  'gpt-4.1-nano':      { provider: 'openai',    label: 'GPT-4.1 nano (ultra éco)' },
  'gpt-4.1-mini':      { provider: 'openai',    label: 'GPT-4.1 mini (éco)' },
  'gpt-4.1':           { provider: 'openai',    label: 'GPT-4.1 (qualité)' },
  'gpt-5.4-nano':      { provider: 'openai',    label: 'GPT-5.4 nano (raisonne, éco)' },
  'gpt-5.4-mini':      { provider: 'openai',    label: 'GPT-5.4 mini (raisonne)' },
  'gpt-5.4':           { provider: 'openai',    label: 'GPT-5.4 (raisonne, qualité)' },
  'gpt-5.5':           { provider: 'openai',    label: 'GPT-5.5 (max)' },
  // Modèle local via LM Studio (API compatible OpenAI, aucune clé, tout reste
  // sur la machine). Le modèle réel (Qwen 2.5, etc.) est celui chargé dans LM Studio.
  'lmstudio':          { provider: 'lmstudio',  label: 'LM Studio — local (Qwen…)' }
};
const AI_PROVIDER_LABELS = { anthropic: 'Claude', openai: 'OpenAI', lmstudio: 'LM Studio' };

function _aiSettings() {
  let s;
  try { s = JSON.parse(localStorage.getItem(AI_STORE_KEY) || '{}'); } catch (_) { s = {}; }
  // Migration de l'ancien format { key, model } (clé unique Claude)
  if (s.key && !s.keys) s.keys = { anthropic: s.key, openai: '' };
  s.keys = Object.assign({}, AI_DEFAULTS.keys, s.keys || {});
  s.lm = Object.assign({}, AI_DEFAULTS.lm, s.lm || {});
  if (!s.model || !AI_MODELS[s.model]) s.model = AI_DEFAULTS.model;
  return s;
}
function _aiSave(patch) {
  const s = _aiSettings();
  if (patch.keys) patch.keys = Object.assign({}, s.keys, patch.keys);
  if (patch.lm) patch.lm = Object.assign({}, s.lm, patch.lm);
  localStorage.setItem(AI_STORE_KEY, JSON.stringify(Object.assign(s, patch)));
}
function _aiProvider(model) { return (AI_MODELS[model] || {}).provider || (String(model).startsWith('gpt') ? 'openai' : 'anthropic'); }
function aiIsConfigured() {
  const s = _aiSettings();
  const p = _aiProvider(s.model);
  if (p === 'lmstudio') return true; // pas de clé : il suffit que LM Studio tourne
  return !!s.keys[p];
}

// Liste les modèles chargés dans LM Studio. Passe par le proxy du serveur de
// l'app (/api/lm/models) car LM Studio ne renvoie pas d'en-têtes CORS.
async function aiListLocalModels(url) {
  const base = (url || _aiSettings().lm.url || 'http://localhost:1234/v1').replace(/\/+$/, '');
  const r = await fetch('/api/lm/models?url=' + encodeURIComponent(base));
  if (!r.ok) throw new Error('LM Studio injoignable');
  const j = await r.json();
  return (j.data || []).map(m => m.id);
}
window.aiListLocalModels = aiListLocalModels;

// --- Appel API (fetch direct navigateur : app statique sans build,
// pas de SDK npm). Route vers Claude ou OpenAI selon le modèle choisi. ---
const AI_DEFAULT_SYSTEM = 'Tu es un assistant pédagogique en anglais pour un francophone. Réponds de façon concrète et concise.';

async function _aiHttp(url, headers, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    let msg = 'Erreur API (' + resp.status + ')';
    try { const j = await resp.json(); if (j.error && j.error.message) msg = j.error.message; } catch (_) {}
    if (resp.status === 401) msg = 'Clé API invalide — vérifie-la dans les réglages IA';
    if (resp.status === 429) msg = 'Limite de requêtes atteinte — réessaie dans une minute';
    throw new Error(msg);
  }
  return resp.json();
}

function _aiParse(text, schema) {
  if (!schema) return text;
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Réponse IA illisible — réessaie'); }
}

async function aiCall({ system, user, schema, maxTokens, model: modelOverride }) {
  const s = _aiSettings();
  // Un appel peut imposer son modèle (ex : micro-tâche → modèle ultra éco),
  // à condition d'avoir la clé du fournisseur correspondant.
  let model = s.model;
  if (modelOverride && AI_MODELS[modelOverride] && s.keys[_aiProvider(modelOverride)]) model = modelOverride;
  const provider = _aiProvider(model);

  // LM Studio (local, compatible OpenAI) : pas de clé, URL locale, le modèle
  // réel est celui chargé dans LM Studio (Qwen 2.5, etc.).
  if (provider === 'lmstudio') {
    const base = (s.lm.url || 'http://localhost:1234/v1').replace(/\/+$/, '');
    let lmModel = s.lm.model;
    if (!lmModel) { // aucun modèle précisé -> on prend celui qui est chargé
      try { lmModel = (await aiListLocalModels(base))[0]; } catch (_) {}
    }
    const body = {
      model: lmModel || 'local-model',
      max_tokens: maxTokens || 2000,
      messages: [
        { role: 'system', content: system || AI_DEFAULT_SYSTEM },
        { role: 'user', content: user }
      ]
    };
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'reponse', strict: true, schema } };
    // Via le proxy du serveur de l'app (LM Studio n'autorise pas le CORS).
    const resp = await fetch('/api/lm/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: base, payload: body })
    });
    if (!resp.ok) {
      let msg = `LM Studio : erreur ${resp.status}`;
      try { const j = await resp.json(); if (j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    const m = data.choices && data.choices[0] && data.choices[0].message;
    if (!m) throw new Error('Réponse LM Studio vide — un modèle est-il chargé ?');
    return _aiParse(m.content || '', schema);
  }

  const key = s.keys[provider];
  if (!key) throw new Error(`Clé API ${AI_PROVIDER_LABELS[provider]} manquante — configure-la dans les réglages IA`);

  if (provider === 'openai') {
    // Les GPT-5.x raisonnent (paramètre reasoning_effort + marge de tokens) ;
    // les GPT-4.1 non — leur envoyer reasoning_effort déclencherait une erreur.
    const isReasoning = /^gpt-5/.test(model);
    const body = {
      model,
      max_completion_tokens: (maxTokens || 2000) + (isReasoning ? 1500 : 0),
      messages: [
        { role: 'system', content: system || AI_DEFAULT_SYSTEM },
        { role: 'user', content: user }
      ]
    };
    if (isReasoning) body.reasoning_effort = 'low';
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'reponse', strict: true, schema } };
    const data = await _aiHttp('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + key }, body);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('Réponse API vide — réessaie');
    if (msg.refusal) throw new Error('Requête refusée par l\'API');
    return _aiParse(msg.content || '', schema);
  }

  // Anthropic (Claude)
  const body = {
    model,
    max_tokens: maxTokens || 2000,
    system: system || AI_DEFAULT_SYSTEM,
    messages: [{ role: 'user', content: user }]
  };
  if (schema) body.output_config = { format: { type: 'json_schema', schema } };
  const data = await _aiHttp('https://api.anthropic.com/v1/messages', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  }, body);
  if (data.stop_reason === 'refusal') throw new Error('Requête refusée par l\'API');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return _aiParse(text, schema);
}
window.aiCall = aiCall;
window.aiIsConfigured = aiIsConfigured;
window.AI_MODELS = AI_MODELS;

// Wrappers publics pour l'UI de config (page Exercices)
window.aiSettings = _aiSettings;
window.aiSaveSettings = _aiSave;

// Modèle le moins cher parmi les fournisseurs dont une clé est configurée
// (pour les micro-tâches : GPT-4.1 nano ~0,10 $/M, sinon Haiku ~1 $/M).
function aiCheapestModel() {
  const s = _aiSettings();
  if (s.keys.openai) return 'gpt-4.1-nano';
  if (s.keys.anthropic) return 'claude-haiku-4-5';
  return s.model;
}
window.aiCheapestModel = aiCheapestModel;
