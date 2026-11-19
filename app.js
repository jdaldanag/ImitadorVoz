'use strict';
const MAX_SEC = 180;
const $ = s => document.querySelector(s);
const audio = { A: null, B: null };            // { x: Float32Array, sr }
let ctx, profile = null, busy = false, cancelJob = null;
const getCtx = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());

// ---------- Utilidades ----------
function mono(ab) {
  const x = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / ab.numberOfChannels; }
  return x;
}
function wavUrl(x, sr) {                        // solo para reproducir en <audio>
  const v = new DataView(new ArrayBuffer(44 + x.length * 2)), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + x.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return URL.createObjectURL(new Blob([v], { type: 'audio/wav' }));
}
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------- Estado del micrófono (RF1) ----------
const micState = t => $('#micStatus').textContent = 'Micrófono: ' + t;
if (navigator.permissions) navigator.permissions.query({ name: 'microphone' }).then(p => {
  const map = { granted: 'concedido', denied: 'denegado', prompt: 'se pedirá permiso al grabar' };
  micState(map[p.state] || p.state); p.onchange = () => micState(map[p.state] || p.state);
}).catch(() => {});

// ---------- Grabar y cargar (RF2, RF3, RF4) ----------
function setupSlot(root) {
  const slot = root.dataset.slot, q = s => root.querySelector(s);
  const recBtn = q('.rec-btn'), stopBtn = q('.stop-btn'), pauseBtn = q('.pause-btn'), meter = q('.meter i'), time = q('.time'), player = q('audio'), msg = q('.msg');
  let mr, stream, chunks, timer, raf, stopT, acc = 0, since = 0;
  const say = (t, err) => { msg.textContent = t; msg.classList.toggle('err', !!err); };

  async function load(buf) {
    try {
      const ab = await getCtx().decodeAudioData(buf);
      if (ab.duration > MAX_SEC + 0.5) return say('El audio dura más de 3 minutos. Usa uno más corto.', true);
      audio[slot] = { x: mono(ab), sr: ab.sampleRate };
      player.src = wavUrl(audio[slot].x, ab.sampleRate);
      say(`Listo: ${ab.duration.toFixed(1)} s.` + (slot === 'B' && ab.duration < 30 ? ' Con menos de 30 s el perfil será menos estable.' : ''));
      refresh(); if (slot === 'A') setTimeout(analyzeLoad, 0);
    } catch (e) { say('No se pudo leer el audio. Prueba con WAV, MP3 o M4A.', true); }
  }
  q('input').onchange = async e => { const f = e.target.files[0]; if (f) load(await f.arrayBuffer()); e.target.value = ''; };

  recBtn.onclick = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { micState('denegado'); return say('No hay acceso al micrófono. Habilítalo en el candado de la barra de direcciones y vuelve a intentar.', true); }
    micState('en uso');
    const c = getCtx(), src = c.createMediaStreamSource(stream), an = c.createAnalyser(), buf = new Float32Array(1024);
    an.fftSize = 1024; src.connect(an);
    (function loop() { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; meter.style.width = Math.min(100, Math.sqrt(s / 1024) * 300) + '%'; raf = requestAnimationFrame(loop); })();
    mr = new MediaRecorder(stream); chunks = [];
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = async () => {
      cancelAnimationFrame(raf); meter.style.width = 0; stream.getTracks().forEach(t => t.stop()); src.disconnect();
      clearInterval(timer); clearTimeout(stopT); micState('concedido');
      recBtn.classList.remove('on'); recBtn.disabled = false; stopBtn.disabled = true; pauseBtn.disabled = true; pauseBtn.textContent = 'Pausar';
      load(await new Blob(chunks, { type: mr.mimeType }).arrayBuffer());
    };
    mr.start(); acc = 0; since = Date.now();
    timer = setInterval(() => {
      const el = (acc + (mr.state === 'recording' ? Date.now() - since : 0)) / 1000;
      time.textContent = fmtTime(el); if (el >= MAX_SEC && mr.state !== 'inactive') mr.stop();
    }, 250);
    recBtn.classList.add('on'); recBtn.disabled = true; stopBtn.disabled = false; pauseBtn.disabled = false; say('Grabando…');
  };
  stopBtn.onclick = () => mr && mr.state !== 'inactive' && mr.stop();
  pauseBtn.onclick = () => {                                  // RF2: pausar y reanudar
    if (!mr) return;
    if (mr.state === 'recording') { mr.pause(); acc += Date.now() - since; pauseBtn.textContent = 'Reanudar'; say('En pausa.'); }
    else if (mr.state === 'paused') { mr.resume(); since = Date.now(); pauseBtn.textContent = 'Pausar'; say('Grabando…'); }
  };
}
document.querySelectorAll('.rec').forEach(setupSlot);

