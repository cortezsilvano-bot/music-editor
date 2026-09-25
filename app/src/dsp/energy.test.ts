import { describe, expect, it } from "vitest";
import { computeEnergy, libraryEnergyDisplay, scoreEnergyFeatures } from "./energy";
import { computeOnsetEnvelope } from "./onset";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "./spectral";

const SR = ANALYSIS_SAMPLE_RATE;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Dense four-to-the-floor with hats: the loud end of the scale. */
function busyTrack(seconds: number, amplitude = 0.9): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const random = rng(11);
  const period = (60 / 128) * SR;
  for (let beat = 0; beat * (period / 4) < out.length; beat++) {
    const at = Math.round(beat * (period / 4));
    const isKick = beat % 4 === 0;
    const len = Math.round((isKick ? 0.09 : 0.03) * SR);
    for (let i = 0; i < len; i++) {
      const idx = at + i;
      if (idx >= out.length) break;
      if (isKick) {
        const decay = Math.exp(-i / (0.025 * SR));
        const freq = 120 * Math.exp(-i / (0.02 * SR)) + 45;
        out[idx] += Math.sin((2 * Math.PI * freq * i) / SR) * decay * amplitude;
      } else {
        out[idx] += (random() * 2 - 1) * Math.exp(-i / (0.006 * SR)) * 0.4 * amplitude;
      }
    }
  }
  return out;
}

/** A quiet sustained pad: the low end of the scale. */
function calmTrack(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    out[i] =
      0.02 *
      (Math.sin((2 * Math.PI * 220 * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR));
  }
  return out;
}

function energyOf(signal: Float32Array, lufs: number, bpm = 128) {
  const spec = computeStft(signal, SR);
  const envelope = computeOnsetEnvelope(spec);
  return computeEnergy(spec, envelope, lufs, bpm, [signal]);
}

describe("computeEnergy", () => {
  it("scores a busy loud track above a calm quiet one", () => {
    const busy = energyOf(busyTrack(20), -7);
    const calm = energyOf(calmTrack(20), -28);
    expect(busy.level).toBeGreaterThan(calm.level);
  });

  it("keeps the level inside 1..10", () => {
    for (const [signal, lufs] of [
      [busyTrack(12), -3],
      [calmTrack(12), -45],
    ] as const) {
      const result = energyOf(signal, lufs);
      expect(result.level).toBeGreaterThanOrEqual(1);
      expect(result.level).toBeLessThanOrEqual(10);
      expect(Number.isInteger(result.level)).toBe(true);
    }
  });

  it("rises with loudness when nothing else changes", () => {
    const signal = busyTrack(15);
    const quiet = energyOf(signal, -26);
    const loud = energyOf(signal, -7);
    expect(loud.level).toBeGreaterThanOrEqual(quiet.level);
  });

  it("retains every raw feature for later renormalisation", () => {
    const result = energyOf(busyTrack(12), -8);
    for (const key of [
      "loudnessLufs",
      "bassRatio",
      "kickStrength",
      "onsetDensity",
      "highFrequencyActivity",
      "spectralFlux",
      "percussiveRatio",
      "crestFactorDb",
      "bpm",
    ] as const) {
      expect(Number.isFinite(result.features[key])).toBe(true);
    }
  });

  it("explains itself, strongest contribution first", () => {
    const result = energyOf(busyTrack(12), -8);
    expect(result.contributions.length).toBeGreaterThan(3);
    for (let i = 1; i < result.contributions.length; i++) {
      expect(result.contributions[i - 1].points).toBeGreaterThanOrEqual(
        result.contributions[i].points,
      );
    }
    // Points must actually be weight x normalised, not a decorative number.
    for (const c of result.contributions) {
      expect(c.points).toBeCloseTo(c.normalised * c.weight, 9);
    }
  });

  it("produces a normalised per-second curve", () => {
    const result = energyOf(busyTrack(20), -8);
    expect(result.curve.length).toBeGreaterThan(5);
    expect(Math.max(...result.curve)).toBeCloseTo(1, 5);
    expect(Math.min(...result.curve)).toBeGreaterThanOrEqual(0);
  });

  it("finds more onsets in busy material than in a pad", () => {
    expect(energyOf(busyTrack(15), -8).features.onsetDensity).toBeGreaterThan(
      energyOf(calmTrack(15), -28).features.onsetDensity,
    );
  });

  it("survives silence without producing NaN", () => {
    const result = energyOf(new Float32Array(SR * 4), -Infinity);
    expect(Number.isFinite(result.level)).toBe(true);
    expect(Number.isFinite(result.confidence)).toBe(true);
    expect(result.level).toBe(1);
  });
});

describe("library energy renormalisation", () => {
  it("exposes a rawScore that matches the weighted feature sum", () => {
    const result = energyOf(busyTrack(12), -8);
    expect(Number.isFinite(result.rawScore)).toBe(true);
    expect(result.rawScore).toBeCloseTo(scoreEnergyFeatures(result.features).score, 9);
    expect(result.level).toBe(scoreEnergyFeatures(result.features).level);
  });

  it("maps library percentiles onto a 0..10 display without rewriting features", () => {
    const quiet = energyOf(calmTrack(12), -28);
    const loud = energyOf(busyTrack(12), -7);
    const featuresCopy = { ...quiet.features };
    const scale = libraryEnergyDisplay(quiet.rawScore, [quiet.rawScore, loud.rawScore]);
    expect(scale.sampleSize).toBe(2);
    expect(scale.percentile).not.toBeNull();
    expect(scale.percentile!).toBeLessThan(0.5);
    expect(scale.displayLevel).toBeGreaterThanOrEqual(0);
    expect(scale.displayLevel).toBeLessThanOrEqual(10);
    expect(quiet.features).toEqual(featuresCopy);

    const top = libraryEnergyDisplay(loud.rawScore, [quiet.rawScore, loud.rawScore, (quiet.rawScore + loud.rawScore) / 2]);
    expect(top.percentile!).toBeGreaterThan(0.5);
    expect(top.displayLevel!).toBeGreaterThan(scale.displayLevel!);
  });

  it("does not invent a library scale from a single track", () => {
    const result = energyOf(busyTrack(10), -8);
    const scale = libraryEnergyDisplay(result.rawScore, [result.rawScore]);
    expect(scale.displayLevel).toBeNull();
    expect(scale.percentile).toBeNull();
    expect(scale.sampleSize).toBe(1);
  });
});
