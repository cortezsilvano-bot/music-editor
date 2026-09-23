/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { cacheKey, checkStemsPlausible, planEviction, type StemCacheEntry } from "./stems";

function entry(
  id: string,
  sizeBytes: number,
  lastUsedAt: number,
  pinned = false,
): StemCacheEntry {
  return {
    id,
    audioHash: id,
    model: "demucs/htdemucs",
    trackId: id,
    trackName: `${id}.mp3`,
    stems: [],
    sizeBytes,
    createdAt: 0,
    lastUsedAt,
    pinned,
  };
}

const MB = 1024 * 1024;

describe("cacheKey", () => {
  it("separates results from different engines", () => {
    expect(cacheKey("abc", "demucs/htdemucs")).not.toBe(cacheKey("abc", "dsp"));
  });

  it("is stable for the same recording and engine", () => {
    expect(cacheKey("abc", "dsp")).toBe(cacheKey("abc", "dsp"));
  });
});

describe("planEviction", () => {
  it("does nothing when under the cap", () => {
    const plan = planEviction([entry("a", 10 * MB, 1)], 100 * MB);
    expect(plan.remove).toHaveLength(0);
    expect(plan.blockedByPins).toBe(false);
  });

  it("drops the least recently used first", () => {
    const plan = planEviction(
      [entry("old", 60 * MB, 1), entry("new", 60 * MB, 100)],
      100 * MB,
    );
    expect(plan.remove.map((e) => e.id)).toEqual(["old"]);
  });

  it("removes only as much as it needs to", () => {
    const plan = planEviction(
      [entry("a", 40 * MB, 1), entry("b", 40 * MB, 2), entry("c", 40 * MB, 3)],
      100 * MB,
    );
    expect(plan.remove).toHaveLength(1);
    expect(plan.freedBytes).toBe(40 * MB);
  });

  it("never evicts a pinned entry", () => {
    const plan = planEviction(
      [entry("pinned", 90 * MB, 1, true), entry("loose", 40 * MB, 2)],
      100 * MB,
    );
    expect(plan.remove.map((e) => e.id)).toEqual(["loose"]);
  });

  it("reports when pins make the cap unreachable", () => {
    // Everything is pinned and it still does not fit; the user has to decide.
    const plan = planEviction(
      [entry("a", 80 * MB, 1, true), entry("b", 80 * MB, 2, true)],
      100 * MB,
    );
    expect(plan.remove).toHaveLength(0);
    expect(plan.blockedByPins).toBe(true);
  });

  it("does not mutate its input", () => {
    const entries = [entry("a", 80 * MB, 2), entry("b", 80 * MB, 1)];
    const copy = entries.map((e) => ({ ...e }));
    planEviction(entries, 100 * MB);
    expect(entries.map((e) => e.id)).toEqual(copy.map((e) => e.id));
  });
});

describe("checkStemsPlausible", () => {
  const stem = (size: number) => ({
    name: "s.wav",
    type: "drums" as const,
    blob: new Blob([new Uint8Array(size)]),
  });

  it("accepts a normal separation", () => {
    expect(checkStemsPlausible([stem(500_000), stem(500_000)], 200_000).ok).toBe(true);
  });

  it("rejects an empty result", () => {
    expect(checkStemsPlausible([], 1000).ok).toBe(false);
  });

  it("rejects near-empty stems, which look like success but are not", () => {
    const result = checkStemsPlausible([stem(500_000), stem(10)], 1000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it("rejects stems smaller than the compressed source", () => {
    const result = checkStemsPlausible([stem(2000), stem(2000)], 5_000_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/truncated/);
  });
});
