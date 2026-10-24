// Document invisible qui tient le flux de l'onglet (image + son) et enregistre à la demande.
let stream = null, tabId = null, ctx = null, video = null;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen') return;
  handle(msg).then(reply, e => reply({ error: e.message }));
  return true;
});

async function handle(msg) {
  if (msg.type === 'status') return { tabId: stream ? tabId : null };
  if (msg.type === 'start') {
    stop(false);
    const src = { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: src },
      video: { mandatory: { ...src, maxWidth: 3840, maxHeight: 2160 } }
    });
    tabId = msg.tabId;
    // Capturer un onglet coupe son son : on le renvoie vers les haut-parleurs.
    ctx = new AudioContext();
    ctx.createMediaStreamSource(stream).connect(ctx.destination);
    video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => stop(true));
    return { ok: true };
  }
  if (msg.type === 'record') return record(msg);
  return { error: 'type inconnu' };
}

function stop(notify) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (ctx) ctx.close();
  if (notify && tabId != null) chrome.runtime.sendMessage({ type: 'stopped', tabId });
  stream = ctx = video = null;
}

// durationMs : durée du son ; frameAtMs : instant de l'image ; rect : zone de la vidéo
// dans la page (px CSS), viewport : taille de la page (px CSS) pour l'échelle.
async function record({ durationMs, frameAtMs, rect, viewport }) {
  const rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()),
    { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 });
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start();
  const image = new Promise(r => setTimeout(() => r(grab(rect, viewport)), Math.max(0, frameAtMs)));
  await new Promise(r => setTimeout(r, durationMs));
  rec.stop();
  await stopped;
  return { image: await image, audio: await toBase64(new Blob(chunks, { type: 'audio/webm' })) };
}

function grab(rect, viewport) {
  // Chrome peut ajouter des bandes noires autour de l'onglet dans le flux : on centre et on garde le ratio.
  const s = Math.min(video.videoWidth / viewport.width, video.videoHeight / viewport.height);
  const ox = (video.videoWidth - viewport.width * s) / 2, oy = (video.videoHeight - viewport.height * s) / 2;
  const c = document.createElement('canvas');
  c.width = Math.round(rect.width * s);
  c.height = Math.round(rect.height * s);
  c.getContext('2d').drawImage(video, ox + rect.x * s, oy + rect.y * s, rect.width * s, rect.height * s, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

function toBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
