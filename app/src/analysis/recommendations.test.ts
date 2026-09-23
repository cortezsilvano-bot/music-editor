/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { StoredTrack } from "../db/library";
import { EMPTY_TAGS } from "../metadata/tags";
import {
  energyScore,
  harmonicScore,
  recommend,
  sectionScore,
  tempoScore,
  vocalScore,
} from "./recommendations";

function track(
  id: string,
  opts: { bpm?: number; tonic?: number; energy?: number; vocal?: number; artist?: string; opens?: string } = {},
): StoredTrack {
  const bpm = opts.bpm ?? 128;
  return {
    id,
    name: `${id}.mp3`,
    audio: new Blob(),
    mimeType: "audio/mpeg",
    sizeBytes: 1,
    durationSec: 200,
    addedAt: 0,
    peaks: null,
    tags: { ...EMPTY_TAGS, artist: opts.artist ?? null },
    manualBpm: null,
    manualGrid: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    reviewedAt: null,
    analysisVersion: 4,
    analysisError: null,
    analysis: {
      tempo: { bpm, rawBpm: bpm, confidence: 0.9, octaveConfidence: 0.9, alternates: [] },
      key: { tonic: opts.tonic ?? 0, mode: "major", confidence: 0.9 },
      energy: { level: opts.energy ?? 5 },
      vocalCoverage: opts.vocal ?? 0.3,
      structure: opts.opens ? { sections: [{ label: opts.opens }] } : undefined,
    },
  } as unknown as StoredTrack;
}

describe("tempoScore", () => {
  it("is perfect for identical tempi", () => {
    expect(tempoScore(128, 128).score).toBeCloseTo(1, 6);
  });

  it("treats speeding up and slowing down symmetrically", () => {
    const up = tempoScore(128, 128 * 1.03).score;
    const down = tempoScore(128, 128 / 1.03).score;
    expect(up).toBeCloseTo(down, 6);
  });

  it("accepts a double-time match", () => {
    expect(tempoScore(87, 174).score).toBeGreaterThan(0.9);
    expect(tempoScore(87, 174).text).toMatch(/double time/);
  });

  it("rejects an unmixable gap", () => {
    expect(tempoScore(100, 140).score).toBe(0);
  });
});

describe("harmonicScore", () => {
  it("scores an identical key highest", () => {
    expect(harmonicScore("8A", "8A").score).toBe(1);
  });

  it("rates the relative major/minor as a safe move", () => {
    expect(harmonicScore("8A", "8B").score).toBeGreaterThan(0.8);
  });

  it("rates one step round the wheel as a safe move", () => {
    expect(harmonicScore("8A", "9A").score).toBeGreaterThan(0.7);
  });

  it("wraps correctly at the top of the wheel", () => {
    // 12A to 1A is one step, not eleven.
    expect(harmonicScore("12A", "1A").score).toBeGreaterThan(0.7);
  });

  it("scores an unrelated key low", () => {
    expect(harmonicScore("8A", "2A").score).toBeLessThan(0.3);
  });
});

describe("energyScore", () => {
  it("prefers a small lift over staying level", () => {
    expect(energyScore(5, 6).score).toBeGreaterThan(energyScore(5, 5).score);
  });

  it("punishes a big drop", () => {
    expect(energyScore(8, 3).score).toBeLessThan(0.3);
  });
});

describe("vocalScore", () => {
  it("punishes two vocal-heavy tracks", () => {
    const result = vocalScore(0.8, 0.8);
    expect(result.score).toBeLessThan(0.2);
    expect(result.text).toMatch(/vocal-heavy/);
  });

  it("is happy with an instrumental incoming track", () => {
    expect(vocalScore(0.8, 0.05).score).toBeGreaterThan(0.85);
  });
});

describe("sectionScore", () => {
  it("prefers a track that opens with an intro", () => {
    expect(sectionScore(track("a", { opens: "Intro" })).score).toBeGreaterThan(
      sectionScore(track("b", { opens: "Drop" })).score,
    );
  });

  it("is neutral when structure is unknown", () => {
    expect(sectionScore(track("c")).score).toBe(0.5);
  });
});

describe("recommend", () => {
  const source = track("src", { bpm: 128, tonic: 0, energy: 5, vocal: 0.7, artist: "A" });

  it("ranks a compatible track above a clashing one", () => {
    const good = track("good", { bpm: 128, tonic: 0, energy: 6, vocal: 0.1 });
    const bad = track("bad", { bpm: 99, tonic: 6, energy: 2, vocal: 0.9 });
    const [first] = recommend(source, [good, bad]);
    expect(first.track.id).toBe("good");
    expect(first.score).toBeGreaterThan(70);
  });

  it("explains every recommendation", () => {
    const [first] = recommend(source, [track("x", { bpm: 128, tonic: 0 })]);
    expect(first.reasons.length).toBe(5);
    for (const reason of first.reasons) expect(reason.text.length).toBeGreaterThan(3);
  });

  it("warns about overlapping vocals", () => {
    const [first] = recommend(source, [track("vox", { bpm: 128, tonic: 0, vocal: 0.9 })]);
    expect(first.warnings).toContain("Vocals will overlap");
  });

  it("penalises the same artist", () => {
    const same = track("same", { bpm: 128, tonic: 0, vocal: 0.1, artist: "A" });
    const other = track("other", { bpm: 128, tonic: 0, vocal: 0.1, artist: "B" });
    const results = recommend(source, [same, other]);
    expect(results[0].track.id).toBe("other");
    expect(results.find((r) => r.track.id === "same")!.warnings).toContain(
      "Same artist as the current track",
    );
  });

  it("pushes recently played tracks down", () => {
    const a = track("a", { bpm: 128, tonic: 0, vocal: 0.1 });
    const b = track("b", { bpm: 128, tonic: 0, vocal: 0.1 });
    const results = recommend(source, [a, b], { recentIds: ["a"] });
    expect(results[0].track.id).toBe("b");
  });

  it("skips unanalysed candidates rather than guessing", () => {
    const bare = { ...track("bare"), analysis: null } as StoredTrack;
    expect(recommend(source, [bare])).toHaveLength(0);
  });

  it("returns nothing when the source itself is unanalysed", () => {
    const bare = { ...track("bare"), analysis: null } as StoredTrack;
    expect(recommend(bare, [track("x")])).toHaveLength(0);
  });

  it("never exceeds the requested limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => track(`t${i}`, { bpm: 128 }));
    expect(recommend(source, many, { limit: 3 })).toHaveLength(3);
  });

  it("keeps scores inside 0..100", () => {
    const many = Array.from({ length: 10 }, (_, i) => track(`t${i}`, { bpm: 100 + i * 8 }));
    for (const r of recommend(source, many)) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});
