import { describe, expect, it } from "vitest";
import { barIndexAt, buildGrid, deriveBeatTimes, trackBeats, type BeatGrid } from "./beats";
import { computeOnsetEnvelope } from "./onset";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "./spectral";

function metronome(bpm: number, seconds: number): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const out = new Float32Array(Math.round(seconds * rate));
  const period = (60 / bpm) * rate;
  for (let beat = 0; beat * period < out.length; beat++) {
    const at = Math.round(beat * period);
    const len = Math.round(0.08 * rate);
    for (let i = 0; i < len; i++) {
      const idx = at + i;
      if (idx >= out.length) break;
      const decay = Math.exp(-i / (0.02 * rate));
      const freq = 130 * Math.exp(-i / (0.015 * rate)) + 50;
      out[idx] += Math.sin((2 * Math.PI * freq * i) / rate) * decay;
    }
  }
  return out;
}

function envelopeOf(signal: Float32Array) {
  return computeOnsetEnvelope(computeStft(signal, ANALYSIS_SAMPLE_RATE));
}

const fixedGrid: BeatGrid = {
  anchors: [{ timeSec: 0.5, beatIndex: 0, bpm: 120 }],
  beatsPerBar: 4,
  firstDownbeatSec: 0.5,
  isFixed: true,
  gridConfidence: 1,
  downbeatConfidence: 1,
};

describe("deriveBeatTimes", () => {
  it("spaces beats by the tempo", () => {
    const beats = deriveBeatTimes(fixedGrid, 5);
    const spacing = beats[2] - beats[1];
    expect(spacing).toBeCloseTo(0.5, 9);
  });

  it("extends backwards from the anchor to the start of the track", () => {
    const beats = deriveBeatTimes(fixedGrid, 5);
    expect(beats[0]).toBeCloseTo(0, 9);
    expect(beats.every((t) => t >= 0)).toBe(true);
  });

  it("never emits a beat past the track end", () => {
    const beats = deriveBeatTimes(fixedGrid, 3.2);
    expect(Math.max(...beats)).toBeLessThanOrEqual(3.2);
  });

  it("changes spacing across a tempo anchor", () => {
    const variable: BeatGrid = {
      ...fixedGrid,
      isFixed: false,
      anchors: [
        { timeSec: 0, beatIndex: 0, bpm: 120 },
        { timeSec: 4, beatIndex: 8, bpm: 140 },
      ],
    };
    const beats = deriveBeatTimes(variable, 8);
    const before = beats.filter((t) => t > 0.4 && t < 3.6);
    const after = beats.filter((t) => t > 4.4 && t < 7.6);
    expect(before[1] - before[0]).toBeCloseTo(0.5, 6);
    expect(after[1] - after[0]).toBeCloseTo(60 / 140, 6);
  });

  it("returns nothing for a zero-length track", () => {
    expect(deriveBeatTimes(fixedGrid, 0).length).toBe(0);
  });
});

describe("barIndexAt", () => {
  it("counts bars of four beats from the first downbeat", () => {
    expect(barIndexAt(fixedGrid, 0.5, 10)).toBe(0);
    expect(barIndexAt(fixedGrid, 2.5, 10)).toBe(1);
    expect(barIndexAt(fixedGrid, 4.5, 10)).toBe(2);
  });

  it("reports -1 before the first downbeat", () => {
    expect(barIndexAt(fixedGrid, 0.1, 10)).toBe(-1);
  });
});

describe("trackBeats", () => {
  it("finds beats at the right spacing", () => {
    const bpm = 120;
    const beats = trackBeats(envelopeOf(metronome(bpm, 20)), bpm);
    expect(beats.length).toBeGreaterThan(30);
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
    const median = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    expect(median).toBeCloseTo(60 / bpm, 2);
  });

  it("lands on the clicks rather than between them", () => {
    const bpm = 128;
    const beats = trackBeats(envelopeOf(metronome(bpm, 20)), bpm);
    const period = 60 / bpm;
    // Each beat should sit near a multiple of the period.
    let worst = 0;
    for (const t of beats.slice(2, -2)) {
      const phase = Math.abs(t / period - Math.round(t / period));
      worst = Math.max(worst, phase);
    }
    expect(worst).toBeLessThan(0.2);
  });

  it("returns empty for degenerate tempo instead of hanging", () => {
    expect(trackBeats(envelopeOf(metronome(120, 2)), 0).length).toBe(0);
  });
});

describe("buildGrid", () => {
  it("classifies steady beats as a fixed grid with one anchor", () => {
    const beats = new Float64Array(64);
    for (let i = 0; i < beats.length; i++) beats[i] = 0.25 + i * 0.5;
    const { grid, stability } = buildGrid(beats, 120, 0, 4, 0.8);
    expect(grid.isFixed).toBe(true);
    expect(grid.anchors).toHaveLength(1);
    expect(grid.anchors[0].bpm).toBeCloseTo(120, 3);
    expect(stability).toBeGreaterThan(0.95);
  });

  it("recovers the tempo from the fitted line, not the nominal input", () => {
    const beats = new Float64Array(32);
    for (let i = 0; i < beats.length; i++) beats[i] = i * (60 / 128);
    const { grid } = buildGrid(beats, 999, 0, 4, 0.5);
    expect(grid.anchors[0].bpm).toBeCloseTo(128, 3);
  });

  it("marks an accelerating track as not fixed", () => {
    const beats = new Float64Array(64);
    let t = 0;
    for (let i = 0; i < beats.length; i++) {
      beats[i] = t;
      t += 0.5 - i * 0.002; // speeding up
    }
    const { grid } = buildGrid(beats, 120, 0, 4, 0.5);
    expect(grid.isFixed).toBe(false);
    expect(grid.anchors.length).toBeGreaterThan(1);
  });

  it("survives too few beats to fit", () => {
    const { grid } = buildGrid(new Float64Array([1]), 120, 0, 4, 0);
    expect(grid.anchors).toHaveLength(1);
    expect(grid.gridConfidence).toBe(0);
  });
});
