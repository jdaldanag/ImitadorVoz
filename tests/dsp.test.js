// Pruebas del DSP con señales sintéticas. Ejecutar: node tests/dsp.test.js
const assert = require('assert');
const DSP = require('../dsp.js');
const WORLD = require('../world.js');
const TAU = 2 * Math.PI, sr = 16000, N = 2048;
let ok = 0, fail = 0;
const test = (name, fn) => { try { fn(); console.log('ok     ', name); ok++; } catch (e) { console.log('FALLA  ', name, '\n        ', e.message); fail++; } };
// Voz sintética: armónicos 1/h^tilt; dev = desviación de F0 en Hz (vibrato a 1.5 Hz); am = sílabas por segundo (modulación de amplitud)
const voice = (f0, tilt, sec = 3, dev = 0, am = 0, fs = sr) => Float32Array.from({ length: fs * sec }, (_, i) => {
  const t = i / fs, ph = TAU * f0 * t + (dev ? dev / 1.5 * Math.sin(TAU * 1.5 * t) : 0); let v = 0;
  for (let h = 1; h <= 12; h++) v += Math.sin(h * ph) / h ** tilt;
  return 0.2 * v * (am ? 0.5 * (1 - Math.cos(TAU * am * t)) : 1);
});
const cents = (a, b) => 1200 * Math.log2(a / b);
const dist = (p, q, nb) => { const k = 20 / Math.LN10, a = Array.from(p.slice(0, nb), v => v * k), b = Array.from(q.slice(0, nb), v => v * k);
  const ma = a.reduce((s, v) => s + v) / nb, mb = b.reduce((s, v) => s + v) / nb; return Math.sqrt(a.reduce((s, v, i) => s + (v - ma - b[i] + mb) ** 2, 0) / nb); };
const prof = (x, o = {}) => DSP.run({ job: 'profile', x, sr, opts: { N, L: 40, ...o } });
const conv = (x, profile, o = {}) => DSP.run({ job: 'convert', x, sr, profile, opts: { N, L: 40, alpha: 1, ...o } }, () => {});

// ---- Base: FFT y STFT/ISTFT ----
test('FFT: una senoidal cae en su bin', () => {
  const re = Float64Array.from({ length: 1024 }, (_, i) => Math.sin(TAU * 50 * i / 1024)), im = new Float64Array(1024);
  DSP.fft(re, im); let m = 0, bi = 0; for (let i = 0; i < 512; i++) { const v = Math.hypot(re[i], im[i]); if (v > m) { m = v; bi = i; } }
  assert.strictEqual(bi, 50);
});
test('IFFT(FFT(x)) recupera x', () => {
  const x = Float64Array.from({ length: 512 }, () => Math.random() - 0.5), re = Float64Array.from(x), im = new Float64Array(512);
  DSP.fft(re, im); DSP.ifft(re, im); assert.ok(x.every((v, i) => Math.abs(v - re[i]) < 1e-10));
});
for (const w of ['hann', 'hamming']) test(`STFT -> ISTFT sin modificar: error < -60 dB (${w}, RNF2)`, () => {
  DSP.setWindow(w); const x = voice(150, 1), y = DSP.applyTimbre(x, new Float64Array(N / 2 + 1), N, N / 4);
  let e = 0, p = 0; for (let i = 0; i < x.length; i++) { e += (x[i] - y[i]) ** 2; p += x[i] ** 2; }
  const db = 10 * Math.log10(e / p + 1e-30); assert.ok(db < -60, `error ${db.toFixed(1)} dB`); DSP.setWindow('hann');
});
test('Timbre por cuadro neutro es la identidad (< -60 dB)', () => {
  const x = voice(150, 1), nb = N / 2 + 1, z = new Float64Array(nb);
  const y = DSP.timbreFrames(x, N, N / 4, 40, { gMean: z, tgt: z, curW: z, warp: 1, ratio: null, voiced: new Uint8Array(1000).fill(1), alpha: 1, noiseRatio: 0, spacing: 10, gamma: 0 });
  let e = 0, p = 0; for (let i = 0; i < x.length; i++) { e += (x[i] - y[i]) ** 2; p += x[i] ** 2; }
  assert.ok(10 * Math.log10(e / p + 1e-30) < -60);
});

