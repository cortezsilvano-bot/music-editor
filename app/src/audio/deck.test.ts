import { describe, expect, it } from "vitest";
import { crossfadeGains, syncRatio } from "./deck";

describe("crossfadeGains", () => {
  it("is equal-power at the centre, not linear", () => {
    const { a, b } = crossfadeGains(0.5);
    // A linear fade would give 0.5 each and dip ~3 dB in the middle.
    expect(a).toBeCloseTo(Math.SQRT1_2, 6);
    expect(b).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("holds constant power across the whole sweep", () => {
    for (let x = 0; x <= 1.0001; x += 0.1) {
      const { a, b } = crossfadeGains(x);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it("fully isolates each deck at the ends", () => {
    expect(crossfadeGains(0)).toMatchObject({ a: 1 });
    expect(crossfadeGains(0).b).toBeCloseTo(0, 9);
    expect(crossfadeGains(1).a).toBeCloseTo(0, 9);
    expect(crossfadeGains(1).b).toBeCloseTo(1, 9);
  });

  it("clamps out-of-range positions", () => {
    expect(crossfadeGains(-3)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(9)).toEqual(crossfadeGains(1));
  });
});

describe("syncRatio", () => {
  it("matches two close tempi directly", () => {
    expect(syncRatio(126, 128)).toBeCloseTo(128 / 126, 9);
  });

  it("is 1 when the tempi already agree", () => {
    expect(syncRatio(128, 128)).toBeCloseTo(1, 9);
  });

  it("folds a double-time match into a playable range", () => {
    // 174 against 128 would be 0.736 - within range, so kept.
    const ratio = syncRatio(174, 128);
    expect(ratio).toBeGreaterThan(0.71);
    expect(ratio).toBeLessThan(1.42);
  });

  it("halves an extreme ratio rather than returning an unplayable one", () => {
    // 70 -> 140 is 2.0, which no pitch fader reaches; 1.0 is the octave match.
    const ratio = syncRatio(70, 140);
    expect(ratio).toBeCloseTo(1, 6);
  });

  it("doubles an extreme low ratio", () => {
    expect(syncRatio(140, 70)).toBeCloseTo(1, 6);
  });

  it("always lands inside the pitch fader's range", () => {
    for (const from of [60, 85, 100, 128, 140, 174, 200]) {
      for (const to of [60, 90, 128, 150, 175]) {
        const ratio = syncRatio(from, to);
        expect(ratio).toBeGreaterThanOrEqual(0.71);
        expect(ratio).toBeLessThanOrEqual(1.42);
      }
    }
  });

  it("returns 1 for nonsense input rather than NaN or Infinity", () => {
    expect(syncRatio(0, 128)).toBe(1);
    expect(syncRatio(128, 0)).toBe(1);
    expect(syncRatio(Number.NaN, 128)).toBe(1);
  });
});
