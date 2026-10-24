// =============================================================
// dictionary.js — Écoute Intelligente
// Traduction FR des mots par DICTIONNAIRE (fr.wiktionary, fallback
// liens interlangues Wikipédia) — pas de traduction automatique/IA.
// MyMemory ne sert plus qu'aux phrases entières (translateToFr).
// Expose window.lookupWord(word) et window.translateToFr(text).
// =============================================================

const EI_DICT_CACHE_KEY = 'ei-dict-cache-v3'; // v3 : fix parseur (étiquettes de domaine, citations)
const EI_DICT_CACHE_MAX = 200;

// ---------- Cache ----------

function _eiLoadCache() {
  try { return JSON.parse(localStorage.getItem(EI_DICT_CACHE_KEY) || '{}'); }
  catch (_) { return {}; }
}

function _eiSaveCache(cache) {
  try {
    const keys = Object.keys(cache);
    if (keys.length > EI_DICT_CACHE_MAX) {
      // Vire les entrées les plus anciennes (par timestamp) pour rester sous la limite.
      keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
      for (const k of keys.slice(0, keys.length - EI_DICT_CACHE_MAX)) delete cache[k];
    }
    localStorage.setItem(EI_DICT_CACHE_KEY, JSON.stringify(cache));
  } catch (_) { /* quota dépassé ou storage indisponible : tant pis */ }
}

// Nettoie un mot cliqué : minuscules, ponctuation retirée aux extrémités, longueur raisonnable.
function cleanWord(raw) {
  if (!raw) return '';
  let w = String(raw).trim().toLowerCase();
  w = w.replace(/^[^a-zà-ÿ']+/i, '').replace(/[^a-zà-ÿ']+$/i, '');
  if (w.length < 2 || w.length > 50) return '';
  return w;
}

function _stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Répare les chaînes « mojibake » : du texte UTF-8 relu comme Latin-1 (ex.
// « PiÃ¨ce » au lieu de « Pièce », « pleÉªd » au lieu de « pleɪd »). De
// vieilles versions de l'app ont pu mettre ce genre de données en cache ; on
// ré-encode Latin-1 -> octets -> UTF-8 pour retrouver le texte d'origine.
// Ne touche jamais aux chaînes saines (le décodage fatal échoue dessus).
function _fixMojibake(s) {
  if (!s || typeof s !== 'string') return s;
  let suspicious = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Accents Latin-1 (0x80-0xFF) : candidats au mojibake. Les vrais textes
    // français accentués en sont exclus car un seul 0xC0-0xFF suivi d'ASCII
    // est un séquençage UTF-8 invalide (le décodage fatal rejettera).
    if (c >= 0x80 && c <= 0xff) { suspicious = true; break; }
  }
  if (!suspicious) return s;
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (fixed === s || fixed.includes('\uFFFD')) return s; // pas du mojibake : on garde l'original
    return fixed;
  } catch (_) { return s; }
}

// ---------- Phonétique (dictionaryapi.dev — dictionnaire, pas d'IA) ----------

async function _fetchPhonetic(word) {
  const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!r.ok) return '';
  const data = await r.json();
  if (!Array.isArray(data) || !data.length) return '';
  const entry = data[0];
  return entry.phonetic || (entry.phonetics || []).find(p => p.text)?.text || '';
}

// ---------- Traduction FR par dictionnaire (fr.wiktionary) ----------

// Sous-sections du Wiktionnaire qui ne contiennent pas de définition.
const EI_FRWIKT_SKIP = new Set(['Étymologie', 'Prononciation', 'Voir aussi', 'Références',
  'Anagrammes', 'Dérivés', 'Synonymes', 'Antonymes', 'Apparentés étymologiques',
  'Vocabulaire apparenté par le sens', 'Notes', 'Dérivés dans d’autres langues',
  'Hyperonymes', 'Hyponymes', 'Variantes orthographiques', 'Abréviations']);