// ---- Punto 6: F0 con YIN + Viterbi ----
test('YIN: F0 de 150 Hz con error menor a 2 %', () => {
  const a = DSP.analyze(voice(150, 1), sr, N, N / 4, 40); assert.ok(Math.abs(a.f0med / 150 - 1) < 0.02, `F0 ${a.f0med.toFixed(1)}`);
});
for (const [f, tilt] of [[100, 1], [200, 1.6]]) test(`YIN: ${f} Hz a 44.1 kHz con ventana 2048, sin errores de octava`, () => {
  const fs = 44100, a = DSP.analyze(voice(f, tilt, 3, 0, 0, fs), fs, 2048, 512, 40);
  assert.ok(a.nv / a.nF > 0.9, `sonoros ${(100 * a.nv / a.nF).toFixed(0)} %`); assert.ok(Math.abs(a.f0med / f - 1) < 0.03, `F0 ${a.f0med.toFixed(1)}`);
});
test('YIN: sigue un glissando de 100 a 160 Hz', () => {
  const len = sr * 3, x = Float32Array.from({ length: len }, (_, i) => { const t = i / sr, ph = TAU * (100 * t + 10 * t * t); let v = 0; for (let h = 1; h <= 10; h++) v += Math.sin(h * ph) / h; return 0.2 * v; });
  const a = DSP.analyze(x, sr, N, N / 4, 40), k1 = 10, k2 = a.f0.length - 10, t1 = (k1 * N / 4 + N / 2) / sr, t2 = (k2 * N / 4 + N / 2) / sr;
  assert.ok(Math.abs(a.f0[k1] / (100 + 20 * t1) - 1) < 0.04 && Math.abs(a.f0[k2] / (100 + 20 * t2) - 1) < 0.04, `${a.f0[k1].toFixed(0)} / ${a.f0[k2].toFixed(0)}`);
});
test('YIN: el ruido no se clasifica como sonoro', () => {
  let y = 0; const x = Float32Array.from({ length: sr * 3 }, () => (y = 0.9 * y + Math.random() - 0.5) * 0.1);
  assert.throws(() => DSP.analyze(x, sr, N, N / 4, 40), /No se detectó voz sonora/);
});

// ---- Phase vocoder ----
test('Phase vocoder: factor 1.5 sube el tono 1.5x y conserva la duración', () => {
  const x = voice(150, 1), y = DSP.pitchShift(x, 1.5, 1, N, N / 4, true), a = DSP.analyze(y, sr, N, N / 4, 40);
  assert.strictEqual(y.length, x.length); assert.ok(Math.abs(a.f0med / 225 - 1) < 0.03, `F0 ${a.f0med.toFixed(1)}`);
});
test('Time-stretch 1.5x: duración x1.5 y tono intacto', () => {
  const x = voice(150, 1), y = DSP.pitchShift(x, 1, 1.5, N, N / 4, true), a = DSP.analyze(y, sr, N, N / 4, 40);
  assert.ok(Math.abs(y.length / x.length - 1.5) < 0.01); assert.ok(Math.abs(a.f0med / 150 - 1) < 0.03, `F0 ${a.f0med.toFixed(1)}`);
});
test('Phase locking activado y desactivado dan salida válida', () => {
  const x = voice(150, 1); for (const lock of [true, false]) assert.ok(DSP.pitchShift(x, 1.3, 1, N, N / 4, lock).every(Number.isFinite));
});

