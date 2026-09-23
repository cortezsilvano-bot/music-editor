import { describe, expect, it } from "vitest";
import { deriveBeatTimes, type BeatGrid } from "./beats";
import {
  cloneGrid,
  effectiveGrid,
  gridBpm,
  nudgeGrid,
  scaleTempo,
  setDownbeat,
  setFirstBeat,
  setGridBpm,
  tapTempo,
} from "./gridEdit";

const base: BeatGrid = {
  anchors: [{ timeSec: 0.5, beatIndex: 0, bpm: 120 }],
  beatsPerBar: 4,
  firstDownbeatSec: 0.5,
  isFixed: true,
  gridConfidence: 0.9,
  downbeatConfidence: 0.8,
};

describe("cloneGrid", () => {
  it("does not alias anchors between copies", () => {
    const copy = cloneGrid(base);
    copy.anchors[0].bpm = 999;
    expect(base.anchors[0].bpm).toBe(120);
  });
});

describe("nudgeGrid", () => {
  it("moves beats and the downbeat together", () => {
    const moved = nudgeGrid(base, 0.25);
    expect(moved.anchors[0].timeSec).toBeCloseTo(0.75, 9);
    expect(moved.firstDownbeatSec).toBeCloseTo(0.75, 9);
  });

  it("is reversible", () => {
    const back = nudgeGrid(nudgeGrid(base, 0.3), -0.3);
    expect(back.anchors[0].timeSec).toBeCloseTo(base.anchors[0].timeSec, 9);
  });
});

describe("setFirstBeat", () => {
  it("puts a beat exactly on the requested time", () => {
    const edited = setFirstBeat(base, 2.13, 20);
    const beats = deriveBeatTimes(edited, 20);
    expect(beats.some((t) => Math.abs(t - 2.13) < 1e-6)).toBe(true);
  });

  it("snaps to the nearest beat, not the first", () => {
    // 5.4 s is near the beat at 5.5; the shift should be small.
    const edited = setFirstBeat(base, 5.4, 20);
    expect(Math.abs(edited.anchors[0].timeSec - base.anchors[0].timeSec)).toBeLessThan(0.3);
  });

  it("keeps the tempo unchanged", () => {
    expect(gridBpm(setFirstBeat(base, 3.7, 20))).toBeCloseTo(120, 9);
  });
});

describe("setDownbeat", () => {
  it("snaps the downbeat to a real beat", () => {
    const edited = setDownbeat(base, 2.4, 20);
    const beats = deriveBeatTimes(edited, 20);
    expect(beats.some((t) => Math.abs(t - edited.firstDownbeatSec) < 1e-9)).toBe(true);
  });

  it("leaves beat positions alone", () => {
    const before = deriveBeatTimes(base, 20);
    const after = deriveBeatTimes(setDownbeat(base, 2.4, 20), 20);
    expect([...after]).toEqual([...before]);
  });

  it("marks the downbeat as certain once set by hand", () => {
    expect(setDownbeat(base, 2.4, 20).downbeatConfidence).toBe(1);
  });
});

describe("scaleTempo", () => {
  it("doubles the tempo", () => {
    expect(gridBpm(scaleTempo(base, 2))).toBeCloseTo(240, 9);
  });

  it("halves the tempo", () => {
    expect(gridBpm(scaleTempo(base, 0.5))).toBeCloseTo(60, 9);
  });

  it("keeps the downbeat in place while scaling", () => {
    const scaled = scaleTempo(base, 2);
    const beats = deriveBeatTimes(scaled, 20);
    expect(beats.some((t) => Math.abs(t - base.firstDownbeatSec) < 1e-6)).toBe(true);
  });

  it("round-trips through double then halve", () => {
    const back = scaleTempo(scaleTempo(base, 2), 0.5);
    expect(gridBpm(back)).toBeCloseTo(120, 9);
    expect(back.anchors[0].timeSec).toBeCloseTo(base.anchors[0].timeSec, 9);
  });

  it("ignores a nonsense factor", () => {
    expect(gridBpm(scaleTempo(base, 0))).toBeCloseTo(120, 9);
    expect(gridBpm(scaleTempo(base, Number.NaN))).toBeCloseTo(120, 9);
  });
});

describe("setGridBpm", () => {
  it("applies the tempo and pins the downbeat", () => {
    const edited = setGridBpm(base, 128);
    expect(gridBpm(edited)).toBe(128);
    expect(edited.anchors[0].timeSec).toBeCloseTo(base.firstDownbeatSec, 9);
  });

  it("collapses a dynamic grid to one anchor", () => {
    const dynamic: BeatGrid = {
      ...base,
      isFixed: false,
      anchors: [
        { timeSec: 0, beatIndex: 0, bpm: 120 },
        { timeSec: 8, beatIndex: 16, bpm: 126 },
      ],
    };
    const edited = setGridBpm(dynamic, 124);
    expect(edited.anchors).toHaveLength(1);
    expect(edited.isFixed).toBe(true);
  });

  it("ignores a nonsense tempo", () => {
    expect(gridBpm(setGridBpm(base, -5))).toBe(120);
  });
});

describe("tapTempo", () => {
  it("needs at least two taps", () => {
    expect(tapTempo([])).toBeNull();
    expect(tapTempo([1])).toBeNull();
  });

  it("reads 120 BPM from half-second taps", () => {
    expect(tapTempo([0, 0.5, 1, 1.5, 2])).toBeCloseTo(120, 6);
  });

  it("ignores a double-hit", () => {
    // The 0.02 s gap is a bounced finger, not a beat.
    const bpm = tapTempo([0, 0.5, 0.52, 1.0, 1.5]);
    expect(bpm).toBeGreaterThan(110);
    expect(bpm).toBeLessThan(130);
  });

  it("ignores a long pause between runs", () => {
    const bpm = tapTempo([0, 0.5, 1.0, 9.0, 9.5, 10.0]);
    expect(bpm).toBeCloseTo(120, 6);
  });

  it("returns null when every gap is implausible", () => {
    expect(tapTempo([0, 30, 60])).toBeNull();
  });
});

describe("effectiveGrid", () => {
  it("prefers a manual grid", () => {
    const manual = setGridBpm(base, 100);
    const result = effectiveGrid(base, manual);
    expect(result.manual).toBe(true);
    expect(gridBpm(result.grid!)).toBe(100);
  });

  it("falls back to the automatic grid", () => {
    const result = effectiveGrid(base, null);
    expect(result.manual).toBe(false);
    expect(gridBpm(result.grid!)).toBe(120);
  });

  it("copes with no grid at all", () => {
    expect(effectiveGrid(null, null).grid).toBeNull();
  });
});