// ---------- Perfil guardado localmente (RF9) ----------
const idb = () => new Promise((ok, no) => { const r = indexedDB.open('voz-lab', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const kv = async (mode, fn) => { const d = await idb(); return new Promise((ok, no) => { const t = d.transaction('kv', mode), rq = fn(t.objectStore('kv')); t.oncomplete = () => ok(rq.result); t.onerror = () => no(t.error); }); };
const semis = sd => (12 * sd / Math.LN2).toFixed(1);
function showProfile() {
  const m = $('#profileMsg'); m.classList.remove('err');
  if (!profile) m.textContent = 'Aún no hay perfil guardado.';
  else {
    m.textContent = `Perfil de B: F0 mediana ${profile.f0.toFixed(0)} Hz (rango ${profile.f0lo.toFixed(0)}-${profile.f0hi.toFixed(0)} Hz`
      + (profile.lf0sd != null ? `, variación ${semis(profile.lf0sd)} semitonos` : '') + `), ${profile.nv} cuadros sonoros, `
      + `formantes aprox. ${(profile.formants || []).join(', ') || 'sin detectar'} Hz`
      + (profile.hnr != null ? `, armónico/ruido ${profile.hnr.toFixed(0)} dB, inclinación ${profile.tilt.toFixed(1)} dB/octava` : '')
      + (profile.rate ? `, ${profile.rate.toFixed(1)} sílabas/s` : '') + '. Guardado en este dispositivo.';
    if (profile.v !== 3) { m.textContent += ' Este perfil es de una versión anterior: vuelve a crearlo para usar todas las mejoras de imitación y el vocoder fuente-filtro.'; m.classList.add('err'); }
  }
  refresh();
}
kv('readonly', s => s.get('profile')).then(p => { profile = p || null; showProfile(); }).catch(showProfile);

// ---------- Ejecución del procesamiento: Worker con respaldo en el hilo principal (RF17) ----------
function runJob(job, onProg) {
  return new Promise((resolve, reject) => {
    const inMain = () => { cancelJob = null; setTimeout(() => { try { resolve(DSP.run(job, onProg)); } catch (e) { reject(e); } }, 30); };
    let w; try { w = new Worker('worker.js'); } catch (e) { return inMain(); }
    cancelJob = () => { w.terminate(); reject(new Error('Proceso cancelado.')); };
    w.onmessage = ({ data: d }) => {
      if (d.type === 'progress') onProg && onProg(d.v);
      else { w.terminate(); d.type === 'done' ? resolve(d.result) : reject(new Error(d.message)); }
    };
    w.onerror = () => { w.terminate(); inMain(); };   // p. ej. página abierta como file://
    w.postMessage(job);
  });
}
const opts = () => ({ N: +$('#win').value, L: +$('#lifter').value, alpha: +$('#alpha').value / 100,
  stretch: +$('#stretch').value, lock: $('#lock').checked, keepUnvoiced: $('#unv').checked,
  win: $('#wtype').value, hopDiv: +$('#hop').value, intonation: $('#inton').value,
  vtln: $('#vtln').checked, varTimbre: $('#vart').checked, adjustHNR: $('#hnr').checked, autoRate: $('#rate').checked, engine: $('#engine').value });

function refresh() {
  const ok = $('#consent').checked;
  $('#mkProfile').disabled = !(ok && audio.B && !busy);
  $('#delProfile').disabled = !profile;
  $('#convert').disabled = !(ok && profile && audio.A && !busy);
  $('#cancel').disabled = !busy;
}
$('#consent').onchange = refresh;
$('#alpha').oninput = e => $('#alphaOut').textContent = e.target.value;
$('#lifter').oninput = e => { $('#lifOut').textContent = e.target.value; frameView(); };
$('#stretch').oninput = e => $('#strOut').textContent = (+e.target.value).toFixed(2);
$('#rate').onchange = e => { $('#stretch').disabled = e.target.checked; };
$('#engine').onchange = e => {                                // opciones que solo usa el phase vocoder
  const w = e.target.value === 'world'; ['#lock', '#unv'].forEach(id => { $(id).disabled = w; $(id).parentElement.style.opacity = w ? .5 : 1; });
  if (w && profile && !profile.world) { $('#convMsg').textContent = 'El perfil de B es de una versión anterior: vuelve a crearlo para usar este motor.'; $('#convMsg').classList.add('err'); }
  else { $('#convMsg').textContent = ''; $('#convMsg').classList.remove('err'); }
};
$('#win').onchange = frameView;
$('#wtype').onchange = frameView;
$('#pos').oninput = frameView;

$('#mkProfile').onclick = async () => {
  busy = true; refresh(); $('#profileMsg').textContent = 'Analizando la voz B…'; $('#profileMsg').classList.remove('err');
  try {
    profile = await runJob({ job: 'profile', x: audio.B.x, sr: audio.B.sr, opts: opts() });
    try { await kv('readwrite', s => s.put(profile, 'profile')); } catch (e) {}
    showProfile();
  } catch (e) { $('#profileMsg').textContent = e.message; $('#profileMsg').classList.add('err'); }
  busy = false; refresh();
};
$('#delProfile').onclick = async () => { profile = null; try { await kv('readwrite', s => s.delete('profile')); } catch (e) {} showProfile(); };
$('#cancel').onclick = () => cancelJob && cancelJob();

// ---------- Conversión y comparación (RF10-RF14, RF17, RF19, RF20) ----------
$('#convert').onclick = async () => {
  const o = opts(), msg = $('#convMsg'), prog = $('#prog'), t0 = performance.now();
  busy = true; refresh(); msg.classList.remove('err'); prog.value = 0;
  const onProg = v => { prog.value = v; const el = (performance.now() - t0) / 1000; msg.textContent = `Procesando… ${Math.round(v * 100)} %` + (v > .05 ? `, faltan ~${Math.round(el / v * (1 - v))} s` : ''); };
  try {
    const r = await runJob({ job: 'convert', x: audio.A.x, sr: audio.A.sr, profile, opts: o }, onProg);
    const parts = [`Cambio de tono medio: ${r.applied >= 0 ? '+' : ''}${r.applied.toFixed(1)} semitonos`];
    if (o.vtln) parts.push(`formantes x${r.warp.toFixed(2)}`);
    if (r.engine === 'world') { parts.unshift('Motor fuente-filtro'); if (o.adjustHNR && Math.abs(r.apShift) > 0.5) parts.push(`aperiodicidad ${r.apShift > 0 ? '+' : ''}${r.apShift.toFixed(1)} dB (${r.apShift > 0 ? 'más' : 'menos'} soplo)`); }
    else if (r.noiseRatio > 0) parts.push('se añadió soplo'); else if (r.gamma > 0) parts.push('se redujo el soplo');
    if (r.rateInfo) parts.push(`velocidad x${(1 / r.rateInfo.T).toFixed(2)} (${r.rateInfo.A.toFixed(1)} → ${r.rateInfo.B.toFixed(1)} sílabas/s)`);
    else if (o.autoRate) parts.push('no se pudo medir la velocidad de habla; se mantuvo la duración');
    msg.textContent = `Listo en ${((performance.now() - t0) / 1000).toFixed(1)} s. ` + parts.join(', ') + '.';
    prog.value = 1; show(r, o);
  } catch (e) { msg.textContent = e.message; msg.classList.add('err'); prog.value = 0; }
  busy = false; refresh();
};

function show(r, o) {
  const sr = audio.A.sr;
  $('#stepD').hidden = false;
  $('#pA').src = wavUrl(audio.A.x, sr); $('#pC').src = wavUrl(r.y, sr);
  $('#pB').src = audio.B ? wavUrl(audio.B.x, audio.B.sr) : '';
  const maxBin = Math.min(o.N / 2, Math.floor(8000 * o.N / sr)), k = 20 / Math.LN10;
  const db = e => { const a = Array.from(e.slice(0, maxBin + 1), v => v * k), m = a.reduce((s, v) => s + v, 0) / a.length; return a.map(v => v - m); };
  const eA = db(r.A.env), eB = db(r.envB), eC = db(r.C.env);
  const dist = (p, q) => Math.sqrt(p.reduce((s, v, i) => s + (v - q[i]) ** 2, 0) / p.length);
  const cents = 1200 * Math.log2(r.C.f0med / profile.f0), dAB = dist(eA, eB), dCB = dist(eC, eB);
  // Distancia con la envolvente CheapTrick (sigue las amplitudes reales de los armónicos), de 200 Hz a 5 kHz
  let wRow = '', wPlot = null;
  if (r.wEnv) {
    const { A: wa, B: wb, C: wc, sr: ws, Ns } = r.wEnv, k10 = 10 / Math.LN10, b0 = Math.ceil(200 * Ns / ws), b1 = Math.min(Ns / 2, Math.floor(Math.min(5000, 0.45 * ws) * Ns / ws));
    const seg = e => { const a = Array.from(e.slice(b0, b1 + 1), v => v * k10), m = a.reduce((s, v) => s + v, 0) / a.length; return a.map(v => v - m); };
    const wAB = dist(seg(wa), seg(wb)), wCB = dist(seg(wc), seg(wb));
    wRow = `<tr><td>Distancia de envolvente CheapTrick a B</td><td>${wAB.toFixed(1)} dB</td><td>-</td><td>${wCB.toFixed(1)} dB ${wCB < wAB ? '(más cerca de B)' : '(no mejora)'}</td></tr>`;
    const top = Math.min(Ns / 2, Math.floor(8000 * Ns / ws)), full = e => { const a = Array.from(e.slice(0, top + 1), v => v * k10), m = a.reduce((s, v) => s + v, 0) / a.length; return a.map(v => v - m); };
    wPlot = [full(wa), full(wb), full(wc)];
  }
  $('#stats').innerHTML = `
    <tr><th></th><th>A</th><th>B</th><th>C</th></tr>
    <tr><td>F0 mediana (Hz)</td><td>${r.A.f0med.toFixed(0)}</td><td>${profile.f0.toFixed(0)}</td><td>${r.C.f0med.toFixed(0)}</td></tr>
    <tr><td>Diferencia de C con B</td><td colspan="3">${cents.toFixed(0)} cents ${Math.abs(cents) < 100 ? '(dentro de 100 cents)' : '(fuera de 100 cents)'}</td></tr>
    <tr><td>Distancia de envolvente cepstral a B</td><td>${dAB.toFixed(1)} dB</td><td>-</td><td>${dCB.toFixed(1)} dB ${dCB < dAB ? '(más cerca de B)' : '(no mejora)'}</td></tr>
    ${wRow}
    <tr><td>Variación de F0 (semitonos)</td><td>${semis(r.A.lf0sd)}</td><td>${profile.lf0sd != null ? semis(profile.lf0sd) : '-'}</td><td>${semis(r.C.lf0sd)}</td></tr>
    <tr><td>Armónico/ruido (dB)</td><td>${r.A.hnr.toFixed(0)}</td><td>${profile.hnr != null ? profile.hnr.toFixed(0) : '-'}</td><td>${r.C.hnr.toFixed(0)}</td></tr>
    <tr><td>Inclinación espectral (dB/octava)</td><td>${r.A.tilt.toFixed(1)}</td><td>${profile.tilt != null ? profile.tilt.toFixed(1) : '-'}</td><td>${r.C.tilt.toFixed(1)}</td></tr>`;
  drawSpec($('#sA'), r.specA); drawSpec($('#sC'), r.specC);
  const gap = f => Array.from(f, v => v || NaN);  // C se analizó con la mitad de cuadros: el eje x es relativo
  plot($('#cF0'), [{ d: gap(r.A.f0), color: '#6fa0ee', name: 'A' }, { d: gap(r.C.f0), color: '#f0a050', name: 'C' }, { d: [profile.f0, profile.f0], color: '#8fc06a', name: 'B (med.)' }]);
  const [pa, pb, pc] = wPlot || [eA, eB, eC];
  $('#envCap').textContent = `Envolventes medias ${wPlot ? 'CheapTrick' : 'cepstrales'}, 0 a 8 kHz (dB relativo)`;
  plot($('#cEnv'), [{ d: pa, color: '#6fa0ee', name: 'A' }, { d: pb, color: '#8fc06a', name: 'B' }, { d: pc, color: '#f0a050', name: 'C' }]);
}
['pA', 'pB', 'pC'].forEach(id => $('#' + id).onplay = () => ['pA', 'pB', 'pC'].forEach(o => o !== id && $('#' + o).pause()));

function drawSpec(cv, s) {
  cv.width = s.w; cv.height = s.h;
  const g = cv.getContext('2d'), im = g.createImageData(s.w, s.h);
  for (let c = 0; c < s.w; c++) for (let r = 0; r < s.h; r++) {
    const v = s.data[c * s.h + r], o = ((s.h - 1 - r) * s.w + c) * 4;
    im.data[o] = Math.min(255, v * 3); im.data[o + 1] = Math.max(0, Math.min(255, (v - 85) * 3)); im.data[o + 2] = Math.max(0, Math.min(255, (v - 170) * 3)); im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
}
function plot(cv, series) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, P = 28;
  g.clearRect(0, 0, W, H);
  let lo = Infinity, hi = -Infinity;
  series.forEach(s => s.d.forEach(v => { if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
  const y = v => H - P - (v - lo) / ((hi - lo) || 1) * (H - 2 * P);
  g.font = '12px sans-serif'; g.fillStyle = '#9fb0b8'; g.fillText(hi.toFixed(0), 4, P - 8); g.fillText(lo.toFixed(0), 4, H - P + 14);
  series.forEach((s, si) => {
    g.strokeStyle = g.fillStyle = s.color; g.lineWidth = 1.5; g.beginPath();
    let pen = false; s.d.forEach((v, i) => { if (v !== v) { pen = false; return; } const px = 36 + i / Math.max(1, s.d.length - 1) * (W - 44); pen ? g.lineTo(px, y(v)) : g.moveTo(px, y(v)); pen = true; });
    g.stroke(); g.fillText(s.name, W - 110 + (si % 3) * 36, 16);
  });
}
refresh();

// ---------- Análisis de A (RF5, RF6, RF7): señal, espectrograma, espectro, cepstrum ----------
function analyzeLoad() {
  const { x, sr } = audio.A, bins = 600, step = Math.max(1, Math.floor(x.length / bins)), wv = [];
  $('#anaA').hidden = false;
  for (let i = 0; i < bins; i++) { let m = 0; for (let j = i * step; j < Math.min(x.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(x[j])); wv.push(m); }
  plot($('#aWave'), [{ d: wv, color: '#6fa0ee', name: 'amplitud' }]);
  drawSpec($('#aSpec'), DSP.spec(x, sr));
  frameView();
}
function frameView() {
  if (!audio.A) return;
  const { x, sr } = audio.A, { N, L, win } = opts();
  if (x.length < N) return;
  const o = Math.floor(+$('#pos').value / 100 * (x.length - N)), hb = N / 2, k = 20 / Math.LN10, maxB = Math.min(hb, Math.floor(8000 * N / sr));
  const re = new Float64Array(N), im = new Float64Array(N), lm = new Float64Array(N);
  for (let i = 0; i < N; i++) { const c = Math.cos(2 * Math.PI * i / N); re[i] = x[o + i] * (win === 'hamming' ? 0.54 - 0.46 * c : 0.5 - 0.5 * c); }
  DSP.fft(re, im);
  for (let i = 0; i <= hb; i++) lm[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-9);
  for (let i = 1; i < hb; i++) lm[N - i] = lm[i];
  const specDb = Array.from(lm.slice(0, maxB + 1), v => v * k);
  re.set(lm); im.fill(0); DSP.ifft(re, im);                                   // re = cepstrum real
  const qmin = Math.floor(sr / 400), qmax = Math.min(Math.floor(sr / 70), hb - 1), cep = Array.from(re.slice(2, qmax + 1));
  let q = qmin, pk = -1; for (let i = qmin; i <= qmax; i++) if (re[i] > pk) { pk = re[i]; q = i; }
  for (let m = 4; m >= 2; m--) { const qq = Math.round(q / m); if (qq - 2 < qmin) continue; let bv = -1, bq = qq; for (let i = qq - 2; i <= qq + 2; i++) if (re[i] > bv) { bv = re[i]; bq = i; } if (bv > 0.7 * pk) { q = bq; pk = bv; break; } }
  for (let i = L + 1; i < N - L; i++) re[i] = 0;                              // liftering
  im.fill(0); DSP.fft(re, im);
  plot($('#aSpectrum'), [{ d: specDb, color: '#6fa0ee', name: 'espectro' }, { d: Array.from(re.slice(0, maxB + 1), v => v * k), color: '#f0a050', name: 'envolvente' }]);
  plot($('#aCep'), [{ d: cep, color: '#8fc06a', name: 'cepstrum' }]);
  $('#aInfo').textContent = pk > 0.06 ? `Cuadro sonoro: F0 ≈ ${(sr / q).toFixed(0)} Hz (quefrencia ${q}).` : 'Cuadro sordo o silencio: no hay un pico claro de F0.';
}