// ---- Nivel 1 ----
test('1.1 Entonación: igualar la variación de F0 acerca la desviación de C a la de B', () => {
  const A = voice(120, 1, 4, 10), B = voice(200, 1.6, 4, 40), pB = prof(B), r = conv(A, pB);
  const aA = DSP.analyze(A, sr, N, N / 4, 40), sA = aA.lf0sd, sB = pB.lf0sd, sC = r.C.lf0sd;
  assert.ok(Math.abs(sC - sB) < Math.abs(sA - sB), `σA ${sA.toFixed(3)}  σB ${sB.toFixed(3)}  σC ${sC.toFixed(3)}`);
  assert.ok(Math.abs(cents(r.C.f0med, pB.f0)) < 100, `${cents(r.C.f0med, pB.f0).toFixed(0)} cents`);
});
test('1.1 Entonación: el modo "conservar" mantiene la variación de A', () => {
  const A = voice(120, 1, 4, 10), pB = prof(voice(200, 1.6, 4, 40)), r = conv(A, pB, { intonation: 'keep' }), sA = DSP.analyze(A, sr, N, N / 4, 40).lf0sd;
  assert.ok(Math.abs(r.C.lf0sd - sA) < 0.35 * sA, `σA ${sA.toFixed(3)}  σC ${r.C.lf0sd.toFixed(3)}`);
});
test('1.1 Entonación: el modo "aplanar" reduce la variación', () => {
  const A = voice(120, 1, 4, 10), pB = prof(voice(200, 1.6, 4, 40)), r = conv(A, pB, { intonation: 'flat' }), sA = DSP.analyze(A, sr, N, N / 4, 40).lf0sd;
  assert.ok(r.C.lf0sd < 0.5 * sA && r.y.every(Number.isFinite), `σA ${sA.toFixed(3)}  σC ${r.C.lf0sd.toFixed(3)}`);
});
test('1.3 VTLN: estima el factor de deformación de formantes (1.2)', () => {
  const env = (m) => Float64Array.from({ length: N / 2 + 1 }, (_, b) => [500, 1500, 2500].reduce((s, f) => s + 2 * Math.exp(-0.5 * ((b * sr / N - f * m) / 150) ** 2), 0));
  const a = DSP.estimateWarp(env(1), env(1.2), sr, N); assert.ok(Math.abs(a - 1.2) < 0.07, `α ${a.toFixed(2)}`);
});
test('1.2 Conversión completa: F0 a menos de 100 cents y envolvente más cercana a B (CA1, CA2)', () => {
  const pB = prof(voice(200, 1.6)), r = conv(voice(120, 1), pB), nb = Math.floor(4000 * N / sr);
  const c = cents(r.C.f0med, pB.f0); assert.ok(Math.abs(c) < 100, `${c.toFixed(0)} cents`);
  const dAB = dist(r.A.env, r.envB, nb), dCB = dist(r.C.env, r.envB, nb); assert.ok(dCB < dAB, `A-B ${dAB.toFixed(1)} dB, C-B ${dCB.toFixed(1)} dB`);
});
test('1.2 Sin VTLN ni variación de timbre también funciona (ruta rápida)', () => {
  const pB = prof(voice(200, 1.6)), r = conv(voice(120, 1), pB, { vtln: false, varTimbre: false, adjustHNR: false });
  assert.ok(r.y.every(Number.isFinite) && r.warp === 1 && Math.abs(cents(r.C.f0med, pB.f0)) < 100);
});
test('1.4 Soplo: un objetivo más ruidoso añade ruido a la voz convertida', () => {
  const clean = voice(120, 1, 3), noisyB = voice(200, 1.6, 3).map(v => v + (Math.random() - 0.5) * 0.12), pB = prof(noisyB);
  const hn = DSP.analyze(clean, sr, N, N / 4, 40).hnr; assert.ok(pB.hnr < hn - 3, `HNR B ${pB.hnr.toFixed(1)} vs A ${hn.toFixed(1)}`);
  const r = conv(clean, pB, { vtln: false, varTimbre: false }); assert.ok(r.noiseRatio > 0 && r.y.every(Number.isFinite));
  assert.ok(r.C.hnr < hn - 1, `HNR C ${r.C.hnr.toFixed(1)}`);
});
test('1.4 Inclinación espectral: se mide en dB/octava y es más negativa con tilt mayor', () => {
  const wide = tl => Float32Array.from({ length: sr * 3 }, (_, i) => { let v = 0; for (let h = 1; h <= 45; h++) v += Math.sin(TAU * 150 * h * i / sr) / h ** tl; return 0.2 * v + (Math.random() - 0.5) * 0.004; });
  const t1 = DSP.analyze(wide(0.5), sr, N, N / 4, 40).tilt, t2 = DSP.analyze(wide(2), sr, N, N / 4, 40).tilt;
  assert.ok(t2 < t1 - 1, `tilt ${t1.toFixed(1)} vs ${t2.toFixed(1)} dB/oct`);
});
test('1.5 Velocidad de habla: estima sílabas por segundo', () => {
  for (const r of [3, 5]) { const est = DSP.speechRate(voice(150, 1, 4, 0, r), sr); assert.ok(est && Math.abs(est - r) < 0.2 * r, `real ${r}, estimado ${est && est.toFixed(2)}`); }
});
test('1.5 Velocidad de habla: la conversión iguala el ritmo de B (duración x0.6)', () => {
  const A = voice(120, 1, 4, 0, 3), pB = prof(voice(200, 1.6, 4, 0, 5)), r = conv(A, pB, { autoRate: true });
  assert.ok(Math.abs(r.y.length / A.length - 0.6) < 0.08, `razón ${(r.y.length / A.length).toFixed(2)}`);
});

