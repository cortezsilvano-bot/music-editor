/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "../dsp/spectral";
import {
  computeAudioHash,
  computeFingerprint,
  findDuplicateGroups,
  fingerprintSimilarity,
  planMerge,
  rankCopies,
  type QualityFacts,
} from "./fingerprint";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A chord sequence, so the chroma has real structure to fingerprint. */
function music(seed: number, seconds = 12, gain = 1): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const out = new Float32Array(Math.round(seconds * rate));
  const random = rng(seed);
  const roots = Array.from({ length: 8 }, () => 48 + Math.floor(random() * 12));
  const perChord = Math.floor(out.length / roots.length);
  roots.forEach((root, index) => {
    for (const interval of [0, 4, 7]) {
      const freq = 440 * 2 ** ((root + interval - 69) / 12);
      for (let i = 0; i < perChord; i++) {
        const at = index * perChord + i;
        if (at >= out.length) break;
        const env = Math.exp(-i / (0.8 * rate));
        out[at] += Math.sin((2 * Math.PI * freq * i) / rate) * env * 0.25 * gain;
      }
    }
  });
  return out;
}

const fingerprintOf = (x: Float32Array) =>
  computeFingerprint(computeStft(x, ANALYSIS_SAMPLE_RATE));

describe("computeAudioHash", () => {
  it("is stable for identical audio", async () => {
    const a = music(1);
    expect(await computeAudioHash(a)).toBe(await computeAudioHash(Float32Array.from(a)));
  });

  it("differs for different audio", async () => {
    expect(await computeAudioHash(music(1))).not.toBe(await computeAudioHash(music(2)));
  });

  it("ignores a perturbation that stays inside one quantisation step", async () => {
    // Deliberately nudged well inside a step, away from the boundary. This is
    // the limit of what an exact hash can absorb; anything larger is level 3's
    // job, not this one's.
    const a = Float32Array.from({ length: 4096 }, (_, i) => (i % 512) / 512 + 1 / 1024);
    const b = Float32Array.from(a, (v) => v + 1e-7);
    expect(await computeAudioHash(a)).toBe(await computeAudioHash(b));
  });

  it("does not pretend to match a re-encode - that is the fingerprint's job", async () => {
    const a = music(3);
    const noisy = Float32Array.from(a, (v) => v + 0.01);
    expect(await computeAudioHash(a)).not.toBe(await computeAudioHash(noisy));
  });
});

describe("fingerprintSimilarity", () => {
  it("matches a track against itself", () => {
    const fp = fingerprintOf(music(7));
    expect(fingerprintSimilarity(fp, fp)).toBeCloseTo(1, 6);
  });

  it("still matches after a large gain change", () => {
    // Bits encode direction of change, so level should not matter.
    const quiet = fingerprintOf(music(7, 12, 0.2));
    const loud = fingerprintOf(music(7, 12, 1.0));
    expect(fingerprintSimilarity(quiet, loud)).toBeGreaterThan(0.9);
  });

  it("matches despite added noise, as a re-encode would", () => {
    const clean = music(9);
    const noisy = Float32Array.from(clean);
    const random = rng(42);
    for (let i = 0; i < noisy.length; i++) noisy[i] += (random() - 0.5) * 0.02;
    expect(fingerprintSimilarity(fingerprintOf(clean), fingerprintOf(noisy))).toBeGreaterThan(0.75);
  });

  it("matches a copy with a silent lead-in", () => {
    const original = music(11);
    const rate = ANALYSIS_SAMPLE_RATE;
    const shifted = new Float32Array(original.length + rate);
    shifted.set(original, rate);
    expect(
      fingerprintSimilarity(fingerprintOf(original), fingerprintOf(shifted)),
    ).toBeGreaterThan(0.75);
  });

  it("scores unrelated tracks near chance, well below threshold", () => {
    const score = fingerprintSimilarity(fingerprintOf(music(1)), fingerprintOf(music(99)));
    expect(score).toBeLessThan(0.75);
  });

  it("returns 0 for an empty fingerprint", () => {
    expect(fingerprintSimilarity(new Uint32Array(0), fingerprintOf(music(1)))).toBe(0);
  });
});

