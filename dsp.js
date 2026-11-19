// Núcleo DSP: FFT, STFT/ISTFT, cepstrum, F0, phase vocoder y conversión.
// Funciona dentro de un Worker (importScripts) o en el hilo principal (respaldo).
const DSP = (() => {
  const TAU = 2 * Math.PI;

  const plans = {};                                  // tablas de giros y bit-reversal por tamaño
  function plan(n) {
    if (plans[n]) return plans[n];
    const c = new Float64Array(n / 2), s = new Float64Array(n / 2), rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { c[i] = Math.cos(TAU * i / n); s[i] = -Math.sin(TAU * i / n); }
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; rev[i] = j; }
    return plans[n] = { c, s, rev };
  }
  function fft(re, im) {
    const n = re.length, { c, s, rev } = plan(n);
    for (let i = 1; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const h = len >> 1, st = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < h; j++, k += st) {
          const a = i + j, b = a + h, wr = c[k], wi = s[k];
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  function ifft(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
  }
  let WT = 'hann';                                  // tipo de ventana activo (RF8)
  const setWindow = t => { WT = t === 'hamming' ? 'hamming' : 'hann'; };
  const hann = n => Float64Array.from({ length: n }, (_, i) => WT === 'hamming' ? 0.54 - 0.46 * Math.cos(TAU * i / n) : 0.5 - 0.5 * Math.cos(TAU * i / n));
  const median = a => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
  const pct = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];

  const lerp = (a, p) => { p = Math.max(0, Math.min(a.length - 1, p)); const i = Math.floor(p), f = p - i; return a[i] * (1 - f) + a[Math.min(a.length - 1, i + 1)] * f; };
  const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // F0 con YIN (diferencia normalizada acumulada) sobre una copia diezmada, más Viterbi al estilo pYIN:
  // cada cuadro ofrece varios candidatos de periodo; la mejor ruta penaliza saltos de tono y cambios sonoro/sordo.
  function f0Track(x, sr, N, H, nF, rms, maxR) {
    const f0 = new Float32Array(nF), rho = new Float32Array(nF);
    if (!nF) return { f0, rho };
    const dec = Math.max(1, Math.floor(sr / 8000)), srd = sr / dec, nd = Math.floor(x.length / dec);
    const xd = new Float64Array(nd), cs = new Float64Array(nd + 1);
    for (let i = 0; i < nd; i++) { let s = 0; for (let j = 0; j < dec; j++) s += x[i * dec + j]; xd[i] = s / dec; cs[i + 1] = cs[i] + xd[i] * xd[i]; }
    const tmin = Math.max(2, Math.floor(srd / 400)), tmax = Math.ceil(srd / 70), W = tmax, span = W + tmax;
    if (nd < span) return { f0, rho };
    let nfft = 1; while (nfft < span) nfft <<= 1;
    const ar = new Float64Array(nfft), ai = new Float64Array(nfft), br = new Float64Array(nfft), bi = new Float64Array(nfft);
    const d = new Float64Array(tmax + 1), dn = new Float64Array(tmax + 1), cands = [];
    for (let k = 0; k < nF; k++) {
      const list = []; cands.push(list);
      if (rms[k] < 0.03 * maxR) continue;
      const s = clamp(Math.round((k * H + N / 2) / dec - span / 2), 0, nd - span);
      ar.fill(0); ai.fill(0); br.fill(0); bi.fill(0);
      for (let i = 0; i < W; i++) ar[i] = xd[s + i];
      for (let i = 0; i < span; i++) br[i] = xd[s + i];
      fft(ar, ai); fft(br, bi);
      for (let i = 0; i < nfft; i++) { const u = ar[i] * br[i] + ai[i] * bi[i], v = ar[i] * bi[i] - ai[i] * br[i]; ar[i] = u; ai[i] = v; }
      ifft(ar, ai);                                       // ar[t] = correlación cruzada con retardo t
      const e0 = cs[s + W] - cs[s]; let run = 0; dn[0] = 1;
      for (let t = 1; t <= tmax; t++) {
        d[t] = e0 + (cs[s + t + W] - cs[s + t]) - 2 * ar[t]; run += d[t];
        dn[t] = run > 1e-12 ? d[t] * t / run : 1;
      }
      for (let t = tmin; t < tmax; t++) {
        if (!(dn[t] < dn[t - 1] && dn[t] <= dn[t + 1] && dn[t] < 0.5)) continue;
        const den = dn[t - 1] - 2 * dn[t] + dn[t + 1], tau = t + (den > 1e-12 ? clamp(0.5 * (dn[t - 1] - dn[t + 1]) / den, -1, 1) : 0);
        const dnorm = d[t] / (e0 + cs[s + t + W] - cs[s + t] + 1e-12);
        list.push({ f: srd / tau, c: dn[t] + 0.04 * Math.log2(t / tmin), rho: 1 - dnorm });   // leve preferencia por el periodo menor
      }
      list.sort((p, q) => p.c - q.c); list.length = Math.min(list.length, 5);
    }
    const U = 0.35, LJ = 4, SW = 0.2, back = [];          // costo sordo, penalización por octava, costo de cambiar sonoro/sordo
    let pc = null, pl = null;
    for (let k = 0; k < nF; k++) {
      const list = cands[k], n = list.length + 1, cost = new Float64Array(n), bp = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const vi = i < list.length, obs = vi ? list[i].c : U;
        if (!pc) { cost[i] = obs; bp[i] = -1; continue; }
        let best = Infinity, bj = 0;
        for (let j = 0; j <= pl.length; j++) {
          const vj = j < pl.length, tr = vi && vj ? LJ * Math.abs(Math.log2(list[i].f / pl[j].f)) : (vi !== vj ? SW : 0);
          if (pc[j] + tr < best) { best = pc[j] + tr; bj = j; }
        }
        cost[i] = best + obs; bp[i] = bj;
      }
      back.push(bp); pc = cost; pl = list;
    }
    let i = 0; for (let j = 1; j < pc.length; j++) if (pc[j] < pc[i]) i = j;
    for (let k = nF - 1; k >= 0; k--) { const list = cands[k]; if (i < list.length) { f0[k] = list[i].f; rho[k] = list[i].rho; } i = back[k][i]; }
    return { f0, rho };
  }

  // Inclinación espectral: pendiente (dB por octava) de la envolvente media entre 200 y 4000 Hz.
  function tilt(env, sr, N) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let b = 1; b < env.length; b++) {
      const hz = b * sr / N; if (hz < 200 || hz > 4000) continue;
      const xx = Math.log2(hz), yy = env[b] * 20 / Math.LN10; n++; sx += xx; sy += yy; sxx += xx * xx; sxy += xx * yy;
    }
    return n > 2 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  }

  // Análisis por cuadros: F0 (YIN + Viterbi), armonicidad, envolvente media y su variación (liftering del cepstrum).
  function analyze(x, sr, N, H, L, progress) {
    const w = hann(N), nb = N / 2 + 1, nF = Math.max(0, Math.floor((x.length - N) / H) + 1);
    const rms = new Float64Array(nF); let maxR = 0;
    for (let k = 0; k < nF; k++) {
      let s = 0; for (let i = 0; i < N; i += 4) s += x[k * H + i] ** 2;
      rms[k] = Math.sqrt(s / (N / 4)); maxR = Math.max(maxR, rms[k]);
    }
    const { f0, rho } = f0Track(x, sr, N, H, nF, rms, maxR);
    const env = new Float64Array(nb), sh = new Float64Array(nb), sh2 = new Float64Array(nb);
    const re = new Float64Array(N), im = new Float64Array(N), lf = [];
    let nv = 0, lvl = 0, hn = 0;
    for (let k = 0; k < nF; k++) {
      if (progress && k % 200 === 0) progress(k / nF);
      if (!f0[k]) continue;
      for (let i = 0; i < N; i++) { re[i] = x[k * H + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let i = 0; i <= N / 2; i++) { re[i] = Math.log(Math.hypot(re[i], im[i]) + 1e-9); im[i] = 0; }
      for (let i = 1; i < N / 2; i++) { re[N - i] = re[i]; im[N - i] = 0; }
      ifft(re, im);
      for (let i = L + 1; i < N - L; i++) re[i] = 0;      // liftering: solo quefrencias bajas
      im.fill(0); fft(re, im);
      let eb = 0; for (let b = 0; b < nb; b++) eb += re[b]; eb /= nb;
      for (let b = 0; b < nb; b++) { env[b] += re[b]; sh[b] += re[b] - eb; sh2[b] += (re[b] - eb) ** 2; }
      lvl += eb; const r = clamp(rho[k], 0.02, 0.995); hn += 10 * Math.log10(r / (1 - r)); lf.push(Math.log(f0[k])); nv++;
    }
    if (nv < 3) throw new Error('No se detectó voz sonora. Graba más fuerte o por más tiempo.');
    const envSd = new Float64Array(nb);
    for (let b = 0; b < nb; b++) { env[b] /= nv; envSd[b] = Math.sqrt(Math.max(0, sh2[b] / nv - (sh[b] / nv) ** 2)); }
    const sdS = Float64Array.from(envSd, (_, b) => { let s = 0, c = 0; for (let j = Math.max(0, b - 6); j <= Math.min(nb - 1, b + 6); j++) { s += envSd[j]; c++; } return s / c; });
    const voiced = Array.from(f0).filter(v => v > 0), sorted = Float64Array.from(voiced).sort(), lmu = mean(lf);
    return { f0, env, envSd: sdS, lvl: lvl / nv, f0med: median(voiced), f0lo: pct(sorted, 0.1), f0hi: pct(sorted, 0.9),
             lf0mu: lmu, lf0sd: Math.sqrt(mean(lf.map(v => (v - lmu) ** 2))), hnr: hn / nv, tilt: tilt(env, sr, N), nv, nF };
  }

  // Velocidad de habla (sílabas/s): picos de la envolvente de energía suavizada, entre el primer y el último tramo activo.
  function speechRate(x, sr) {
    const hop = Math.round(0.01 * sr), n = Math.floor(x.length / hop), e = new Float64Array(n);
    for (let k = 0; k < n; k++) { let s = 0; for (let i = 0; i < hop; i += 2) s += x[k * hop + i] ** 2; e[k] = Math.sqrt(s / (hop / 2)); }
    const sm = Float64Array.from(e, (_, k) => { let s = 0, c = 0; for (let j = Math.max(0, k - 3); j <= Math.min(n - 1, k + 3); j++) { s += e[j]; c++; } return s / c; });
    let mx = 0; for (const v of sm) mx = Math.max(mx, v);
    let first = -1, last = -1, peaks = 0, lastPk = -100;
    for (let k = 0; k < n; k++) if (sm[k] > 0.1 * mx) { if (first < 0) first = k; last = k; }
    for (let k = 3; k < n - 3; k++) {
      if (sm[k] < 0.25 * mx || !(sm[k] >= sm[k - 1] && sm[k] > sm[k + 1]) || k - lastPk < 10) continue;
      let vmin = sm[k]; for (let j = Math.max(0, k - 12); j < k; j++) vmin = Math.min(vmin, sm[j]);
      if (sm[k] - vmin > 0.2 * sm[k]) { peaks++; lastPk = k; }
    }
    return peaks >= 3 && last > first ? peaks / ((last - first) * 0.01) : null;
  }

  // Deformación del eje de frecuencias (VTLN): busca el factor a que acerca la envolvente de A (evaluada en f/a) a la de B.
  function estimateWarp(envS, envB, sr, N) {
    const b0 = Math.ceil(200 * N / sr), b1 = Math.min(envS.length - 1, Math.floor(5000 * N / sr)), n = b1 - b0 + 1;
    let mb = 0; for (let b = b0; b <= b1; b++) mb += envB[b]; mb /= n;
    let best = 1, bc = Infinity;
    for (let a = 0.6; a <= 1.6001; a += 0.01) {
      const wa = new Float64Array(n); let m = 0;
      for (let i = 0; i < n; i++) { wa[i] = lerp(envS, (b0 + i) / a); m += wa[i]; } m /= n;
      let s = 0; for (let i = 0; i < n; i++) { const df = (wa[i] - m) - (envB[b0 + i] - mb); s += df * df; }
      const c = Math.sqrt(s / n) * 20 / Math.LN10 + 3 * Math.abs(Math.log(a));    // leve preferencia por no deformar
      if (c < bc) { bc = c; best = a; }
    }
    return best;
  }

  // Reasigna una envolvente de otra (sr, N) a la rejilla actual, por frecuencia en Hz.
  function remapEnv(env, srF, NF, sr, N) {
    if (srF === sr && NF === N) return Float64Array.from(env);
    const out = new Float64Array(N / 2 + 1);
    for (let b = 0; b < out.length; b++) {
      const p = Math.min(env.length - 1, b * sr / N * NF / srF), i = Math.floor(p), f = p - i;
      out[b] = env[i] * (1 - f) + env[Math.min(env.length - 1, i + 1)] * f;
    }
    return out;
  }

  // Phase vocoder: estira por s*T y remuestrea por s => tono x s y duración x T.
  // s puede ser un número o una función de la posición (en muestras) para un tono variable por cuadro.
  // lock = true activa el bloqueo de fase por picos espectrales (Laroche y Dolson).
  function pitchShift(x, sIn, T, N, H, lock, progress) {
    const vary = typeof sIn === 'function';
    if (!vary && Math.abs(sIn - 1) < 1e-3 && Math.abs(T - 1) < 1e-3) return Float32Array.from(x);
    const sf = vary ? sIn : () => sIn, w = hann(N), hb = N / 2, pos = [], sk = [];
    for (let p = 0; Math.floor(p) + N <= x.length;) { const s = sf(Math.floor(p)); pos.push(Math.floor(p)); sk.push(s); p += H / (s * T); }
    const nF = pos.length;
    const z = new Float64Array((nF - 1) * H + N), norm = new Float64Array(z.length);
    const prev = new Float64Array(hb + 1), syn = new Float64Array(hb + 1), mag = new Float64Array(hb + 1), ph = new Float64Array(hb + 1);
    const re = new Float64Array(N), im = new Float64Array(N);
    let last = 0;
    for (let k = 0; k < nF; k++) {
      if (progress && k % 100 === 0) progress(k / nF);
      const act = Math.max(1, pos[k] - last);
      for (let i = 0; i < N; i++) { re[i] = x[pos[k] + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b <= hb; b++) {
        mag[b] = Math.hypot(re[b], im[b]); ph[b] = Math.atan2(im[b], re[b]);
        if (k === 0) syn[b] = ph[b];
        else {
          const om = TAU * b / N; let d = ph[b] - prev[b] - om * act;
          d -= TAU * Math.round(d / TAU);
          syn[b] += (om + d / act) * H;
        }
        prev[b] = ph[b];
      }
      if (lock && k > 0) {                              // cada pico propaga su fase a su región de influencia
        const pk = [];
        for (let b = 2; b < hb - 1; b++) if (mag[b] > mag[b - 1] && mag[b] > mag[b - 2] && mag[b] >= mag[b + 1] && mag[b] >= mag[b + 2]) pk.push(b);
        for (let i = 0; i < pk.length; i++) {
          const p = pk[i], lo = i ? (pk[i - 1] + p) >> 1 : 0, hi = i + 1 < pk.length ? (p + pk[i + 1]) >> 1 : hb;
          for (let b = lo; b <= hi; b++) if (b !== p) syn[b] = syn[p] + ph[b] - ph[p];
        }
      }
      for (let b = 0; b <= hb; b++) { re[b] = mag[b] * Math.cos(syn[b]); im[b] = mag[b] * Math.sin(syn[b]); }
      for (let b = 1; b < hb; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      ifft(re, im);
      for (let i = 0; i < N; i++) { z[k * H + i] += re[i] * w[i]; norm[k * H + i] += w[i] * w[i]; }
      last = pos[k];
    }
    const at = i => norm[i] > 1e-6 ? z[i] / norm[i] : 0;
    if (!vary) {
      const y = new Float32Array(Math.floor(x.length * T));
      for (let n = 0; n < y.length; n++) {
        const p = n * sIn, i = Math.floor(p), f = p - i;
        if (i + 1 >= z.length) break;
        y[n] = at(i) * (1 - f) + at(i + 1) * f;
      }
      return y;
    }
    const cap = Math.ceil(x.length * T * 1.5) + 16, y = new Float32Array(cap);
    let P = 0, n = 0;                                   // lectura con velocidad variable según el cuadro
    while (n < cap) {
      const i = Math.floor(P); if (i + 1 >= z.length) break;
      y[n++] = at(i) * (1 - (P - i)) + at(i + 1) * (P - i);
      P += sk[Math.min(nF - 1, Math.floor(P / H))];
    }
    return y.slice(0, n);
  }

  // Timbre: multiplica cada cuadro por el cociente de envolventes (objetivo / actual), conservando la fase.
  function applyTimbre(x, gainLog, N, H, progress) {
    const w = hann(N), nF = Math.floor((x.length - N) / H) + 1;
    const y = new Float64Array(x.length), norm = new Float64Array(x.length);
    const g = gainLog.map(Math.exp), re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < nF; k++) {
      if (progress && k % 200 === 0) progress(k / nF);
      for (let i = 0; i < N; i++) { re[i] = x[k * H + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b <= N / 2; b++) { re[b] *= g[b]; im[b] *= g[b]; }
      for (let b = 1; b < N / 2; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      ifft(re, im);
      for (let i = 0; i < N; i++) { y[k * H + i] += re[i] * w[i]; norm[k * H + i] += w[i] * w[i]; }
    }
    return Float32Array.from(y, (v, i) => norm[i] > 1e-6 ? v / norm[i] : x[i]);
  }

  // Timbre por cuadro: deforma la envolvente (VTLN), iguala su variación y ajusta el soplo, conservando los armónicos.
  // o: { gMean, tgt, curW, warp, ratio, voiced, alpha, noiseRatio, spacing, gamma }
  function timbreFrames(x, N, H, L, o, progress) {
    const w = hann(N), hb = N / 2, nb = hb + 1, nF = Math.floor((x.length - N) / H) + 1;
    const y = new Float64Array(x.length), norm = new Float64Array(x.length);
    const re = new Float64Array(N), im = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N);
    const lm = new Float64Array(nb), e = new Float64Array(nb), pre = new Float64Array(nb + 1), gM = Float64Array.from(o.gMean, v => clamp(o.alpha * v, -3, 3));
    for (let k = 0; k < nF; k++) {
      if (progress && k % 100 === 0) progress(k / nF);
      for (let i = 0; i < N; i++) { re[i] = x[k * H + i] * w[i]; im[i] = 0; }
      fft(re, im);
      if (!o.voiced[k]) {
        for (let b = 0; b < nb; b++) { const g = Math.exp(gM[b]); re[b] *= g; im[b] *= g; }
      } else {
        for (let b = 0; b < nb; b++) lm[b] = Math.log(Math.hypot(re[b], im[b]) + 1e-9);
        for (let b = 0; b < nb; b++) { cr[b] = lm[b]; ci[b] = 0; }
        for (let b = 1; b < hb; b++) { cr[N - b] = lm[b]; ci[N - b] = 0; }
        ifft(cr, ci);
        for (let i = L + 1; i < N - L; i++) cr[i] = 0;
        ci.fill(0); fft(cr, ci);                            // cr = envolvente del cuadro (log)
        let eb = 0; for (let b = 0; b < nb; b++) { e[b] = cr[b]; eb += e[b]; } eb /= nb;
        const wk = o.warp === 1 ? e : Float64Array.from(e, (_, b) => lerp(e, b / o.warp)), wb = o.warp === 1 ? eb : mean(wk);
        for (let b = 0; b < nb; b++) {
          const dev = (wk[b] - wb) - o.curW[b];
          let g = o.alpha * (o.tgt[b] + (o.ratio ? o.ratio[b] : 1) * dev - (e[b] - eb));
          if (o.gamma > 0) g += o.gamma * Math.min(0, lm[b] - e[b]);       // más limpio: hunde los valles entre armónicos
          g = clamp(g, -3, 3);
          const f = Math.exp(g); re[b] *= f; im[b] *= f;
        }
        if (o.noiseRatio > 0) {                              // más soplado: ruido con la densidad de potencia local de la voz
          pre[0] = 0; for (let b = 0; b < nb; b++) pre[b + 1] = pre[b] + re[b] * re[b] + im[b] * im[b];
          const hw = Math.max(2, Math.round(o.spacing));
          for (let b = 0; b < nb; b++) {
            const lo = Math.max(0, b - hw), hi = Math.min(nb - 1, b + hw), m = Math.sqrt(o.noiseRatio * (pre[hi + 1] - pre[lo]) / (hi - lo + 1)), ph = TAU * Math.random();
            re[b] += m * Math.cos(ph); im[b] += m * Math.sin(ph);
          }
        }
      }
      for (let b = 1; b < hb; b++) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      ifft(re, im);
      for (let i = 0; i < N; i++) { y[k * H + i] += re[i] * w[i]; norm[k * H + i] += w[i] * w[i]; }
    }
    return Float32Array.from(y, (v, i) => norm[i] > 1e-6 ? v / norm[i] : x[i]);
  }

  // Espectrograma reducido (0-8 kHz) como bytes 0-255 para dibujar en canvas.
  function spec(x, sr) {
    const N = 1024, h = 128, w = Math.max(1, Math.min(600, Math.floor(x.length / 512)));
    const hop = (x.length - N) / w, win = hann(N), data = new Uint8Array(w * h);
    const re = new Float64Array(N), im = new Float64Array(N), maxB = Math.min(N / 2, Math.floor(8000 * N / sr));
    let mx = 1e-9; const db = new Float32Array(w * h);
    for (let c = 0; c < w; c++) {
      const o = Math.floor(c * hop);
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let r = 0; r < h; r++) {
        const b = Math.floor(r / h * maxB), v = 20 * Math.log10(Math.hypot(re[b], im[b]) + 1e-9);
        db[c * h + r] = v; mx = Math.max(mx, v);
      }
    }
    for (let i = 0; i < db.length; i++) data[i] = Math.max(0, Math.min(255, (db[i] - mx + 80) / 80 * 255));
    return { w, h, data };
  }

  function formants(env, sr, N) {
    const f = [];
    for (let b = 3; b < env.length - 1 && f.length < 4; b++) {
      const hz = b * sr / N; if (hz > 4500) break;
      if (hz > 200 && env[b] > env[b - 1] && env[b] >= env[b + 1]) f.push(Math.round(hz));
    }
    return f;
  }

  function buildProfile({ x, sr, opts }) {
    const a = analyze(x, sr, opts.N, opts.N / (opts.hopDiv || 4), opts.L);
    let world = null;                                     // estadísticas para el vocoder fuente-filtro (world.js)
    try { world = worldLib().profileStats(x, sr); } catch (e) { world = null; }
    return { v: 3, world, f0: a.f0med, f0lo: a.f0lo, f0hi: a.f0hi, lf0mu: a.lf0mu, lf0sd: a.lf0sd, nv: a.nv, env: a.env, envSd: a.envSd,
             hnr: a.hnr, tilt: a.tilt, rate: speechRate(x, sr), sr, N: opts.N, formants: formants(a.env, sr, opts.N) };
  }

  function convert({ x, sr, profile, opts }, progress) {
    const { N, L, alpha, lock = true, keepUnvoiced = true, intonation = 'match', vtln = true, varTimbre = true, adjustHNR = true, autoRate = false } = opts;
    const H = N / (opts.hopDiv || 4), p = (a, b) => v => progress && progress(a + v * (b - a));
    let T = opts.stretch || 1, rateInfo = null;
    const A = analyze(x, sr, N, H, L, p(0, .1));

    // Nivel 1.5: igualar la velocidad de habla (sílabas/s) con un time-stretch automático
    if (autoRate && profile.rate) {
      const ra = speechRate(x, sr);
      if (ra) { T = clamp(Math.pow(ra / profile.rate, alpha), 0.5, 2); rateInfo = { A: ra, B: profile.rate, T }; }
    }

    // Nivel 1.1: tono. 'keep' = desplazamiento global; 'match' = media y variación (en log) como B; 'flat' = aplanar hacia B
    const lnB = profile.lf0mu ?? Math.log(profile.f0), sdB = profile.lf0sd ?? Math.log(profile.f0hi / profile.f0lo) / 2.56;
    const semis = clamp(12 * Math.log2(profile.f0 / A.f0med), -12, 12);
    const factor = Math.pow(2, alpha * semis / 12), shiftIt = Math.abs(factor - 1) > 1e-3;
    let applied = alpha * semis, shifted;
    if (intonation === 'keep') {
      shifted = pitchShift(x, factor, T, N, H, lock, p(.1, keepUnvoiced && shiftIt ? .32 : .5));
      if (keepUnvoiced && shiftIt) {
        // RF13: en cuadros sordos se usa la versión sin cambio de tono; la máscara se suaviza para evitar clics.
        const plain = pitchShift(x, 1, T, N, H, lock, p(.32, .5)), nF = A.f0.length, m = new Float64Array(nF);
        for (let k = 0; k < nF; k++) { let s = 0, c = 0; for (let j = Math.max(0, k - 1); j <= Math.min(nF - 1, k + 1); j++) { s += A.f0[j] > 0 ? 1 : 0; c++; } m[k] = s / c; }
        for (let n = 0; n < shifted.length; n++) {
          const fr = clamp((n / T - N / 2) / H, 0, nF - 1), i = Math.floor(fr), f = fr - i;
          const mv = m[i] * (1 - f) + m[Math.min(nF - 1, i + 1)] * f;
          shifted[n] = mv * shifted[n] + (1 - mv) * plain[n];
        }
      }
    } else {
      const g = intonation === 'match' ? clamp(sdB / Math.max(A.lf0sd, 0.01), 0.5, 2) : 0, nF = A.f0.length;
      const raw = new Float64Array(nF), sk = new Float64Array(nF);
      for (let k = 0; k < nF; k++) {
        if (A.f0[k] > 0) { const la = Math.log(A.f0[k]), st = clamp(12 * (lnB + g * (la - A.lf0mu) - la) / Math.LN2, -12, 12); raw[k] = Math.pow(2, alpha * st / 12); }
        else raw[k] = keepUnvoiced ? 1 : factor;          // RF13: sordos sin cambio de tono
      }
      for (let k = 0; k < nF; k++) { let s = 0, c = 0; for (let j = Math.max(0, k - 2); j <= Math.min(nF - 1, k + 2); j++) { s += raw[j]; c++; } sk[k] = s / c; }
      shifted = pitchShift(x, pos => sk[clamp(Math.round(pos / H), 0, nF - 1)], T, N, H, lock, p(.1, .5));
      const v = []; for (let k = 0; k < nF; k++) if (A.f0[k] > 0) v.push(sk[k]);
      applied = v.length ? 12 * Math.log2(mean(v)) : 0;
    }

    // Nivel 1.2-1.4: timbre (media + variación), deformación de formantes y soplo, medidos sobre la señal ya desplazada
    const S = analyze(shifted, sr, N, H, L, p(.5, .6));
    const envB = remapEnv(profile.env, profile.sr, profile.N, sr, N), sdB2 = profile.envSd ? remapEnv(profile.envSd, profile.sr, profile.N, sr, N) : null;
    const warp = vtln ? estimateWarp(S.env, envB, sr, N) : 1;
    const muW = Float64Array.from(S.env, (_, b) => lerp(S.env, b / warp)), mB = mean(envB), mW = mean(muW);
    const tgt = Float64Array.from(envB, v => v - mB), curW = Float64Array.from(muW, v => v - mW), gMean = Float64Array.from(tgt, (v, b) => v - curW[b]);
    const ratio = varTimbre && sdB2 ? Float64Array.from(sdB2, (v, b) => clamp(v / Math.max(lerp(S.envSd, b / warp), 1e-3), 0.5, 2)) : null;
    let noiseRatio = 0, gamma = 0;
    if (adjustHNR && profile.hnr != null) {
      const dh = S.hnr - profile.hnr;
      if (dh > 1.5) noiseRatio = alpha * Math.max(0, Math.pow(10, -profile.hnr / 10) - Math.pow(10, -S.hnr / 10));
      else if (dh < -1.5) gamma = Math.min(0.5, -dh / 24) * alpha;
    }
    const perFrame = warp !== 1 || !!ratio || noiseRatio > 0 || gamma > 0;
    let y = perFrame
      ? timbreFrames(shifted, N, H, L, { gMean, tgt, curW, warp, ratio, voiced: Uint8Array.from(S.f0, v => v > 0 ? 1 : 0), alpha, noiseRatio, spacing: S.f0med * N / sr, gamma }, p(.6, .9))
      : applyTimbre(shifted, gMean.map(v => clamp(alpha * v, -3, 3)), N, H, p(.6, .9));
    const pk = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9), sc = pk(x) / pk(y);
    y = y.map(v => v * sc);
    const C = analyze(y, sr, N, 2 * H, L, p(.9, 1));          // solo para mostrar: basta con la mitad de cuadros
    let wEnv = null;                                          // envolvente CheapTrick para medir el parecido (si hay world.js)
    if (profile.world) try { const Wl = worldLib(), ea = Wl.meanEnv(x, sr); wEnv = { A: ea.env, B: Wl.remapTo(profile.world, sr, ea.Ns), C: Wl.meanEnv(y, sr).env, sr, Ns: ea.Ns }; } catch (e) { wEnv = null; }
    const info = a => ({ f0: a.f0, f0med: a.f0med, env: a.env, lf0sd: a.lf0sd, tilt: a.tilt, hnr: a.hnr });
    return { y, factor, semis, applied, warp, rateInfo, T, noiseRatio, gamma, ratioOn: !!ratio, wEnv, A: info(A), C: info(C),
             envB, specA: spec(x, sr), specC: spec(y, sr) };
  }

  const worldLib = () => typeof WORLD !== 'undefined' ? WORLD : require('./world.js');
  function run(job, progress) {
    setWindow(job.opts && job.opts.win);
    if (job.job === 'profile') return buildProfile(job);
    return job.opts && job.opts.engine === 'world' ? worldLib().convert(job, progress) : convert(job, progress);
  }
  return { run, fft, ifft, spec, analyze, f0Track, remapEnv, pitchShift, applyTimbre, timbreFrames, estimateWarp, speechRate, setWindow };
})();

if (typeof module !== 'undefined') module.exports = DSP;   // permite probarlo con Node