// ---- Casos conjuntos ----
test('Conversión con consonantes sordas (ruido): sin valores inválidos (RF13)', () => {
  const A = voice(120, 1).map((v, i) => Math.floor(i / sr * 2) % 2 ? (Math.random() - 0.5) * 0.15 : v), pB = prof(voice(200, 1.6));
  for (const intonation of ['keep', 'match']) assert.ok(conv(A, pB, { intonation, keepUnvoiced: true }).y.every(Number.isFinite));
});
test('Hamming y solapamiento 50 % funcionan en la conversión (RF8)', () => {
  const o = { win: 'hamming', hopDiv: 2 }, pB = prof(voice(200, 1.6), o), r = conv(voice(120, 1), pB, o);
  assert.ok(r.y.every(Number.isFinite)); assert.ok(Math.abs(cents(r.C.f0med, pB.f0)) < 100);
});

// ---- Punto 10: vocoder fuente-filtro (tipo WORLD) ----
const rich = (f0, tilt, sec = 3, dev = 0) => Float32Array.from({ length: sr * sec }, (_, i) => {   // 45 armónicos: espectro hasta ~6 kHz
  const t = i / sr, ph = TAU * f0 * t + (dev ? dev / 1.5 * Math.sin(TAU * 1.5 * t) : 0); let v = 0;
  for (let h = 1; h <= 45 && h * f0 < sr / 2; h++) v += Math.sin(h * ph) / h ** tilt; return 0.2 * v + (Math.random() - 0.5) * 0.002; });
const wDist = (e1, e2) => { const ns = WORLD.sizes(sr).Ns, lo = Math.ceil(250 * ns / sr), hi = Math.floor(4000 * ns / sr), k = 10 / Math.LN10;
  const a = Array.from(e1.slice(lo, hi + 1)), b = Array.from(e2.slice(lo, hi + 1)), ma = a.reduce((s, v) => s + v) / a.length, mb = b.reduce((s, v) => s + v) / b.length;
  return k * Math.sqrt(a.reduce((s, v, i) => s + (v - ma - b[i] + mb) ** 2, 0) / a.length); };
