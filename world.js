// Vocoder fuente-filtro al estilo WORLD (Morise et al., 2016), versión didáctica y simplificada.
// La voz se separa en tres parámetros por cuadro de 5 ms:
//   - F0: YIN + Viterbi (el mismo seguimiento que usa dsp.js).
//   - Envolvente espectral: CheapTrick (ventana adaptada al tono, suavizado lineal y liftering con compensación).
//   - Aperiodicidad por bandas: versión simplificada de D4C, con la autocorrelación de cada banda en el periodo.
// La síntesis coloca un pulso por periodo con respuesta de fase mínima (parte periódica) más ruido filtrado
// (parte aperiódica). Como el tono y la envolvente son independientes, cambiar uno no altera el otro.
const WORLD = (() => {
  const D = typeof DSP !== 'undefined' ? DSP : require('./dsp.js');
  const { fft, ifft } = D;
  const TAU = 2 * Math.PI, FP = 0.005, BANDS = [500, 1500, 3000, 5000, 7500], AP_STEP = 6;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
  const lerp = (a, p) => { p = clamp(p, 0, a.length - 1); const i = Math.floor(p), f = p - i; return a[i] * (1 - f) + a[Math.min(a.length - 1, i + 1)] * f; };
  const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * Math.random()); };

  // Na: FFT de análisis (cabe una ventana de 3 periodos a 70 Hz). Ns: rejilla de la envolvente y de la síntesis.
  function sizes(sr) { let Na = 1; while (Na < 3 * sr / 70 + 2) Na <<= 1; return { Na, Ns: Na / 2 }; }

  // Aperiodicidad (0 = periódica, 1 = ruido) interpolada desde los centros de banda a una frecuencia dada.
  function apAt(centers, vals, f) {
    if (f <= centers[0]) return vals[0];
    for (let j = 1; j < centers.length; j++) if (f <= centers[j]) { const t = (f - centers[j - 1]) / (centers[j] - centers[j - 1]); return vals[j - 1] * (1 - t) + vals[j] * t; }
    return vals[vals.length - 1];
  }
  function remap(env, srF, NsF, sr, Ns) {
    const out = new Float64Array(Ns / 2 + 1);
    for (let b = 0; b < out.length; b++) out[b] = lerp(env, b * sr / Ns * NsF / srF);
    return out;
  }

  // opt.envStep: calcula la envolvente solo en 1 de cada n cuadros sonoros; opt.noAp: omite la aperiodicidad.
  function analyze(x, sr, progress, opt = {}) {
    const { Na, Ns } = sizes(sr), H = FP * sr, nF = Math.floor(x.length / H) + 1, nb = Ns / 2 + 1, nbA = Na / 2 + 1;
    // Energía por cuadro (25 ms) para la puerta de silencio del seguimiento de F0
    const cs = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i] * x[i];
    const hw = Math.round(0.0125 * sr), rms = new Float64Array(nF); let maxR = 0;
    for (let k = 0; k < nF; k++) { const c = Math.round(k * H), lo = Math.max(0, c - hw), hi = Math.min(x.length, c + hw); rms[k] = Math.sqrt((cs[hi] - cs[lo]) / Math.max(1, hi - lo)); maxR = Math.max(maxR, rms[k]); }
    const { f0 } = D.f0Track(x, sr, 0, H, nF, rms, maxR);

    // ---- CheapTrick: envolvente espectral (log de potencia) ----
    const env = new Array(nF), re = new Float64Array(Na), im = new Float64Array(Na), P = new Float64Array(nbA);
    for (let k = 0; k < nF; k++) {
      if (progress && k % 200 === 0) progress(0.6 * k / nF);
      if (opt.envStep && !(f0[k] > 0 && k % opt.envStep === 0)) { env[k] = null; continue; }
      const f = f0[k] > 0 ? f0[k] : 500, c = Math.round(k * H), hl = Math.min(Na / 2 - 1, Math.round(1.5 * sr / f));
      re.fill(0); im.fill(0); let ws = 0;
      for (let i = -hl; i <= hl; i++) {
        const w = 0.5 + 0.5 * Math.cos(Math.PI * i / (hl + 1)), n = c + i; ws += w * w;
        if (n >= 0 && n < x.length) re[(i + Na) % Na] = x[n] * w;
      }
      fft(re, im);
      for (let b = 0; b < nbA; b++) P[b] = (re[b] * re[b] + im[b] * im[b]) / ws;
      // Suavizado lineal de ancho 2/3 de F0 (con el espectro reflejado en los extremos)
      const wb = Math.max(1, 2 / 3 * f * Na / sr), M = Math.ceil(wb) + 2, S = new Float64Array(nbA + 2 * M + 1);
      for (let j = 0; j < nbA + 2 * M; j++) { let i = j - M; if (i < 0) i = -i; if (i > nbA - 1) i = 2 * (nbA - 1) - i; S[j + 1] = S[j] + P[i]; }
      const F = u => lerp(S, u + M);
      for (let b = 0; b < nbA; b++) re[b] = Math.log(Math.max(1e-14, (F(b + wb / 2 + 0.5) - F(b - wb / 2 + 0.5)) / wb));
      for (let b = 1; b < Na / 2; b++) re[Na - b] = re[b];
      im.fill(0); ifft(re, im);
      // Liftering: sinc (suaviza a la escala de F0) por compensación (recupera la forma de los formantes)
      for (let q = 1; q <= Na / 2; q++) {
        const z = Math.PI * f * q / sr, m = (Math.sin(z) / z) * (1.3 - 0.3 * Math.cos(2 * z));
        re[q] *= m; if (q < Na / 2) re[Na - q] *= m;
      }
      im.fill(0); fft(re, im);
      const e = new Float32Array(nb); for (let b = 0; b < nb; b++) e[b] = re[2 * b];
      env[k] = e;
    }

    if (opt.noAp) return { f0, env, ap: null, sr, H, Na, Ns, centers: null, nF };
    // ---- Aperiodicidad por bandas (D4C simplificado): 1 - autocorrelación normalizada en el periodo ----
    const centers = BANDS.filter(c => c < 0.45 * sr), nB = centers.length, Nd = 2 * Na, nbD = Na + 1;
    const masks = centers.map((c, j) => Float64Array.from({ length: nbD }, (_, b) => {
      const hz = b * sr / Nd, lo = j ? centers[j - 1] : 0, hi = j < nB - 1 ? centers[j + 1] : Infinity;
      if (hz <= lo || hz >= hi) return j === 0 && hz <= c ? 1 : 0;
      if (hz <= c) return j === 0 ? 1 : (hz - lo) / (c - lo);
      return hi === Infinity ? 1 : (hi - hz) / (hi - c);
    }));
    const dr = new Float64Array(Nd), di = new Float64Array(Nd), br = new Float64Array(Nd), bi = new Float64Array(Nd), win = new Float64Array(Na + 1);
    const ap = new Array(nF), done = new Uint8Array(nF);
    let last = -AP_STEP;
    for (let k = 0; k < nF; k++) {
      if (progress && k % 200 === 0) progress(0.6 + 0.4 * k / nF);
      if (!(f0[k] > 0)) { ap[k] = new Float32Array(nB).fill(1); continue; }
      if (k - last < AP_STEP && f0[k - 1] > 0) continue;
      last = k; done[k] = 1;
      const T0 = sr / f0[k], Lw = Math.min(Na, Math.round(4 * T0)), hl = Lw >> 1, c = Math.round(k * H);
      dr.fill(0); di.fill(0);
      for (let i = 0; i < 2 * hl; i++) { const w = 0.5 - 0.5 * Math.cos(TAU * (i + 0.5) / (2 * hl)), n = c - hl + i; win[i] = w; if (n >= 0 && n < x.length) dr[i] = x[n] * w; }
      fft(dr, di);
      const t0 = Math.round(T0); let w0 = 0, wt = 0;
      for (let i = 0; i < 2 * hl; i++) { w0 += win[i] * win[i]; if (i + t0 < 2 * hl) wt += win[i] * win[i + t0]; }
      const wac = Math.max(1e-6, wt / w0), out = new Float32Array(nB);
      for (let j = 0; j < nB; j++) {
        for (let b = 0; b < nbD; b++) br[b] = (dr[b] * dr[b] + di[b] * di[b]) * masks[j][b];
        for (let b = 1; b < Na; b++) br[Nd - b] = br[b];
        bi.fill(0); ifft(br, bi);
        let tb = t0; for (let t = t0 - 1; t <= t0 + 1; t++) if (br[t] > br[tb]) tb = t;
        const a = br[tb - 1], m = br[tb], z = br[tb + 1], den = a - 2 * m + z;
        const peak = den < 0 ? m - 0.125 * (a - z) * (a - z) / den : m;
        const rho = br[0] > 1e-18 ? peak / br[0] / wac : 0;
        out[j] = clamp(1 - rho, 0.001, 1);
      }
      ap[k] = out;
    }
    // Cuadros sonoros no calculados: interpolación entre los calculados vecinos del mismo tramo sonoro
    let prev = -1;
    const next = new Int32Array(nF).fill(-1);
    for (let k = nF - 1, nx = -1; k >= 0; k--) { if (!(f0[k] > 0)) nx = -1; else if (done[k]) nx = k; next[k] = nx; }
    for (let k = 0; k < nF; k++) {
      if (!(f0[k] > 0)) { prev = -1; continue; }
      if (done[k]) { prev = k; continue; }
      const p = prev, n = next[k];
      if (p >= 0 && n >= 0) { const t = (k - p) / (n - p); ap[k] = Float32Array.from(ap[p], (v, j) => v * (1 - t) + ap[n][j] * t); }
      else ap[k] = Float32Array.from(ap[p >= 0 ? p : n]);
    }
    return { f0, env, ap, sr, H, Na, Ns, centers, nF };
  }

  // Espectro de fase mínima cuya magnitud es sqrt(P), a partir del log de potencia (vía cepstrum).
  function minPhase(logP, Ns, mr, mi) {
    const h = Ns / 2;
    for (let b = 0; b <= h; b++) mr[b] = 0.5 * logP[b];
    for (let b = 1; b < h; b++) mr[Ns - b] = mr[b];
    mi.fill(0); ifft(mr, mi);
    for (let n = 1; n < h; n++) mr[n] *= 2;
    for (let n = h + 1; n < Ns; n++) mr[n] = 0;
    mi.fill(0); fft(mr, mi);
    for (let b = 0; b <= h; b++) { const a = Math.exp(mr[b]); mr[b] = a * Math.cos(mi[b]); mi[b] = a * Math.sin(mi[b]); }
  }

  function synthesize(p, len, progress) {
    const { f0, env, ap, sr, H, Ns, centers, nF } = p, h = Ns / 2, nb = h + 1;
    const y = new Float64Array(len + Ns + 1), mr = new Float64Array(Ns), mi = new Float64Array(Ns), apb = new Float64Array(nb);
    const yr = new Float64Array(Ns), yi = new Float64Array(Ns), nr = new Float64Array(Ns), ni = new Float64Array(Ns);
    let t = 0, cached = -1, cnt = 0;
    while (t < len) {
      if (progress && ++cnt % 400 === 0) progress(t / len);
      const pos = t / H, j = Math.min(nF - 1, Math.round(pos)), i0 = Math.min(nF - 1, Math.floor(pos)), i1 = Math.min(nF - 1, i0 + 1), fr = pos - i0;
      const f = f0[j] > 0 ? (f0[i0] > 0 && f0[i1] > 0 ? f0[i0] * (1 - fr) + f0[i1] * fr : f0[j]) : 0;
      const voiced = f > 0, T0 = voiced ? sr / f : sr / 200;
      if (j !== cached) {
        minPhase(env[j], Ns, mr, mi);
        for (let b = 0; b < nb; b++) apb[b] = apAt(centers, ap[j], b * sr / Ns);
        cached = j;
      }
      const n0 = Math.floor(t), L = Math.max(1, Math.round(T0));
      nr.fill(0); ni.fill(0); for (let i = 0; i < L; i++) nr[i] = gauss();
      fft(nr, ni);
      const st = -TAU * (t - n0) / Ns, cs = Math.cos(st), sn = Math.sin(st);
      let c = 1, s = 0;                                      // giro de fase para el desfase fraccionario del pulso
      for (let b = 0; b < nb; b++) {
        let r = 0, im2 = 0;
        if (voiced) { const a = Math.sqrt((1 - apb[b]) * T0), pr = mr[b] * c - mi[b] * s, pi = mr[b] * s + mi[b] * c; r = a * pr; im2 = a * pi; }
        const na = Math.sqrt(apb[b]);
        r += na * (nr[b] * mr[b] - ni[b] * mi[b]); im2 += na * (nr[b] * mi[b] + ni[b] * mr[b]);
        yr[b] = r; yi[b] = im2;
        const tc = c * cs - s * sn; s = c * sn + s * cs; c = tc;
      }
      yi[0] = 0; yi[h] = 0;
      for (let b = 1; b < h; b++) { yr[Ns - b] = yr[b]; yi[Ns - b] = -yi[b]; }
      ifft(yr, yi);
      for (let i = 0; i < Ns; i++) y[n0 + i] += yr[i];
      t += T0;
    }
    return Float32Array.from(y.subarray(0, len));
  }

  // Envolvente CheapTrick media de los cuadros sonoros (para medir el parecido de timbre de forma fiel).
  function meanEnv(x, sr) {
    const p = analyze(x, sr, null, { envStep: 8, noAp: true }), nb = p.Ns / 2 + 1, m = new Float64Array(nb); let n = 0;
    for (const e of p.env) if (e) { for (let b = 0; b < nb; b++) m[b] += e[b]; n++; }
    return { env: n ? m.map(v => v / n) : m, sr, Ns: p.Ns };
  }
  const remapTo = (W, sr, Ns) => remap(W.envMu, W.sr, W.Ns, sr, Ns);

  // Estadísticas de la voz objetivo en el dominio del vocoder (se guardan en el perfil de B).
  function profileStats(x, sr, progress) {
    const p = analyze(x, sr, progress), nb = p.Ns / 2 + 1, nB = p.centers.length;
    const mu = new Float64Array(nb), s1 = new Float64Array(nb), s2 = new Float64Array(nb), apL = new Float64Array(nB);
    let n = 0;
    for (let k = 0; k < p.nF; k++) {
      if (!(p.f0[k] > 0)) continue;
      const e = p.env[k], eb = mean(e);
      for (let b = 0; b < nb; b++) { const c = e[b] - eb; mu[b] += e[b]; s1[b] += c; s2[b] += c * c; }
      for (let j = 0; j < nB; j++) apL[j] += Math.log(p.ap[k][j]);
      n++;
    }
    if (n < 3) throw new Error('No se detectó voz sonora. Graba más fuerte o por más tiempo.');
    const sd = Float64Array.from(s2, (v, b) => Math.sqrt(Math.max(0, v / n - (s1[b] / n) ** 2)));
    return { sr, Ns: p.Ns, centers: p.centers, envMu: mu.map(v => v / n), envSd: smooth(sd, 3), apMu: apL.map(v => Math.exp(v / n)) };
  }
  function smooth(a, r) { return Float64Array.from(a, (_, b) => { let s = 0, c = 0; for (let j = Math.max(0, b - r); j <= Math.min(a.length - 1, b + r); j++) { s += a[j]; c++; } return s / c; }); }

  function convert({ x, sr, profile, opts }, progress) {
    const W = profile.world;
    if (!W) throw new Error('Este perfil no tiene datos del vocoder fuente-filtro. Vuelve a crear el perfil de B.');
    const { alpha, intonation = 'match', vtln = true, varTimbre = true, adjustHNR = true, autoRate = false, N, L } = opts;
    const pr = (a, b) => v => progress && progress(a + v * (b - a));
    const A = analyze(x, sr, pr(0, .35)), { Ns, nF, H, centers } = A, nb = Ns / 2 + 1, nB = centers.length;
    const vk = []; for (let k = 0; k < nF; k++) if (A.f0[k] > 0) vk.push(k);
    if (vk.length < 3) throw new Error('No se detectó voz sonora en tu grabación. Graba más fuerte o por más tiempo.');

    // Velocidad de habla (opcional)
    let T = opts.stretch || 1, rateInfo = null;
    if (autoRate && profile.rate) { const ra = D.speechRate(x, sr); if (ra) { T = clamp(Math.pow(ra / profile.rate, alpha), 0.5, 2); rateInfo = { A: ra, B: profile.rate, T }; } }

    // Tono: media y variación de log F0 (o solo desplazamiento, o aplanado), sin tocar la envolvente
    const lf = vk.map(k => Math.log(A.f0[k])), muA = mean(lf), sdA = Math.sqrt(mean(lf.map(v => (v - muA) ** 2)));
    const lnB = profile.lf0mu ?? Math.log(profile.f0), sdB = profile.lf0sd ?? Math.log(profile.f0hi / profile.f0lo) / 2.56;
    const g = intonation === 'match' ? clamp(sdB / Math.max(sdA, 0.01), 0.5, 2) : 0;
    const f0n = new Float32Array(nF); let shiftSum = 0;
    for (const k of vk) {
      const la = Math.log(A.f0[k]), lt = intonation === 'keep' ? la + lnB - muA : lnB + g * (la - muA);
      const d = alpha * clamp(lt - la, -Math.LN2, Math.LN2); f0n[k] = Math.exp(la + d); shiftSum += d;
    }
    const applied = 12 * shiftSum / vk.length / Math.LN2;

    // Envolvente: deformación de frecuencias (VTLN) y ajuste a la media y la variación de B
    const envB = remap(W.envMu, W.sr, W.Ns, sr, Ns), sdBe = remap(W.envSd, W.sr, W.Ns, sr, Ns);
    const muAe = new Float64Array(nb), s1 = new Float64Array(nb), s2 = new Float64Array(nb);
    for (const k of vk) { const e = A.env[k], eb = mean(e); for (let b = 0; b < nb; b++) { muAe[b] += e[b]; const c = e[b] - eb; s1[b] += c; s2[b] += c * c; } }
    const nv = vk.length; for (let b = 0; b < nb; b++) muAe[b] /= nv;
    const sdAe = smooth(Float64Array.from(s2, (v, b) => Math.sqrt(Math.max(0, v / nv - (s1[b] / nv) ** 2))), 3);
    const warp = vtln ? D.estimateWarp(muAe.map(v => v / 2), envB.map(v => v / 2), sr, Ns) : 1;
    const wMu = Float64Array.from(muAe, (_, b) => lerp(muAe, b / warp)), mW = mean(wMu), mB = mean(envB);
    const curW = wMu.map(v => v - mW), tgt = envB.map(v => v - mB);
    const ratio = varTimbre ? Float64Array.from(sdBe, (v, b) => clamp(v / Math.max(lerp(sdAe, b / warp), 1e-3), 0.5, 2)) : null;
    const envN = new Array(nF), ew = new Float64Array(nb);
    for (let k = 0; k < nF; k++) {
      const e = A.env[k], eb = mean(e), voiced = A.f0[k] > 0;
      for (let b = 0; b < nb; b++) ew[b] = lerp(e, b / warp);
      const ewb = mean(ew), o = new Float32Array(nb);
      for (let b = 0; b < nb; b++) {
        const dev = ew[b] - ewb, target = voiced ? eb + tgt[b] + (ratio ? ratio[b] : 1) * (dev - curW[b]) : eb + dev;
        o[b] = e[b] + alpha * (target - e[b]);
      }
      envN[k] = o;
    }

    // Aperiodicidad: llevar la media geométrica por banda hacia la de B (más o menos soplo)
    const apBc = centers.map(c => apAt(W.centers, W.apMu, c)), apAm = centers.map((_, j) => Math.exp(mean(vk.map(k => Math.log(A.ap[k][j])))));
    const apN = A.ap.map((a, k) => !(A.f0[k] > 0) || !adjustHNR ? a : Float32Array.from(a, (v, j) => clamp(Math.exp(Math.log(v) + alpha * (Math.log(apBc[j]) - Math.log(apAm[j]))), 0.001, 1)));
    const apShift = adjustHNR ? 10 * alpha * mean(centers.map((_, j) => Math.log10(apBc[j] / apAm[j]))) : 0;

    // Cambio de duración: se remuestrean las secuencias de parámetros (el tono no cambia)
    let P = { f0: f0n, env: envN, ap: apN, sr, H, Ns, centers, nF };
    if (Math.abs(T - 1) > 1e-3) {
      const nO = Math.max(1, Math.round((nF - 1) * T) + 1), f0o = new Float32Array(nO), eo = new Array(nO), ao = new Array(nO);
      for (let j = 0; j < nO; j++) {
        const s = Math.min(nF - 1, j / T), i0 = Math.floor(s), i1 = Math.min(nF - 1, i0 + 1), fr = s - i0, ni = Math.round(s);
        f0o[j] = f0n[i0] > 0 && f0n[i1] > 0 ? f0n[i0] * (1 - fr) + f0n[i1] * fr : f0n[ni];
        eo[j] = Float32Array.from(envN[i0], (v, b) => v * (1 - fr) + envN[i1][b] * fr);
        ao[j] = Float32Array.from(apN[i0], (v, b) => v * (1 - fr) + apN[i1][b] * fr);
      }
      P = { ...P, f0: f0o, env: eo, ap: ao, nF: nO };
    }
    let y = synthesize(P, Math.round(x.length * T), pr(.35, .85));

    // Mismo volumen eficaz que A, sin saturar
    const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) || 1e-9;
    let sc = rms(x) / rms(y); const pk = y.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
    if (pk * sc > 0.99) sc = 0.99 / pk;
    y = y.map(v => v * sc);

    // Medidas para la comparación (mismo análisis que el motor de phase vocoder)
    const H2 = 2 * N / (opts.hopDiv || 4), Ad = D.analyze(x, sr, N, H2, L, pr(.85, .92)), C = D.analyze(y, sr, N, H2, L, pr(.92, 1));
    const wEnv = { A: muAe, B: envB, C: meanEnv(y, sr).env, sr, Ns };
    const info = a => ({ f0: a.f0, f0med: a.f0med, env: a.env, lf0sd: a.lf0sd, tilt: a.tilt, hnr: a.hnr });
    const semis = clamp(12 * Math.log2(profile.f0 / Ad.f0med), -12, 12);
    return { y, engine: 'world', factor: Math.pow(2, applied / 12), semis, applied, warp, rateInfo, T, apShift, noiseRatio: 0, gamma: 0,
             ratioOn: !!ratio, wEnv, A: info(Ad), C: info(C), envB: D.remapEnv(profile.env, profile.sr, profile.N, sr, N), specA: D.spec(x, sr), specC: D.spec(y, sr) };
  }

  return { analyze, synthesize, profileStats, convert, meanEnv, remapTo, minPhase, sizes };
})();
if (typeof module !== 'undefined') module.exports = WORLD;   // permite probarlo con Node