// Extrait les définitions françaises de la section « Anglais » de la page
// fr.wiktionary du mot. Retourne un tableau de chaînes (souvent la traduction
// directe : « hypothesis » -> « Hypothèse. »), ou [] si rien.
async function _frWiktDefs(word) {
  const url = 'https://fr.wiktionary.org/w/api.php?action=query&format=json&origin=*'
    + '&prop=extracts&explaintext=true&exsectionformat=wiki&redirects=1&titles='
    + encodeURIComponent(word);
  const r = await fetch(url);
  if (!r.ok) return [];
  const pages = (await r.json())?.query?.pages || {};
  const ext = Object.values(pages)[0]?.extract;
  if (!ext) return [];
  const sec = ext.match(/== Anglais ==\n([\s\S]*?)(?:\n== [^=]|$)/);
  if (!sec) return [];

  const defs = [];
  const subRe = /\n=== ([^=]+) ===\n([\s\S]*?)(?=\n=== |\n==== |$)/g;
  let m;
  const lw = word.toLowerCase();
  while ((m = subRe.exec(sec[1])) && defs.length < 2) {
    const title = m[1].trim();
    if (EI_FRWIKT_SKIP.has(title)) continue;
    // Lignes candidates : ni en-tête du mot, ni prononciation (contient « \ »),
    // avec l'étiquette de domaine décapée — « (Anatomie) Cerveau. » → « Cerveau. »
    // (la jeter entière ferait retomber sur les citations qui suivent).
    const lines = m[2].split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => !l.toLowerCase().startsWith(lw) && !l.includes('\\') && !l.includes('Exemple d'))
      .map(l => l.replace(/^\([^)]*\)\s*/, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    // La définition précède toujours les citations dans une section : on prend
    // la première ligne qui n'est pas une citation attribuée (« … — (Auteur… »).
    const best = lines.slice(0, 4).find(l => !l.includes('— ('));
    if (best) defs.push(best.slice(0, 120));
  }
  return defs;
}

// « Pluriel de procrastinator. », « Prétérit du verbe sprint. »… -> mot de base
function _inflectionBase(def) {
  if (!/^(Pluriel|Prétérit|Participe|Forme|Troisième|Première|Deuxième|Génitif)/i.test(def)) return null;
  const m = def.match(/\b(?:de|du verbe|de l’adjectif|du nom)\s+([a-zA-Zà-ÿ-]+)\.?\s*$/);
  return m ? m[1].toLowerCase() : null;
}

// Fallback : titre de l'article Wikipédia FR correspondant (liens interlangues).
async function _wikipediaFrTitle(word) {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*'
    + '&prop=langlinks&lllang=fr&redirects=1&titles=' + encodeURIComponent(word);
  const r = await fetch(url);
  if (!r.ok) return '';
  const pages = (await r.json())?.query?.pages || {};
  const ll = Object.values(pages)[0]?.langlinks;
  const title = ll && ll[0] && ll[0]['*'];
  return title ? title.replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
}

// Traduction française d'un mot anglais, par dictionnaire uniquement :
// fr.wiktionary (mot, puis forme de base si fléchi, puis lemmes naïfs),
// puis liens interlangues Wikipédia. Retourne '' si introuvable.
async function translateWordFr(word, depth = 0) {
  const tryWikt = async (w) => {
    try { return await _frWiktDefs(w); } catch (_) { return []; }
  };

  let defs = await tryWikt(word);
  // Page de forme fléchie (« Pluriel de X ») -> on suit vers la forme de base.
  if (defs.length && depth < 2) {
    const base = _inflectionBase(defs[0]);
    if (base && base !== word) {
      const baseT = await translateWordFr(base, depth + 1);
      if (baseT) return baseT;
    }
  }
  if (defs.length && !_inflectionBase(defs[0])) return defs.join(' ; ');

  if (depth === 0) {
    // Le mot n'a pas de page : on tente ses formes de base probables.
    for (const cand of _lemmaCandidates(word)) {
      defs = await tryWikt(cand);
      if (defs.length && !_inflectionBase(defs[0])) return defs.join(' ; ');
    }
    try { return await _wikipediaFrTitle(word); } catch (_) { return ''; }
  }
  return '';
}