test('WORLD: análisis y resíntesis conservan F0 y envolvente', () => {
  const x = rich(150, 1), p = WORLD.analyze(x, sr), y = WORLD.synthesize(p, x.length);
  assert.ok(y.every(Number.isFinite) && y.length === x.length);
  const a = DSP.analyze(y, sr, N, N / 4, 40); assert.ok(Math.abs(a.f0med / 150 - 1) < 0.02, `F0 ${a.f0med.toFixed(1)}`);
  const d = wDist(WORLD.meanEnv(x, sr).env, WORLD.meanEnv(y, sr).env); assert.ok(d < 1.5, `distancia ${d.toFixed(2)} dB`);
});
test('WORLD: la aperiodicidad es baja en voz limpia y sube con ruido', () => {
  const m = p => p.centers.map((_, j) => { let s = 0, n = 0; for (let k = 0; k < p.nF; k++) if (p.f0[k] > 0) { s += p.ap[k][j]; n++; } return s / n; });
  const clean = m(WORLD.analyze(rich(150, 1), sr)), noisy = m(WORLD.analyze(rich(150, 1).map(v => v + (Math.random() - 0.5) * 0.15), sr));
  assert.ok(clean[0] < 0.1 && clean[1] < 0.1, `limpia ${clean.map(v => v.toFixed(2))}`);
  assert.ok(noisy[1] > clean[1] + 0.1 && noisy[2] > clean[2] + 0.1, `ruidosa ${noisy.map(v => v.toFixed(2))}`);
});
test('WORLD: cambiar el tono x1.5 no mueve la envolvente', () => {
  const A = rich(120, 1), pA = prof(A); pA.f0 *= 1.5; pA.lf0mu += Math.log(1.5);
  const r = conv(A, pA, { engine: 'world', intonation: 'keep', vtln: false, varTimbre: false, adjustHNR: false });
  assert.ok(Math.abs(r.C.f0med / 180 - 1) < 0.02, `F0 ${r.C.f0med.toFixed(1)}`);
  const d = wDist(r.wEnv.A, r.wEnv.C); assert.ok(d < 1.5, `distancia ${d.toFixed(2)} dB`);
});
test('WORLD: conversión con F0 a menos de 100 cents y envolvente CheapTrick más cercana a B que con phase vocoder', () => {
  const pB = prof(rich(200, 1.6, 3, 40)), A = rich(120, 1, 3, 10), rW = conv(A, pB, { engine: 'world' }), rP = conv(A, pB);
  const c = cents(rW.C.f0med, pB.f0); assert.ok(Math.abs(c) < 100, `${c.toFixed(0)} cents`);
  const dA = wDist(rW.wEnv.A, rW.wEnv.B), dW = wDist(rW.wEnv.C, rW.wEnv.B), dP = wDist(rP.wEnv.C, rP.wEnv.B);
  assert.ok(dW < dA && dW < dP, `A-B ${dA.toFixed(1)}, WORLD ${dW.toFixed(1)}, phase vocoder ${dP.toFixed(1)} dB`);
});
test('WORLD: intensidad 0 conserva el tono y velocidad 1.5x alarga sin cambiar el tono', () => {
  const pB = prof(rich(200, 1.6)), A = rich(120, 1), r0 = conv(A, pB, { engine: 'world', alpha: 0 });
  assert.ok(Math.abs(r0.C.f0med / 120 - 1) < 0.02, `F0 ${r0.C.f0med.toFixed(1)}`);
  const r1 = conv(A, pB, { engine: 'world', stretch: 1.5 });
  assert.ok(Math.abs(r1.y.length / A.length - 1.5) < 0.01 && Math.abs(cents(r1.C.f0med, pB.f0)) < 100);
});
test('WORLD: un objetivo más soplado sube la aperiodicidad de la salida', () => {
  const pB = prof(rich(200, 1.6).map(v => v + (Math.random() - 0.5) * 0.12)), r = conv(rich(120, 1), pB, { engine: 'world', vtln: false, varTimbre: false });
  assert.ok(r.apShift > 1 && r.y.every(Number.isFinite), `cambio ${r.apShift.toFixed(1)} dB`);
});
test('WORLD: un perfil sin datos del vocoder pide recrearlo', () => {
  const p = prof(rich(200, 1.6)); delete p.world;
  assert.throws(() => conv(rich(120, 1), p, { engine: 'world' }), /Vuelve a crear el perfil/);
});
console.log(`\n${ok} correctas, ${fail} con fallas`); process.exit(fail ? 1 : 0);
