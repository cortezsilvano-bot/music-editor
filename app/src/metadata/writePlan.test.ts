/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { StoredTrack } from "../db/library";
import { EMPTY_TAGS } from "./tags";
import {
  BLOCK_THRESHOLD,
  buildWritePlan,
  shortKeyLabel,
  toWritePayload,
  writerFor,
  type TagField,
} from "./writePlan";

function track(overrides: Partial<StoredTrack> = {}): StoredTrack {
  const base = {
    id: "t1",
    name: "song.mp3",
    audio: new Blob([new Uint8Array([1])]),
    mimeType: "audio/mpeg",
    sizeBytes: 1,
    durationSec: 200,
    addedAt: 0,
    peaks: null,
    tags: { ...EMPTY_TAGS },
    analysis: null,
    analysisVersion: null,
    analysisError: null,
    manualBpm: null,
    manualGrid: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    reviewedAt: null,
  } as unknown as StoredTrack;
  return { ...base, ...overrides } as StoredTrack;
}

/** Minimal analysis with controllable confidences. */
function analysis(tempoConf: number, keyConf: number, bpm = 128, tonic = 9) {
  return {
    analysisVersion: 2,
    durationSec: 200,
    tempo: { bpm, rawBpm: bpm, confidence: tempoConf, octaveConfidence: 0.8, alternates: [] },
    grid: {
      anchors: [{ timeSec: 0, beatIndex: 0, bpm }],
      beatsPerBar: 4,
      firstDownbeatSec: 0,
      isFixed: true,
      gridConfidence: 0.9,
      downbeatConfidence: 0.8,
    },
    gridOffsetSec: 0.004,
    tempoStability: 0.99,
    key: {
      tonic,
      mode: "minor" as const,
      name: "A minor",
      camelot: "8A",
      openKey: "1m",
      tuningCents: 0,
      confidence: keyConf,
      relativeAmbiguous: false,
      alternates: [],
      chroma: new Float64Array(12),
    },
    loudness: {
      integratedLufs: -9,
      rangeLu: 4,
      maxMomentaryLufs: -7,
      maxShortTermLufs: -8,
      truePeakDbtp: -0.2,
      samplePeakDbfs: -0.5,
      shortTermLufs: new Float32Array([-9]),
    },
    energy: {
      level: 7,
      confidence: 0.6,
      features: {} as never,
      curve: new Float32Array([1]),
      contributions: [],
    },
    fingerprint: new Uint32Array([1, 2, 3]),
    vocalCoverage: 0.4,
    vocalCurve: new Float32Array([0.3, 0.5]),
    timings: {},
  };
}

const fields = (f: TagField[]) => new Set<TagField>(f);

describe("writerFor", () => {
  it("supports MP3", () => {
    expect(writerFor("a.mp3").supported).toBe(true);
    expect(writerFor("A.MP3").supported).toBe(true);
  });

  it("supports FLAC", () => {
    expect(writerFor("a.flac").supported).toBe(true);
    expect(writerFor("A.FLAC").supported).toBe(true);
  });

  it("refuses formats it cannot write, with a reason", () => {
    const m4a = writerFor("a.m4a");
    expect(m4a.supported).toBe(false);
    expect(m4a.reason).toMatch(/m4a/i);
  });
});

describe("shortKeyLabel", () => {
  it("writes DJ notation", () => {
    expect(shortKeyLabel(9, "minor")).toBe("Am");
    expect(shortKeyLabel(0, "major")).toBe("C");
    expect(shortKeyLabel(6, "minor")).toBe("F#m");
  });
});

