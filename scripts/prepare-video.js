/* Prépare une vidéo pour la version en ligne (GitHub Pages, sans serveur) :
 * transcript + image et son de CHAQUE phrase, écrits dans public/videos/.
 * Lancé par GitHub Actions (workflow « Site ») : node scripts/prepare-video.js <lien ou ID>
 */
const fs = require('fs');
const path = require('path');
const { getVideoInfo, ytdlp, run, ffmpegPath, CACHE } = require('../server');

const OUT = path.join(__dirname, '..', 'public', 'videos');

function parseId(s) {
  const m = String(s || '').trim().match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/)
    || String(s || '').trim().match(/^([A-Za-z0-9_-]{11})$/);
  if (!m) throw new Error(`Lien YouTube invalide : « ${s} »`);
  return m[1];
}

async function main() {
  const id = parseId(process.argv[2]);
  console.log(`Vidéo ${id} : sous-titres…`);
  const meta = await getVideoInfo(id);

  // On télécharge une fois une petite vidéo (sans son) et la piste audio, puis
  // ffmpeg découpe en local : bien plus rapide que de viser le flux à chaque phrase.
  const url = `https://www.youtube.com/watch?v=${id}`;
  const vfile = path.join(CACHE, `${id}.video.mp4`);
  const afile = path.join(CACHE, `${id}.audio.m4a`);
  console.log('Téléchargement image + son…');
  await ytdlp(['--no-playlist', '-f', 'bv[height<=360][ext=mp4]/bv[height<=480]/bv', '-o', vfile, url], 600000);
  await ytdlp(['--no-playlist', '-f', 'ba[ext=m4a]/ba', '-o', afile, url], 600000);

  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, s] of meta.sentences.entries()) {
    const ms = Math.round(s.start * 1000); // même clé que le nom des médias Anki (EI-<id>-<ms>)
    const from = s.audioStart != null ? s.audioStart : Math.max(0, s.start - 0.25);
    const to = s.audioEnd != null ? s.audioEnd : s.end + 0.15;
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-ss', String((s.start + s.end) / 2), '-i', vfile,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(dir, `${ms}.jpg`)], 60000);
    await run(ffmpegPath, ['-y', '-loglevel', 'error', '-ss', String(from), '-to', String(to),
      '-i', afile, '-vn', '-b:a', '64k', path.join(dir, `${ms}.mp3`)], 60000);
    if (i % 20 === 0) console.log(`  phrase ${i + 1}/${meta.sentences.length}`);
  }
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(meta));

  // Liste des vidéos prêtes (accueil du site), la plus récente en tête.
  const indexFile = path.join(OUT, 'index.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch {}
  list = [{ id, title: meta.title, channel: meta.channel, duration: meta.duration },
    ...list.filter(v => v.id !== id)];
  fs.writeFileSync(indexFile, JSON.stringify(list, null, 1));
  console.log(`OK : « ${meta.title} », ${meta.sentences.length} phrases.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
