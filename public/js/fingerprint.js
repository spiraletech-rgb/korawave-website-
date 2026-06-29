'use strict';
/**
 * KORAWAVE Audio Fingerprinting
 * Algorithme simplifié de Haitsma & Kalker (base de Shazam).
 *
 * Principe :
 *  1. Diviser l'audio en trames (FRAME_SIZE échantillons, chevauchement 50%)
 *  2. Appliquer une fenêtre de Hann + FFT sur chaque trame
 *  3. Calculer l'énergie dans NUM_BANDS bandes de fréquence log-espacées
 *  4. Pour chaque paire de trames consécutives, signe de la différence d'énergie → bit
 *  5. L'empreinte = tableau de bits (0/1)
 *
 * Correspondance :
 *  - Comparer les empreintes avec décalage temporel variable
 *  - BER (Bit Error Rate) : 0 = identique, 0.5 = aléatoire
 *  - Seuil : BER < 0.35 → correspondance
 */
(function (global) {

  const FRAME_SIZE = 4096;
  const HOP_SIZE   = 2048;   // 50% overlap
  const NUM_BANDS  = 6;
  const SR_TARGET  = 11025;  // on sous-sample pour accélérer

  // Bandes fréquentielles (Hz) — couvrent 300 Hz – 3 kHz (zone musicale clé)
  const BAND_FREQS = [300, 540, 970, 1740, 3125, 5615, 10100];

  function bandBins(sampleRate) {
    return BAND_FREQS.map((f) => Math.max(1, Math.round(f * FRAME_SIZE / sampleRate)));
  }

  // Fenêtre de Hann
  function hann(i, N) { return 0.5 * (1 - Math.cos(2 * Math.PI * i / N)); }

  // FFT de Cooley-Tukey en place (real[] et imag[] doivent avoir une taille puissance de 2)
  function fft(real, imag) {
    const n = real.length;
    // Permutation bit-reversal
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = real[i]; real[i] = real[j]; real[j] = t;
        t = imag[i]; imag[i] = imag[j]; imag[j] = t;
      }
    }
    // Papillons
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        for (let k = 0; k < (len >> 1); k++) {
          const uRe = real[i + k], uIm = imag[i + k];
          const vRe = real[i + k + (len >> 1)] * cRe - imag[i + k + (len >> 1)] * cIm;
          const vIm = real[i + k + (len >> 1)] * cIm + imag[i + k + (len >> 1)] * cRe;
          real[i + k] = uRe + vRe;         imag[i + k] = uIm + vIm;
          real[i + k + (len >> 1)] = uRe - vRe; imag[i + k + (len >> 1)] = uIm - vIm;
          const nr = cRe * wRe - cIm * wIm; cIm = cRe * wIm + cIm * wRe; cRe = nr;
        }
      }
    }
  }

  // Sous-échantillonnage simple par moyenne
  function downsample(samples, factor) {
    const out = new Float32Array(Math.floor(samples.length / factor));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let j = 0; j < factor; j++) s += samples[i * factor + j];
      out[i] = s / factor;
    }
    return out;
  }

  /**
   * Calcule l'empreinte d'un signal audio.
   * @param {Float32Array} samples  Échantillons PCM normalisés [-1, 1]
   * @param {number}       sampleRate
   * @returns {number[]}   Tableau de bits (0 ou 1)
   */
  function computeFingerprint(samples, sampleRate) {
    // Sous-échantillonnage
    const factor = Math.max(1, Math.floor(sampleRate / SR_TARGET));
    const s  = factor > 1 ? downsample(samples, factor) : Float32Array.from(samples);
    const sr = sampleRate / factor;

    const bins   = bandBins(sr);
    const frames = [];
    const N      = FRAME_SIZE;

    for (let off = 0; off + N <= s.length; off += HOP_SIZE) {
      const real = new Float64Array(N);
      const imag = new Float64Array(N);
      for (let i = 0; i < N; i++) real[i] = s[off + i] * hann(i, N);
      fft(real, imag);

      const energy = new Array(NUM_BANDS).fill(0);
      for (let b = 0; b < NUM_BANDS; b++) {
        const lo = bins[b], hi = Math.min(bins[b + 1] || N / 2, N / 2);
        for (let k = lo; k < hi; k++) energy[b] += real[k] * real[k] + imag[k] * imag[k];
      }
      frames.push(energy);
    }

    // Haitsma & Kalker : signe de la différence d'énergie inter-trames → bit
    const bits = [];
    for (let i = 1; i < frames.length; i++) {
      for (let b = 0; b < NUM_BANDS - 1; b++) {
        const diff = (frames[i][b] - frames[i][b + 1]) - (frames[i - 1][b] - frames[i - 1][b + 1]);
        bits.push(diff > 0 ? 1 : 0);
      }
    }
    return bits;
  }

  /**
   * Compare une empreinte requête contre une empreinte stockée.
   * @param {number[]} query   Empreinte de la capture micro
   * @param {number[]} stored  Empreinte stockée en base
   * @param {number}   maxOff  Décalage temporel max à tester (en bits)
   * @returns {number}  Score 0-1 (1 = identique, 0.5 = aléatoire)
   */
  function matchFingerprint(query, stored, maxOff = 80) {
    const len = Math.min(query.length, stored.length, 800);
    if (len < 30) return 0;
    let best = 0;
    for (let off = -maxOff; off <= maxOff; off++) {
      let matches = 0, total = 0;
      for (let i = 0; i < len; i++) {
        const j = i + off;
        if (j < 0 || j >= stored.length) continue;
        if (query[i] === stored[j]) matches++;
        total++;
      }
      if (total > 0 && matches / total > best) best = matches / total;
    }
    return best;
  }

  global.KWFingerprint = { computeFingerprint, matchFingerprint };

})(typeof window !== 'undefined' ? window : global);
