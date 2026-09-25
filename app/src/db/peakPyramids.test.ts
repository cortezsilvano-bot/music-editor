/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryDatabase } from "./library";
import { ensurePeakPyramid, invalidatePeakPyramid, loadPeakPyramid } from "./peakPyramids";

let database: LibraryDatabase;

beforeEach(() => {
  database = new LibraryDatabase(`peaks-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await database.delete();
});

describe("peakPyramids store", () => {
  it("builds once and reuses by content hash", async () => {
    const peaks = new Float32Array(2000);
    peaks[10] = 0.75;
    const first = await ensurePeakPyramid("t1", "hash-a", peaks, database);
    expect(first.bucketCounts.at(-1)).toBe(2000);
    expect(await database.peakPyramids.count()).toBe(1);
    const second = await ensurePeakPyramid("t1", "hash-a", peaks, database);
    expect(second.levels.length).toBe(first.levels.length);
    expect(await database.peakPyramids.count()).toBe(1);
  });

  it("invalidates when content hash changes", async () => {
    const peaks = new Float32Array(2000).fill(0.2);
    await ensurePeakPyramid("t1", "old", peaks, database);
    expect(await loadPeakPyramid("t1", "old", database)).toBeTruthy();
    await invalidatePeakPyramid("t1", "old", database);
    expect(await loadPeakPyramid("t1", "old", database)).toBeUndefined();
    await ensurePeakPyramid("t1", "new", peaks, database);
    expect(await loadPeakPyramid("t1", "new", database)).toBeTruthy();
    expect(await loadPeakPyramid("t1", "old", database)).toBeUndefined();
  });
});
