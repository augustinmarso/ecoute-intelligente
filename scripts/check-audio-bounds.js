/* Analyse des bornes de découpe audio.
 * Vérité terrain : timings mot-à-mot des sous-titres auto (en-orig.json3,
 * chaque segs[] porte tOffsetMs). On compare la fenêtre de capture
 * [start-0.25, end+0.15] de chaque phrase (construite depuis les subs "en")
 * avec : (a) le début du dernier mot de la phrase, (b) le début du premier
 * mot de la phrase suivante.
 */
const fs = require('fs');
const path = require('path');
const { parseJson3, mergeSentences } = require('../server.js');

const id = process.argv[2] || 'arj7oStGLkU';
const CACHE = path.join(__dirname, '..', 'cache');

// Phrases telles que le serveur les construit (subs manuels "en" prioritaires)
const cues = parseJson3(fs.readFileSync(path.join(CACHE, `${id}.en.json3`), 'utf8'));
const sentences = mergeSentences(cues);

// Timeline mot-à-mot depuis les sous-titres auto
const auto = JSON.parse(fs.readFileSync(path.join(CACHE, `${id}.en-orig.json3`), 'utf8'));
const words = [];
for (const ev of auto.events || []) {
  if (!ev.segs) continue;
  for (const seg of ev.segs) {
    const w = (seg.utf8 || '').trim();
    if (!w || w === '\n') continue;
    words.push({ t: (ev.tStartMs + (seg.tOffsetMs || 0)) / 1000, w });
  }
}
words.sort((a, b) => a.t - b.t);

// Mode "refined" : utilise les bornes affinées du serveur si présentes
const { parseJson3: _p, mergeSentences: _m, ...rest } = require('../server.js');
const srv = require('../server.js');
if (typeof srv.refineAudioBounds === 'function') {
  srv.refineAudioBounds(sentences, words.map(w => w.t));
}

const PAD_START = 0.25, PAD_END = 0.15;
let cutLast = 0, leakNext = 0, total = 0;
const examples = { cut: [], leak: [] };

for (let i = 0; i < sentences.length; i++) {
  const s = sentences[i], next = sentences[i + 1];
  const win = s.audioStart != null ? [s.audioStart, s.audioEnd] : [s.start - PAD_START, s.end + PAD_END];
  // mots de la phrase = mots auto dans [s.start-0.2, s.end+0.05], en excluant
  // ceux qui appartiennent déjà à la phrase suivante (parole continue)
  const nextFirstT = next ? (words.find(w => w.t >= next.start - 0.1) || {}).t : Infinity;
  const sw = words.filter(w => w.t >= s.start - 0.2 && w.t < Math.min(s.end + 0.05, (nextFirstT ?? Infinity) - 0.02));
  if (sw.length < 3) continue; // zone sans alignement fiable (rires, musique)
  total++;
  const last = sw[sw.length - 1];
  // un mot parlé dure ~0.28s en moyenne ; s'il démarre à moins de 0.25s de la
  // fin de fenêtre, sa fin est probablement coupée
  if (last.t > win[1] - 0.25) {
    cutLast++;
    if (examples.cut.length < 5) examples.cut.push(`#${i} "...${sw.slice(-3).map(x => x.w).join(' ')}" dernier mot @${last.t.toFixed(2)} vs fin fenêtre ${win[1].toFixed(2)}`);
  }
  if (next) {
    const nw = words.find(w => w.t >= next.start - 0.1);
    if (nw && nw.t < win[1] - 0.05) {
      leakNext++;
      if (examples.leak.length < 5) examples.leak.push(`#${i} attrape "${nw.w}" (phrase suivante) @${nw.t.toFixed(2)} < fin fenêtre ${win[1].toFixed(2)}`);
    }
  }
}

console.log(`Phrases analysées : ${total}`);
console.log(`Dernier mot risquant d'être coupé : ${cutLast} (${(100 * cutLast / total).toFixed(1)}%)`);
console.log(`Premier mot de la phrase suivante inclus : ${leakNext} (${(100 * leakNext / total).toFixed(1)}%)`);
console.log('\nExemples coupures :'); examples.cut.forEach(e => console.log(' ', e));
console.log('Exemples débordements :'); examples.leak.forEach(e => console.log(' ', e));

// Diagnostic complémentaire : écart moyen entre fin de phrase (subs "en") et
// début réel de la phrase suivante (mot-à-mot)
let gaps = [];
for (let i = 0; i < sentences.length - 1; i++) {
  const s = sentences[i], next = sentences[i + 1];
  const nw = words.find(w => w.t >= next.start - 0.1);
  if (nw) gaps.push(nw.t - s.end);
}
gaps.sort((a, b) => a - b);
const q = p => gaps[Math.floor(p * gaps.length)];
console.log(`\nÉcart (début réel phrase suivante - fin phrase) : p10=${q(.1).toFixed(2)}s p50=${q(.5).toFixed(2)}s p90=${q(.9).toFixed(2)}s`);
