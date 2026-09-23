import { describe, expect, it } from "vitest";
import { kWeight, measureLoudness, truePeakDbtp } from "./loudness";

const SR = 48000;

function sine(freq: number, seconds: number, amplitude = 0.1, rate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

const stereo = (x: Float32Array) => [x, x];

describe("measureLoudness", () => {
  /**
   * Anchored to pyloudnorm, an independent BS.1770 implementation. Our figures
   * sit about 0.04 LU above it consistently, well inside the +/-0.1 LU EBU
   * allows a compliant meter, so the tolerance here is 0.1.
   */
  it("matches the reference meter on a 1 kHz tone", () => {
    const result = measureLoudness(stereo(sine(1000, 10, 0.1)), SR, { skipTruePeak: true });
    expect(result.integratedLufs).toBeGreaterThan(-20.1);
    expect(result.integratedLufs).toBeLessThan(-19.9);
  });

  it("follows the 6 dB rule when amplitude doubles", () => {
    const quiet = measureLoudness(stereo(sine(1000, 6, 0.05)), SR, { skipTruePeak: true });
    const loud = measureLoudness(stereo(sine(1000, 6, 0.1)), SR, { skipTruePeak: true });
    expect(loud.integratedLufs - quiet.integratedLufs).toBeCloseTo(6.02, 1);
  });

  it("applies the K-weighting tilt", () => {
    // Same amplitude, different frequency: the curve lifts highs and cuts lows.
    const low = measureLoudness(stereo(sine(100, 6, 0.1)), SR, { skipTruePeak: true });
    const mid = measureLoudness(stereo(sine(1000, 6, 0.1)), SR, { skipTruePeak: true });
    const high = measureLoudness(stereo(sine(8000, 6, 0.1)), SR, { skipTruePeak: true });
    expect(low.integratedLufs).toBeLessThan(mid.integratedLufs);
    expect(high.integratedLufs).toBeGreaterThan(mid.integratedLufs);
  });

  it("gates out a quiet tail instead of averaging it in", () => {
    const loud = sine(1000, 5, 0.2);
    const quiet = sine(1000, 5, 0.002);
    const mixed = new Float32Array(loud.length + quiet.length);
    mixed.set(loud, 0);
    mixed.set(quiet, loud.length);

    const gated = measureLoudness(stereo(mixed), SR, { skipTruePeak: true });
    const loudOnly = measureLoudness(stereo(loud), SR, { skipTruePeak: true });
    // Without the relative gate the silence would pull this several LU down.
    expect(Math.abs(gated.integratedLufs - loudOnly.integratedLufs)).toBeLessThan(0.5);
  });

  it("reports -Infinity for digital silence", () => {
    const result = measureLoudness(stereo(new Float32Array(SR * 5)), SR, { skipTruePeak: true });
    expect(result.integratedLufs).toBe(-Infinity);
  });

  it("returns a defined shape for empty input", () => {
    const result = measureLoudness([], SR);
    expect(result.integratedLufs).toBe(-Infinity);
    expect(result.shortTermLufs.length).toBe(0);
    expect(result.rangeLu).toBe(0);
  });

  it("measures near-zero range for a steady tone", () => {
    const result = measureLoudness(stereo(sine(1000, 12, 0.1)), SR, { skipTruePeak: true });
    expect(result.rangeLu).toBeLessThan(1);
  });

  it("measures a real range for material that changes level", () => {
    const parts = [0.25, 0.02, 0.25, 0.02].map((a) => sine(1000, 5, a));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const varying = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      varying.set(p, at);
      at += p.length;
    }
    const result = measureLoudness(stereo(varying), SR, { skipTruePeak: true });
    expect(result.rangeLu).toBeGreaterThan(5);
  });

  it("emits one short-term value per second of programme", () => {
    const result = measureLoudness(stereo(sine(1000, 10, 0.1)), SR, { skipTruePeak: true });
    expect(result.shortTermLufs.length).toBeGreaterThan(5);
    expect(result.shortTermLufs.length).toBeLessThanOrEqual(10);
  });

  it("keeps momentary at or above integrated for steady material", () => {
    const result = measureLoudness(stereo(sine(1000, 8, 0.1)), SR, { skipTruePeak: true });
    expect(result.maxMomentaryLufs).toBeGreaterThanOrEqual(result.integratedLufs - 0.5);
  });
});

describe("kWeight", () => {
  it("attenuates subsonic content", () => {
    const sub = sine(10, 2, 0.5);
    const weighted = kWeight(sub, SR);
    const rms = (x: Float32Array) => {
      let a = 0;
      for (let i = 0; i < x.length; i++) a += x[i] * x[i];
      return Math.sqrt(a / x.length);
    };
    expect(rms(weighted)).toBeLessThan(rms(sub) * 0.1);
  });

  it("passes 1 kHz through at roughly unity", () => {
    const tone = sine(1000, 2, 0.5);
    const weighted = kWeight(tone, SR);
    const rms = (x: Float32Array) => {
      let a = 0;
      for (let i = SR; i < x.length; i++) a += x[i] * x[i];
      return Math.sqrt(a / (x.length - SR));
    };
    const ratio = rms(weighted) / rms(tone);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.15);
  });
});

describe("truePeakDbtp", () => {
  it("is at least the sample peak", () => {
    const x = sine(1000, 0.2, 0.5);
    const result = measureLoudness(stereo(x), SR);
    expect(result.truePeakDbtp).toBeGreaterThanOrEqual(result.samplePeakDbfs - 1e-6);
  });

  it("finds an overshoot hiding between samples", () => {
    // A tone near Nyquist/2 sampled off-peak: every sample sits below the true
    // maximum, which is exactly the case sample-peak metering misses.
    const rate = 48000;
    const x = new Float32Array(2000);
    for (let i = 0; i < x.length; i++) {
      x[i] = 0.9 * Math.sin((2 * Math.PI * 11997 * i) / rate + 0.78);
    }
    let samplePeak = 0;
    for (let i = 0; i < x.length; i++) samplePeak = Math.max(samplePeak, Math.abs(x[i]));
    const tp = truePeakDbtp([x]);
    expect(tp).toBeGreaterThan(20 * Math.log10(samplePeak));
  });

  it("returns -Infinity for silence", () => {
    expect(truePeakDbtp([new Float32Array(100)])).toBe(-Infinity);
  });
});