describe("findDuplicateGroups", () => {
  it("groups byte-identical files", () => {
    const groups = findDuplicateGroups([
      { id: "a", contentHash: "h1" },
      { id: "b", contentHash: "h1" },
      { id: "c", contentHash: "h2" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].level).toBe("exact-file");
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("groups same audio in different containers", () => {
    const groups = findDuplicateGroups([
      { id: "a", contentHash: "h1", audioHash: "pcm" },
      { id: "b", contentHash: "h2", audioHash: "pcm" },
    ]);
    expect(groups[0].level).toBe("same-audio");
  });

  it("prefers the strongest level and never double-reports a track", () => {
    const fp = fingerprintOf(music(5));
    const groups = findDuplicateGroups([
      { id: "a", contentHash: "same", audioHash: "pcm", fingerprint: fp },
      { id: "b", contentHash: "same", audioHash: "pcm", fingerprint: fp },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].level).toBe("exact-file");
    const ids = groups.flatMap((g) => g.members.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("groups re-encodes by fingerprint", () => {
    const original = music(13);
    const noisy = Float32Array.from(original);
    const random = rng(8);
    for (let i = 0; i < noisy.length; i++) noisy[i] += (random() - 0.5) * 0.02;
    const groups = findDuplicateGroups([
      { id: "a", contentHash: "x", fingerprint: fingerprintOf(original) },
      { id: "b", contentHash: "y", fingerprint: fingerprintOf(noisy) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].level).toBe("similar-audio");
    expect(groups[0].members[1].confidence).toBeGreaterThan(0.75);
  });

  it("leaves unrelated tracks ungrouped", () => {
    expect(
      findDuplicateGroups([
        { id: "a", contentHash: "x", fingerprint: fingerprintOf(music(1)) },
        { id: "b", contentHash: "y", fingerprint: fingerprintOf(music(77)) },
      ]),
    ).toHaveLength(0);
  });

  it("returns nothing for a single track", () => {
    expect(findDuplicateGroups([{ id: "a", contentHash: "x" }])).toHaveLength(0);
  });
});

describe("rankCopies", () => {
  const base: QualityFacts = {
    id: "x",
    bitrateKbps: 320,
    sampleRate: 44100,
    sizeBytes: 1000,
    lossless: false,
    hasAnalysis: true,
    manualEdits: 0,
  };

  it("puts lossless above lossy", () => {
    const ranked = rankCopies([base, { ...base, id: "flac", lossless: true, bitrateKbps: 900 }]);
    expect(ranked[0].id).toBe("flac");
  });

  it("prefers higher bitrate among lossy copies", () => {
    const ranked = rankCopies([{ ...base, id: "low", bitrateKbps: 128 }, base]);
    expect(ranked[0].id).toBe("x");
  });

  it("puts hand-edited copies first, whatever the bitrate", () => {
    // Re-doing someone's grid work costs more than a few kbps.
    const ranked = rankCopies([
      { ...base, id: "pristine", lossless: true, bitrateKbps: 1000 },
      { ...base, id: "edited", bitrateKbps: 128, manualEdits: 3 },
    ]);
    expect(ranked[0].id).toBe("edited");
  });

  it("does not mutate its input", () => {
    const input = [base, { ...base, id: "b", bitrateKbps: 128 }];
    const copy = [...input];
    rankCopies(input);
    expect(input).toEqual(copy);
  });
});

describe("planMerge", () => {
  const empty = {
    manualBpm: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    manualGrid: null,
    cues: [],
    reviewedAt: null,
  };

  it("takes edits the keeper lacks", () => {
    const plan = planMerge(empty, { ...empty, manualBpm: 128, reviewedAt: 42 });
    expect(plan.result.manualBpm).toBe(128);
    expect(plan.result.reviewedAt).toBe(42);
    expect(plan.fields).toContain("manual BPM");
  });

  it("never overwrites an edit the keeper already has", () => {
    const plan = planMerge({ ...empty, manualBpm: 100 }, { ...empty, manualBpm: 128 });
    expect(plan.result.manualBpm).toBe(100);
    expect(plan.fields).not.toContain("manual BPM");
  });

  it("carries the key mode across with the tonic", () => {
    const plan = planMerge(empty, { ...empty, manualKeyTonic: 9, manualKeyMode: "minor" });
    expect(plan.result.manualKeyTonic).toBe(9);
    expect(plan.result.manualKeyMode).toBe("minor");
  });

  it("adds cues the keeper does not have", () => {
    const plan = planMerge(empty, {
      ...empty,
      cues: [{ id: "c1", name: "Drop", timeSec: 60 }],
    });
    expect(plan.cues).toHaveLength(1);
    expect(plan.result.cues[0].name).toBe("Drop");
  });

  it("does not duplicate a cue at the same position", () => {
    // The same cue set imported twice has different ids but the same times.
    const plan = planMerge(
      { ...empty, cues: [{ id: "a", name: "Drop", timeSec: 60 }] },
      { ...empty, cues: [{ id: "b", name: "Drop", timeSec: 60.02 }] },
    );
    expect(plan.cues).toHaveLength(0);
    expect(plan.result.cues).toHaveLength(1);
  });

  it("keeps merged cues in time order", () => {
    const plan = planMerge(
      { ...empty, cues: [{ id: "a", name: "B", timeSec: 90 }] },
      { ...empty, cues: [{ id: "b", name: "A", timeSec: 30 }] },
    );
    expect(plan.result.cues.map((c) => c.timeSec)).toEqual([30, 90]);
  });

  it("reports nothing to do when the donor adds nothing", () => {
    const plan = planMerge({ ...empty, manualBpm: 128 }, empty);
    expect(plan.fields).toHaveLength(0);
    expect(plan.cues).toHaveLength(0);
  });

  it("does not mutate either input", () => {
    const keeper = { ...empty, cues: [] };
    const donor = { ...empty, manualBpm: 128, cues: [{ id: "c", name: "X", timeSec: 10 }] };
    const donorCopy = JSON.parse(JSON.stringify(donor));
    planMerge(keeper, donor);
    expect(keeper.manualBpm).toBeNull();
    expect(donor).toEqual(donorCopy);
  });
});