describe("buildWritePlan", () => {
  it("reports unsupported containers without proposing changes", () => {
    const plan = buildWritePlan(track({ name: "song.m4a", analysis: analysis(0.9, 0.9) as never }));
    expect(plan.supported).toBe(false);
    expect(plan.changes).toHaveLength(0);
  });

  it("proposes BPM and key from confident analysis, ticked by default", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.9, 0.85) as never }));
    const bpm = plan.changes.find((c) => c.field === "bpm")!;
    expect(bpm.proposed).toBe("128");
    expect(bpm.selected).toBe(true);
    expect(bpm.blocked).toBeNull();
    expect(plan.changes.find((c) => c.field === "key")!.proposed).toBe("Am");
  });

  it("flags but allows a value between the block and verify thresholds", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.6, 0.9) as never }));
    const bpm = plan.changes.find((c) => c.field === "bpm")!;
    expect(bpm.blocked).toBeNull();
    expect(bpm.warning).toMatch(/verify/i);
    expect(bpm.selected).toBe(false);
  });

  it("blocks a value below the confidence floor", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.3, 0.9) as never }));
    const bpm = plan.changes.find((c) => c.field === "bpm")!;
    expect(bpm.blocked).toMatch(new RegExp(`${BLOCK_THRESHOLD * 100}`));
    expect(bpm.selected).toBe(false);
  });

  it("writes a blocked value only when explicitly overridden", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.3, 0.9) as never }), {
      overrideLowConfidence: true,
    });
    expect(plan.changes.find((c) => c.field === "bpm")!.blocked).toBeNull();
  });

  it("never blocks a manual override, however low the analysis scored", () => {
    const plan = buildWritePlan(
      track({ analysis: analysis(0.1, 0.1) as never, manualBpm: 174, manualKeyTonic: 0, manualKeyMode: "major" }),
    );
    const bpm = plan.changes.find((c) => c.field === "bpm")!;
    expect(bpm.source).toBe("manual");
    expect(bpm.blocked).toBeNull();
    expect(bpm.selected).toBe(true);
    expect(bpm.proposed).toBe("174");
  });

  it("omits a field the file already agrees with", () => {
    const plan = buildWritePlan(
      track({
        analysis: analysis(0.9, 0.9) as never,
        tags: { ...EMPTY_TAGS, taggedBpm: 128, taggedKey: "Am" },
      }),
    );
    expect(plan.changes.find((c) => c.field === "bpm")).toBeUndefined();
    expect(plan.changes.find((c) => c.field === "key")).toBeUndefined();
  });

  it("shows the existing value it would replace", () => {
    const plan = buildWritePlan(
      track({ analysis: analysis(0.9, 0.9) as never, tags: { ...EMPTY_TAGS, taggedBpm: 100 } }),
    );
    expect(plan.changes.find((c) => c.field === "bpm")!.current).toBe("100");
  });

  it("proposes nothing when there is no analysis", () => {
    expect(buildWritePlan(track()).changes).toHaveLength(0);
  });

  it("adds a comment summary only when asked", () => {
    const without = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }));
    expect(without.changes.some((c) => c.field === "comment")).toBe(false);
    const with_ = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }), {
      includeComment: true,
    });
    const comment = with_.changes.find((c) => c.field === "comment")!;
    expect(comment.proposed).toContain("128.0 BPM");
    expect(comment.proposed).toContain("Energy 7/10");
    // Opt-in, so it must not be ticked by default.
    expect(comment.selected).toBe(false);
  });
});

describe("toWritePayload", () => {
  it("includes only ticked fields", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }));
    expect(toWritePayload(plan, fields(["bpm"]))).toEqual({ bpm: "128" });
  });

  it("maps key onto the initial-key frame", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }));
    expect(toWritePayload(plan, fields(["key"])).initialKey).toBe("Am");
  });

  it("refuses a blocked change even if it is ticked", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.2, 0.9) as never }));
    expect(toWritePayload(plan, fields(["bpm"])).bpm).toBeUndefined();
  });

  it("merges camelot and comment into one comment frame", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }), {
      includeCamelot: true,
      includeComment: true,
    });
    const payload = toWritePayload(plan, fields(["camelot", "comment"]));
    expect(payload.comment).toContain("8A");
    expect(payload.comment).toContain("Energy 7/10");
  });

  it("returns nothing when nothing is ticked", () => {
    const plan = buildWritePlan(track({ analysis: analysis(0.9, 0.9) as never }));
    expect(toWritePayload(plan, fields([]))).toEqual({});
  });
});
