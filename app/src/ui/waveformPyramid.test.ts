import { describe, expect, it } from "vitest";
import {
  buildPeakPyramid,
  downsamplePeaks,
  peakPyramidId,
  selectPyramidLevel,
} from "./waveformPyramid";

describe("downsamplePeaks", () => {
  it("keeps the max in each bucket", () => {
    const src = new Float32Array([0.1, 0.9, 0.2, 0.4]);
    const out = downsamplePeaks(src, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.9);
    expect(out[1]).toBeCloseTo(0.4);
  });
});

describe("buildPeakPyramid", () => {
  it("builds coarse-to-fine levels and copies finest", () => {
    const peaks = new Float32Array(2000);
    for (let i = 0; i < peaks.length; i++) peaks[i] = (i % 17) / 17;
    const pyramid = buildPeakPyramid(peaks, [32, 125, 500, 2000]);
    expect(pyramid.bucketCounts).toEqual([32, 125, 500, 2000]);
    expect(pyramid.levels[0]!.length).toBe(32);
    expect(pyramid.levels[3]!.length).toBe(2000);
    expect(Math.max(...pyramid.levels[3]!)).toBeCloseTo(Math.max(...peaks));
  });
});

describe("selectPyramidLevel", () => {
  it("picks a coarse level when zoomed out", () => {
    const pyramid = buildPeakPyramid(new Float32Array(2000).fill(0.5), [32, 125, 500, 2000]);
    const level = selectPyramidLevel(pyramid.levels, 1, 200);
    expect(level.length).toBe(500);
  });

  it("picks a finer level when zoomed in", () => {
    const pyramid = buildPeakPyramid(new Float32Array(2000).fill(0.5), [32, 125, 500, 2000]);
    const level = selectPyramidLevel(pyramid.levels, 1 / 64, 400);
    expect(level.length).toBe(2000);
  });
});

describe("peakPyramidId", () => {
  it("prefers content hash keys", () => {
    expect(peakPyramidId("t1", "abc")).toBe("hash:abc");
    expect(peakPyramidId("t1", null)).toBe("track:t1");
  });
});
