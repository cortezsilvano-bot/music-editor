import { describe, expect, it } from "vitest";
import { computeOnsetEnvelope } from "./onset";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "./spectral";
import { estimateTempo, foldTempo } from "./tempo";

/** Deterministic PRNG so fixtures are stable across runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Synthesise a four-to-the-floor pattern: kick on every beat, hat on every
 * offbeat. Broadband enough that the onset stage has real content to work on.
 */
function clickTrack(bpm: number, seconds: number, opts: { hats?: boolean } = {}): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const out = new Float32Array(Math.round(seconds * rate));
  const random = rng(7);
  const beatPeriod = (60 / bpm) * rate;

  const addKick = (at: number) => {
    const len = Math.round(0.09 * rate);
    for (let i = 0; i < len; i++) {
      const idx = Math.round(at) + i;
      if (idx >= out.length) break;
      const decay = Math.exp(-i / (0.025 * rate));
      // Pitch-dropping sine: the usual shape of a kick transient.
      const freq = 120 * Math.exp(-i / (0.02 * rate)) + 45;
      out[idx] += Math.sin((2 * Math.PI * freq * i) / rate) * decay * 0.9;
    }
  };

  const addHat = (at: number) => {
    const len = Math.round(0.03 * rate);
    for (let i = 0; i < len; i++) {
      const idx = Math.round(at) + i;
      if (idx >= out.length) break;
      const decay = Math.exp(-i / (0.006 * rate));
      out[idx] += (random() * 2 - 1) * decay * 0.25;
    }
  };

  for (let beat = 0; beat * beatPeriod < out.length; beat++) {
    addKick(beat * beatPeriod);
    if (opts.hats !== false) addHat((beat + 0.5) * beatPeriod);
  }
  return out;
}

function detectBpm(signal: Float32Array) {
  const spec = computeStft(signal, ANALYSIS_SAMPLE_RATE);
  const envelope = computeOnsetEnvelope(spec);
  return estimateTempo(envelope);
}

describe("foldTempo", () => {
  it("doubles tempi below the range", () => {
    expect(foldTempo(60, 78, 165)).toBeCloseTo(120, 6);
  });

  it("halves tempi above the range", () => {
    expect(foldTempo(340, 78, 165)).toBeCloseTo(85, 6);
  });

  it("leaves in-range tempi alone", () => {
    expect(foldTempo(128, 78, 165)).toBeCloseTo(128, 6);
  });

  it("terminates on degenerate input instead of looping forever", () => {
    expect(Number.isFinite(foldTempo(0.0001, 78, 165))).toBe(true);
  });
});

describe("estimateTempo", () => {
  // The tolerance is deliberately tight: a beat grid built on a tempo more
  // than ~1 BPM out visibly drifts within a couple of bars.
  for (const bpm of [90, 110, 124, 128, 140, 150]) {
    it(`recovers ${bpm} BPM from a click track`, () => {
      const result = detectBpm(clickTrack(bpm, 24));
      expect(result.bpm).toBeGreaterThan(bpm - 1);
      expect(result.bpm).toBeLessThan(bpm + 1);
      expect(result.confidence).toBeGreaterThan(0.3);
    });
  }

  it("folds a fast tempo into the preferred DJ range", () => {
    // 174 BPM drum and bass: the headline figure should be the folded 87,
    // while the raw peak stays available for anyone who wants it.
    const result = detectBpm(clickTrack(174, 24));
    expect(result.bpm).toBeGreaterThan(86);
    expect(result.bpm).toBeLessThan(88);
  });

  it("reports low confidence for noise with no pulse", () => {
    const random = rng(99);
    const noise = new Float32Array(ANALYSIS_SAMPLE_RATE * 10);
    for (let i = 0; i < noise.length; i++) noise[i] = random() * 2 - 1;
    const result = detectBpm(noise);
    expect(result.confidence).toBeLessThan(0.75);
  });

  it("returns a usable result for silence rather than throwing", () => {
    const result = detectBpm(new Float32Array(ANALYSIS_SAMPLE_RATE * 5));
    expect(Number.isFinite(result.bpm)).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it("offers alternates that include the octave", () => {
    const result = detectBpm(clickTrack(128, 24));
    const all = [result.rawBpm, ...result.alternates.map((a) => a.bpm)];
    expect(all.some((b) => Math.abs(b - 128) < 2 || Math.abs(b - 64) < 2)).toBe(true);
  });
});
