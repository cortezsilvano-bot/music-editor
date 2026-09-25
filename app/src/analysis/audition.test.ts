/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { StoredTrack } from "../db/library";
import { EMPTY_TAGS } from "../metadata/tags";
import { recommend } from "./recommendations";
import { barsToSeconds, buildAuditionPayload } from "./audition";

function track(
  id: string,
  opts: { bpm?: number; tonic?: number; energy?: number; vocal?: number; durationSec?: number; manualBpm?: number } = {},
): StoredTrack {
  const bpm = opts.bpm ?? 128;
  return {
    id,
    name: `${id}.mp3`,
    audio: new Blob(),
    mimeType: "audio/mpeg",
    sizeBytes: 1,
    durationSec: opts.durationSec ?? 200,
    addedAt: 0,
    peaks: null,
    tags: { ...EMPTY_TAGS },
    manualBpm: opts.manualBpm ?? null,
    manualGrid: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    reviewedAt: null,
    analysisVersion: 5,
    analysisError: null,
    analysis: {
      tempo: { bpm, rawBpm: bpm, confidence: 0.9, octaveConfidence: 0.9, alternates: [] },
      key: { tonic: opts.tonic ?? 0, mode: "major", confidence: 0.9 },
      energy: { level: opts.energy ?? 5 },
      vocalCoverage: opts.vocal ?? 0.3,
      structure: { sections: [{ label: "Intro" }] },
    },
  } as unknown as StoredTrack;
}

describe("barsToSeconds", () => {
  it("converts 16 bars of 4/4 at 120 BPM to 32 seconds", () => {
    expect(barsToSeconds(120, 16, 4)).toBeCloseTo(32, 6);
  });
});

describe("buildAuditionPayload", () => {
  const outgoing = track("out", { bpm: 128, durationSec: 240, energy: 5, vocal: 0.2 });
  const incoming = track("in", { bpm: 128, durationSec: 180, energy: 6, vocal: 0.1 });

  it("pairs ranking output with durations and effective BPMs", () => {
    const [rec] = recommend(outgoing, [incoming]);
    expect(rec).toBeDefined();
    const payload = buildAuditionPayload(outgoing, rec, 0);
    expect(payload).not.toBeNull();
    expect(payload!.fromTrackId).toBe("out");
    expect(payload!.toTrackId).toBe("in");
    expect(payload!.fromBpm).toBe(128);
    expect(payload!.toBpm).toBe(128);
    expect(payload!.fromDurationSec).toBe(240);
    expect(payload!.toDurationSec).toBe(180);
    expect(payload!.crossfadeSec).toBeGreaterThan(0);
    expect(payload!.crossfadeSec).toBeLessThan(payload!.fromDurationSec);
    expect(payload!.fromStartSec).toBeGreaterThan(0);
    expect(payload!.fromStartSec).toBeLessThan(240);
    expect(payload!.toStartSec).toBe(0);
    expect(payload!.predictedScore).toBe(rec.score);
    expect(payload!.rank).toBe(0);
  });

  it("uses a locked/manual BPM on the outgoing track", () => {
    const locked = track("out", { bpm: 128, manualBpm: 140, durationSec: 200 });
    const other = track("in", { bpm: 140, durationSec: 180 });
    const [rec] = recommend(locked, [other]);
    const payload = buildAuditionPayload(locked, rec, 0);
    expect(payload!.fromBpm).toBe(140);
    expect(payload!.toBpm).toBe(140);
  });

  it("returns null when a side has no effective tempo", () => {
    const bare = { ...track("bare"), analysis: null, manualBpm: null } as StoredTrack;
    const [rec] = recommend(outgoing, [incoming]);
    expect(buildAuditionPayload(bare, rec, 0)).toBeNull();
  });
});