// ---------- Traduction FR ----------

// Traduit un texte anglais (mot ou phrase) en français via MyMemory.
// Ne bloque jamais : renvoie '' en cas d'échec.
async function translateToFr(text) {
  if (!text) return '';
  try {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr`);
    if (!r.ok) return '';
    const data = await r.json();
    return (data && data.responseData && data.responseData.translatedText) || '';
  } catch (_) {
    return '';
  }
}

// ---------- API principale ----------

// Cherche phonétique + traduction française (dictionnaire, jamais d'IA).
// Retourne toujours { word, phonetic, translation } — jamais null — même en
// cas d'échec total (translation vide), pour ne jamais bloquer l'UI.
async function lookupWord(word) {
  const clean = cleanWord(word);
  if (!clean) return { word: word || '', phonetic: '', translation: '' };

  const cache = _eiLoadCache();
  const hit = cache[clean];
  if (hit) {
    // Répare au passage les éventuelles entrées corrompues (mojibake UTF-8)
    // laissées par d'anciennes versions, puis les réécrit (localStorage + disque).
    const phonetic = _fixMojibake(hit.phonetic || '');
    const translation = _fixMojibake(hit.translation || '');
    if (phonetic !== hit.phonetic || translation !== hit.translation) {
      cache[clean] = { phonetic, translation, ts: hit.ts || Date.now() };
      _eiSaveCache(cache);
    }
    return { word: clean, phonetic, translation };
  }

  const [phonetic, translation] = await Promise.all([
    _fetchPhonetic(clean).catch(() => ''),
    translateWordFr(clean).catch(() => '')
  ]);

  const result = { word: clean, phonetic: phonetic || '', translation: translation || '' };
  cache[clean] = { phonetic: result.phonetic, translation: result.translation, ts: Date.now() };
  _eiSaveCache(cache);

  return result;
}

// ---------- Détection de mots complexes (export auto à la capture) ----------

// Règles de suffixe pour une lemmatisation naïve : on retire le suffixe (et
// applique le remplacement associé) pour obtenir une racine candidate.
const EI_SUFFIX_RULES = [
  ['ies', 'y'], ['ing', ''], ['est', ''],
  ['ed', ''], ['es', ''], ['ly', ''], ['er', ''],
  ['s', '']
];

// `word` est déjà nettoyé/en minuscules. Vrai si `word` est directement dans
// COMMON_WORDS, ou si une variante lemmatisée naïvement (suffixe retiré, avec
// dédoublement de consonne et/ou "e" final réintroduit) l'est.
// Ex: "pulling" -> "pull" ; "stopped" -> "stopp"/"stop" ; "used" -> "us"/"use".
// Formes irrégulières fréquentes (passé/participe/pluriel) -> forme de base.
// La lemmatisation par suffixes ne les attrape pas ("woke" n'est pas "wake"+suffixe).
const EI_IRREGULAR = {
  woke: 'wake', woken: 'wake', went: 'go', gone: 'go', took: 'take', taken: 'take',
  made: 'make', said: 'say', thought: 'think', brought: 'bring', bought: 'buy',
  caught: 'catch', taught: 'teach', felt: 'feel', kept: 'keep', left: 'leave',
  met: 'meet', paid: 'pay', told: 'tell', understood: 'understand', wrote: 'write',
  written: 'write', drove: 'drive', driven: 'drive', ate: 'eat', eaten: 'eat',
  fell: 'fall', fallen: 'fall', gave: 'give', given: 'give', grew: 'grow',
  grown: 'grow', knew: 'know', known: 'know', ran: 'run', saw: 'see', seen: 'see',
  spoke: 'speak', spoken: 'speak', stood: 'stand', threw: 'throw', thrown: 'throw',
  wore: 'wear', worn: 'wear', flew: 'fly', flown: 'fly', drew: 'draw', drawn: 'draw',
  chose: 'choose', chosen: 'choose', broke: 'break', broken: 'break', began: 'begin',
  begun: 'begin', came: 'come', found: 'find', got: 'get', gotten: 'get',
  heard: 'hear', held: 'hold', lost: 'lose', sat: 'sit', sent: 'send',
  slept: 'sleep', spent: 'spend', built: 'build', sold: 'sell', shook: 'shake',
  shaken: 'shake', sang: 'sing', sung: 'sing', swam: 'swim', swum: 'swim',
  forgot: 'forget', forgotten: 'forget', became: 'become', meant: 'mean',
  men: 'man', women: 'woman', children: 'child', feet: 'foot', teeth: 'tooth',
  mice: 'mouse', lives: 'life', leaves: 'leaf', better: 'good', best: 'good',
  worse: 'bad', worst: 'bad'
};

// Formes de base plausibles d'un mot (suffixes retirés, consonne dédoublée,
// e final réintroduit, irréguliers). Sert au filtre "mot courant" ET aux
// recherches dictionnaire quand la forme fléchie n'a pas de page.
function _lemmaCandidates(word) {
  const candidates = new Set();
  const irr = EI_IRREGULAR[word];
  if (irr) candidates.add(irr);
  for (const [suf, repl] of EI_SUFFIX_RULES) {
    if (word.length <= suf.length + 1 || !word.endsWith(suf)) continue;
    const stem = word.slice(0, word.length - suf.length) + repl;
    candidates.add(stem);
    // consonne doublée : "stopp" -> "stop"
    if (stem.length >= 3) {
      const last = stem[stem.length - 1], prev = stem[stem.length - 2];
      if (last === prev && !'aeiou'.includes(last)) candidates.add(stem.slice(0, -1));
    }
    // e final réintroduit : "us" -> "use", "mak" -> "make"
    candidates.add(stem + 'e');
  }
  candidates.delete(word);
  return [...candidates];
}

function _isKnownCommon(word) {
  const common = window.COMMON_WORDS;
  if (!common) return false;
  if (common.has(word)) return true;
  return _lemmaCandidates(word).some(c => common.has(c));
}

// Un "mot" = lettres, avec apostrophes/traits d'union internes tolérés.
const EI_WORD_TOKEN_RE = /[A-Za-zÀ-ÿ]+(?:['’-][A-Za-zÀ-ÿ]+)*/g;
const EI_ALPHA_INTERNAL_RE = /^[a-zà-ÿ]+(?:['’-][a-zà-ÿ]+)*$/i;

// Repère jusqu'à `max` mots "difficiles" dans `text` (ordre d'apparition,
// dédupliqué) : longueur >= 4, purement alphabétique, absent de COMMON_WORDS
// (même après lemmatisation naïve), hors noms propres et contractions.
function findComplexWords(text, max = 3) {
  if (!text) return [];
  const tokens = String(text).match(EI_WORD_TOKEN_RE) || [];
  const out = [];
  const seen = new Set();

  for (let i = 0; i < tokens.length && out.length < max; i++) {
    const raw = tokens[i];
    // Nom propre : majuscule initiale hors premier mot de la phrase.
    if (i > 0 && /^[A-ZÀ-Ÿ]/.test(raw)) continue;

    const clean = cleanWord(raw);
    if (!clean || clean.length < 4) continue;
    if (!EI_ALPHA_INTERNAL_RE.test(clean)) continue;
    if (clean.indexOf("'") !== -1 || clean.indexOf('’') !== -1) continue; // contraction (don't, it's…)
    if (seen.has(clean)) continue;
    if (_isKnownCommon(clean)) continue;

    seen.add(clean);
    out.push(clean);
  }

  return out;
}

window.lookupWord = lookupWord;
window.translateToFr = translateToFr;
window.cleanWord = cleanWord;
window.findComplexWords = findComplexWords;
