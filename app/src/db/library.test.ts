/**
 * The rule these tests exist for: re-analysis must never destroy manual work.
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnalysisResult } from "../analysis/pipeline";
import { EMPTY_TAGS } from "../metadata/tags";
import {
  addTrack,
  allTracks,
  bpmIsManual,
  db,
  effectiveBpm,
  effectiveGridOf,
  setManualGrid,
  setGridLocked,
  addCue,
  removeCue,
  effectiveKey,
  markReviewed,
  removeTrack,
  saveAnalysis,
  setManualBpm,
  setManualKey,
  staleTracks,
  persistAnalysis,
} from "./library";

function fakeAnalysis(bpm: number, tonic: number, version = 1): AnalysisResult {
  return {
    analysisVersion: version,
    durationSec: 120,
    tempo: { bpm, rawBpm: bpm, confidence: 0.8, octaveConfidence: 0.7, alternates: [] },
    grid: {
      anchors: [{ timeSec: 0, beatIndex: 0, bpm }],
      beatsPerBar: 4,
      firstDownbeatSec: 0,
      isFixed: true,
      gridConfidence: 0.9,
      downbeatConfidence: 0.8,
    },
    gridOffsetSec: 0.004,
    tempoStability: 0.98,
    key: {
      tonic,
      mode: "minor",
      name: "x",
      camelot: "8A",
      openKey: "1m",
      tuningCents: 0,
      confidence: 0.7,
      relativeAmbiguous: false,
      alternates: [],
      chroma: new Float64Array(12),
    },
    loudness: {
      integratedLufs: -8.2,
      rangeLu: 5.1,
      maxMomentaryLufs: -6.0,
      maxShortTermLufs: -7.0,
      truePeakDbtp: -0.3,
      samplePeakDbfs: -0.5,
      shortTermLufs: new Float32Array([-8, -9]),
    },
    energy: {
      level: 7,
      rawScore: 0.7,
      confidence: 0.6,
      features: {
        loudnessLufs: -8.2,
        bassRatio: 0.3,
        kickStrength: 3,
        onsetDensity: 4,
        highFrequencyActivity: 0.1,
        spectralFlux: 20,
        percussiveRatio: 0.5,
        crestFactorDb: 9,
        bpm,
      },
      curve: new Float32Array([0.5, 1]),
      contributions: [],
    },
    fingerprint: new Uint32Array([1, 2, 3]),
    vocalCoverage: 0.4,
    vocalCurve: new Float32Array([0.3, 0.5]),
    timings: {},
  };
}

const file = () => new File([new Uint8Array([1, 2, 3])], "t.wav", { type: "audio/wav" });

it("archives prior results, rejects duplicate commits atomically and preserves corrections", async () => {
  const track = await addTrack(file(), 120, new Float32Array([1]));
  await db.tracks.update(track.id, { analysis: fakeAnalysis(110, 1), analysisVersion: 1,
    manualBpm: 123, manualKeyTonic: 7, manualKeyMode: "major", gridLocked: true,
    cues: [{ id: "cue", timeSec: 10, name: "Keep" }] });
  await persistAnalysis(db, track.id, fakeAnalysis(130, 2), "unique-commit");
  await expect(persistAnalysis(db, track.id, fakeAnalysis(140, 3), "unique-commit")).rejects.toThrow();
  const stored = (await db.tracks.get(track.id))!;
  expect(stored.analysis?.tempo.bpm).toBe(130);
  expect(effectiveBpm(stored)).toBe(123);
  expect(effectiveKey(stored)).toEqual({ tonic: 7, mode: "major", manual: true });
  expect(stored.gridLocked).toBe(true);
  expect(stored.cues?.[0].name).toBe("Keep");
  expect(new Uint32Array(stored.fingerprint!)).toEqual(new Uint32Array([1, 2, 3]));
  const history = await db.analysisHistory.where("trackId").equals(track.id).toArray();
  expect(history.map(snapshot => snapshot.result.tempo.bpm).sort()).toEqual([110, 130]);
  await removeTrack(track.id);
  expect(await db.analysisHistory.where("trackId").equals(track.id).count()).toBe(0);
});

const tags = { ...EMPTY_TAGS, artist: "A", title: "T" };

beforeEach(async () => {
  await db.tracks.clear();
});

describe("library", () => {
  it("stores and lists a track", async () => {
    await addTrack(file(), 120, new Float32Array([0.5]));
    const rows = await allTracks();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("t.wav");
    expect(rows[0].analysis).toBeNull();
  });

  it("stores tags read at import time", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]), tags);
    const stored = await db.tracks.get(track.id);
    expect(stored?.tags.artist).toBe("A");
    expect(stored?.tags.title).toBe("T");
  });

  it("defaults to empty tags when none are supplied", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    expect((await db.tracks.get(track.id))?.tags.artist).toBeNull();
  });

  it("records the original file's identity alongside the audio", async () => {
    // NOTE: the audio Blob itself cannot be asserted here. fake-indexeddb does
    // not structured-clone a jsdom Blob, so it comes back as an empty object.
    // Blob storage in IndexedDB is standard and works in real browsers, but it
    // is unverified by this suite - see IMPLEMENTATION_REPORT.md.
    const original = file();
    const track = await addTrack(original, 120, new Float32Array([1]));
    const stored = await db.tracks.get(track.id);
    expect(stored?.sizeBytes).toBe(original.size);
    expect(stored?.mimeType).toBe("audio/wav");
    expect(stored?.name).toBe("t.wav");
    expect(stored?.durationSec).toBe(120);
  });

  it("reports the automatic value when there is no override", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(128, 9));
    const stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(128);
    expect(bpmIsManual(stored)).toBe(false);
    expect(effectiveKey(stored)).toEqual({ tonic: 9, mode: "minor", manual: false });
  });

  it("prefers a manual override over the automatic value", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(128, 9));
    await setManualBpm(track.id, 174);
    const stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(174);
    expect(bpmIsManual(stored)).toBe(true);
  });

  it("does not erase a manual override when analysis is rewritten", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(128, 9));
    await setManualBpm(track.id, 174);
    await setManualKey(track.id, 3, "major");

    // Re-analysis with a completely different result.
    await saveAnalysis(track.id, fakeAnalysis(96, 0, 2));

    const stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(174);
    expect(effectiveKey(stored)).toEqual({ tonic: 3, mode: "major", manual: true });
    // The automatic value is still there underneath, not discarded.
    expect(stored.analysis?.tempo.bpm).toBe(96);
  });

  it("restores the automatic value when an override is cleared", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(128, 9));
    await setManualBpm(track.id, 174);
    await setManualBpm(track.id, null);
    const stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(128);
    expect(bpmIsManual(stored)).toBe(false);
  });

  it("finds tracks analysed by an older algorithm version", async () => {
    const a = await addTrack(file(), 120, new Float32Array([1]));
    const b = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(a.id, fakeAnalysis(128, 9, 1));
    await saveAnalysis(b.id, fakeAnalysis(128, 9, 3));
    const stale = await staleTracks(3);
    expect(stale.map((t) => t.id)).toEqual([a.id]);
  });

  it("round-trips the reviewed flag", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await markReviewed(track.id, true);
    expect((await db.tracks.get(track.id))?.reviewedAt).toBeGreaterThan(0);
    await markReviewed(track.id, false);
    expect((await db.tracks.get(track.id))?.reviewedAt).toBeNull();
  });

  it("removes a track", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await removeTrack(track.id);
    expect(await allTracks()).toHaveLength(0);
  });
});

describe("grid and tempo consistency", () => {
  it("uses edited grid tempo for the library and preserves it across reanalysis", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(128, 0));
    const grid = { ...fakeAnalysis(90, 0).grid, firstDownbeatSec: 2 };
    await setManualGrid(track.id, grid);
    await saveAnalysis(track.id, fakeAnalysis(140, 0));
    let stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(90);
    expect(effectiveGridOf(stored).grid).toEqual(grid);
    await setManualBpm(track.id, 100);
    stored = (await db.tracks.get(track.id))!;
    expect(effectiveGridOf(stored).grid?.anchors[0].bpm).toBe(100);
    expect(effectiveGridOf(stored).grid?.firstDownbeatSec).toBe(2);
    await setManualGrid(track.id, null);
    stored = (await db.tracks.get(track.id))!;
    expect(effectiveBpm(stored)).toBe(140);
    expect(effectiveGridOf(stored).manual).toBe(false);
  });
  it("rejects unsafe tempos before persisting", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await expect(setManualBpm(track.id, Infinity)).rejects.toThrow();
    await expect(setManualBpm(track.id, 1e9)).rejects.toThrow();
    expect((await db.tracks.get(track.id))?.manualBpm).toBeNull();
  });
});

describe("correction and cue workflows", () => {
  it("locks the current grid across reanalysis and prevents manual edits", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await saveAnalysis(track.id, fakeAnalysis(120, 0));
    await setGridLocked(track.id, true);
    await saveAnalysis(track.id, fakeAnalysis(140, 0));
    expect(effectiveBpm((await db.tracks.get(track.id))!)).toBe(120);
    await expect(setManualBpm(track.id, 100)).rejects.toThrow(/Unlock/);
    await expect(setManualGrid(track.id, null)).rejects.toThrow(/Unlock/);
    await setGridLocked(track.id, false);
    await setManualGrid(track.id, null);
    expect(effectiveBpm((await db.tracks.get(track.id))!)).toBe(140);
  });
  it("persists cues through reanalysis and removes only the chosen cue", async () => {
    const track = await addTrack(file(), 120, new Float32Array([1]));
    await addCue(track.id, 4, "Intro"); await addCue(track.id, 90, "Outro");
    await saveAnalysis(track.id, fakeAnalysis(120, 0));
    let cues = (await db.tracks.get(track.id))!.cues!;
    expect(cues.map(c => c.name)).toEqual(["Intro", "Outro"]);
    await removeCue(track.id, cues[0].id);
    cues = (await db.tracks.get(track.id))!.cues!;
    expect(cues.map(c => c.name)).toEqual(["Outro"]);
    await expect(addCue(track.id, 120, "Beyond end")).rejects.toThrow();
  });
  it("rejects duplicate content hashes without overwriting the original", async () => {
    const original = await addTrack(file(), 120, new Float32Array([1]), tags, "same-hash");
    await expect(addTrack(file(), 120, new Float32Array([1]), tags, "same-hash")).rejects.toThrow();
    expect((await allTracks()).map(t => t.id)).toEqual([original.id]);
  });
});
