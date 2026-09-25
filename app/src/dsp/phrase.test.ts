/**
 * Phrase estimation tests. Synthetic 4/4 grids only; no labelled-corpus claim.
 */
import { describe, expect, it } from "vitest";
import { estimatePhrases, phraseBarStarts } from "./phrase";
import type { BeatGrid } from "./beats";

function gridAt(bpm: number, firstDownbeatSec = 0): BeatGrid {
  return {
    anchors: [{ timeSec: firstDownbeatSec, beatIndex: 0, bpm }],
    beatsPerBar: 4,
    firstDownbeatSec,
    isFixed: true,
    gridConfidence: 1,
    downbeatConfidence: 1,
  };
}

describe("estimatePhrases", () => {
  it("places 16-bar phrases on a steady 120 BPM 4/4 grid", () => {
    // 120 BPM, 4/4: one bar is 2.0 s. 64 bars = 128 s.
    const result = estimatePhrases(gridAt(120), 128);
    expect(result.lengthBars).toBe(16);
    expect(result.phrases.length).toBe(4);
    for (let i = 0; i < result.phrases.length; i++) {
      expect(result.phrases[i].startSec).toBeCloseTo(i * 32, 6);
      expect(result.phrases[i].endSec).toBeCloseTo(i === 3 ? 128 : (i + 1) * 32, 6);
      expect(result.phrases[i].lengthBars).toBe(16);
      expect(result.phrases[i].barIndex).toBe(i * 16);
    }
  });

  it("falls back to 8-bar phrases on a short 4/4 grid", () => {
    // 12 bars at 128 BPM (bar = 1.875 s) is too short for a 16-bar phrase.
    const result = estimatePhrases(gridAt(128), 12 * (60 / 128) * 4);
    expect(result.lengthBars).toBe(8);
    expect(result.phrases.length).toBeGreaterThanOrEqual(1);
    expect(result.phrases[0].startSec).toBe(0);
  });

  it("follows a locked/manual tempo: 100 BPM moves the same bar index later", () => {
    const at120 = estimatePhrases(gridAt(120), 64);
    const at100 = estimatePhrases(gridAt(100), 64);
    const second120 = at120.phrases[1]?.startSec;
    const second100 = at100.phrases[1]?.startSec;
    expect(second120).toBeDefined();
    expect(second100).toBeDefined();
    expect(second100!).toBeGreaterThan(second120!);
    expect(second100).toBeCloseTo((60 / 100) * 4 * at100.lengthBars, 5);
  });

  it("lands every phrase start on a bar line of the effective grid", () => {
    const grid = gridAt(140, 0.5);
    const duration = 80;
    const bars = phraseBarStarts(grid, duration);
    const result = estimatePhrases(grid, duration);
    for (const phrase of result.phrases) {
      expect(bars.some((t) => Math.abs(t - phrase.startSec) < 1e-6)).toBe(true);
    }
  });

  it("prefers the length whose boundaries match energy changes", () => {
    // 32 bars at 120 BPM (64 s). Energy jumps every 8 bars (16 s).
    const curve = new Float32Array(64);
    for (let s = 0; s < 64; s++) curve[s] = Math.floor(s / 16) % 2 === 0 ? 0.2 : 0.9;
    const result = estimatePhrases(gridAt(120), 64, curve);
    expect(result.lengthBars).toBe(8);
    expect(result.phrases.length).toBe(4);
  });

  it("returns nothing for an empty grid or zero duration", () => {
    const empty: BeatGrid = {
      anchors: [],
      beatsPerBar: 4,
      firstDownbeatSec: 0,
      isFixed: true,
      gridConfidence: 0,
      downbeatConfidence: 0,
    };
    expect(estimatePhrases(empty, 60).phrases).toEqual([]);
    expect(estimatePhrases(gridAt(120), 0).phrases).toEqual([]);
  });
});
