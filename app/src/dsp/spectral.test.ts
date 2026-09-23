import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SAMPLE_RATE,
  binFrequencies,
  computeStft,
  frameAt,
  hannWindow,
  resample,
  toMono,
} from "./spectral";

function rmsOf(x: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / x.length);
}

function sine(freq: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("hannWindow", () => {
  it("is periodic and peaks at the centre", () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
    // Periodic (not symmetric): the last sample is not zero.
    expect(w[7]).toBeGreaterThan(0);
  });
});

describe("toMono", () => {
  it("averages channels", () => {
    const l = new Float32Array([1, 1, 1]);
    const r = new Float32Array([-1, 0, 3]);
    expect([...toMono([l, r])]).toEqual([0, 0.5, 2]);
  });

  it("passes a single channel through untouched", () => {
    const only = new Float32Array([0.5, 0.25]);
    expect(toMono([only])).toBe(only);
  });
});

describe("resample", () => {
  it("returns the input unchanged when rates match", () => {
    const x = sine(440, 0.1, 44100);
    expect(resample(x, 44100, 44100)).toBe(x);
  });

  it("produces the expected length", () => {
    const x = sine(440, 1, 44100);
    const y = resample(x, 44100, ANALYSIS_SAMPLE_RATE);
    expect(y.length).toBe(ANALYSIS_SAMPLE_RATE);
  });

  it("preserves an in-band tone through downsampling", () => {
    const x = sine(440, 1, 44100);
    const y = resample(x, 44100, ANALYSIS_SAMPLE_RATE);
    const spec = computeStft(y, ANALYSIS_SAMPLE_RATE);
    const freqs = binFrequencies(spec);
    const mid = frameAt(spec, Math.floor(spec.frameCount / 2));
    let peak = 0;
    for (let b = 1; b < mid.length; b++) if (mid[b] > mid[peak]) peak = b;
    expect(freqs[peak]).toBeGreaterThan(400);
    expect(freqs[peak]).toBeLessThan(480);
  });

  it("keeps content that is still below the new Nyquist", () => {
    // 9 kHz is under the 11.025 kHz Nyquist of the analysis rate, so it must
    // survive; only content above it should be removed.
    const x = sine(9000, 1, 44100);
    const y = resample(x, 44100, ANALYSIS_SAMPLE_RATE);
    expect(rmsOf(y)).toBeGreaterThan(0.5);
  });

  it("rejects content above the new Nyquist instead of aliasing it down", () => {
    // 15 kHz is fine at 44.1 k but above the 11.025 kHz Nyquist of the analysis
    // rate; naive decimation would fold it back as a phantom 7 kHz tone and
    // the onset stage would read it as real transient energy.
    const x = sine(15000, 1, 44100);
    const y = resample(x, 44100, ANALYSIS_SAMPLE_RATE);
    expect(rmsOf(y)).toBeLessThan(0.05);
  });
});

describe("computeStft", () => {
  it("reports consistent geometry", () => {
    const x = sine(1000, 0.5, ANALYSIS_SAMPLE_RATE);
    const spec = computeStft(x, ANALYSIS_SAMPLE_RATE, { fftSize: 1024, hopSize: 256 });
    expect(spec.binCount).toBe(513);
    expect(spec.frameRate).toBeCloseTo(ANALYSIS_SAMPLE_RATE / 256, 6);
    expect(spec.data.length).toBe(spec.frameCount * spec.binCount);
  });

  it("locates a tone in the right bin", () => {
    const freq = 1000;
    const x = sine(freq, 0.5, ANALYSIS_SAMPLE_RATE);
    const spec = computeStft(x, ANALYSIS_SAMPLE_RATE);
    const freqs = binFrequencies(spec);
    const mid = frameAt(spec, Math.floor(spec.frameCount / 2));
    let peak = 0;
    for (let b = 1; b < mid.length; b++) if (mid[b] > mid[peak]) peak = b;
    expect(Math.abs(freqs[peak] - freq)).toBeLessThan(spec.sampleRate / spec.fftSize);
  });

  it("is silent for silent input", () => {
    const spec = computeStft(new Float32Array(4096), ANALYSIS_SAMPLE_RATE);
    expect(Math.max(...spec.data)).toBe(0);
  });
});
