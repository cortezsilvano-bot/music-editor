import { describe, expect, it } from "vitest";
import {
  clampViewWindow,
  panViewWindow,
  samplePeaksForView,
  timeToViewX,
  viewXToTime,
  zoomViewWindow,
} from "./waveformPeaks";

describe("clampViewWindow", () => {
  it("keeps a minimum span inside [0,1]", () => {
    const w = clampViewWindow(0.5, 0.5, 0.25);
    expect(w.end - w.start).toBeCloseTo(0.25);
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.end).toBeLessThanOrEqual(1);
  });
});

describe("samplePeaksForView", () => {
  it("downsamples the visible peak range by max", () => {
    const peaks = new Float32Array([0, 1, 0, 0.5, 0, 0.25, 0, 0.125]);
    const out = samplePeaksForView(peaks, 0, 0.5, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeGreaterThan(0);
    expect(Math.max(...out)).toBeLessThanOrEqual(1);
  });

  it("full window preserves overall max", () => {
    const peaks = new Float32Array([0.1, 0.9, 0.2, 0.4]);
    const out = samplePeaksForView(peaks, 0, 1, 4);
    expect(Math.max(...out)).toBeCloseTo(0.9);
  });
});

describe("time / view mapping", () => {
  it("round-trips center of a half window", () => {
    const t = viewXToTime(50, 100, 100, 0.25, 0.75);
    expect(t).toBeCloseTo(50);
    expect(timeToViewX(50, 100, 0.25, 0.75, 100)).toBeCloseTo(50);
  });

  it("returns null for playhead outside the view", () => {
    expect(timeToViewX(5, 100, 0.5, 1, 200)).toBeNull();
  });
});

describe("zoomViewWindow / panViewWindow", () => {
  it("zooms in around the focus", () => {
    const z = zoomViewWindow(0, 1, 0.5, 0.5);
    expect(z.end - z.start).toBeCloseTo(0.5);
    expect(z.start).toBeCloseTo(0.25);
  });

  it("pans without changing span", () => {
    const p = panViewWindow(0.2, 0.4, 1);
    expect(p.end - p.start).toBeCloseTo(0.2);
    expect(p.start).toBeCloseTo(0.4);
  });
});
