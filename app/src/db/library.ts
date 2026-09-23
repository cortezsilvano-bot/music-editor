/**
 * Local-first library storage (research Phase A).
 *
 * IndexedDB via Dexie. Audio is kept as a Blob so a reloaded library still
 * plays without asking the user to re-pick files - the browser cannot reopen a
 * path on its own, so the bytes have to live here.
 *
 * Automatic and manual values are stored in separate fields. `effective*`
 * helpers prefer an override without ever overwriting the automatic result, so
 * re-analysis can replace `analysis` wholesale and manual work survives.
 */
import Dexie, { type EntityTable } from "dexie";
import type { AnalysisResult } from "../analysis/pipeline";
import { gridBpm, setGridBpm } from "../dsp/gridEdit";
import type { BeatGrid } from "../dsp/beats";
import { EMPTY_TAGS, type TrackTags } from "../metadata/tags";

export interface StoredTrack {
  id: string;
  name: string;
  contentHash?: string;
  relativePath?: string;
  /** SHA-256 of quantised decoded PCM: catches re-tags and re-containers. */
  audioHash?: string;
  /** Perceptual fingerprint, copied out of the analysis for indexed lookup. */
  fingerprint?: ArrayBuffer;
  /**
   * Absolute path on disk. Only set for desktop folder imports; a browser
   * never learns it, and tag writing is unavailable without it.
   */
  filePath?: string;
  gridLocked?: boolean;
  cues?: { id: string; name: string; timeSec: number }[];
  /** Bytes of the original file, untouched. */
  audio: Blob;
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  addedAt: number;
  /** Peak envelope for drawing, so reloads do not re-decode to show a waveform. */
  peaks: ArrayBuffer | null;
  /** Tags read from the file. Read-only; the browser cannot write them back. */
  tags: TrackTags;

  /** Automatic analysis. Replaced wholesale on re-analysis. */
  analysis: AnalysisResult | null;
  /** Version the stored analysis was produced by. */
  analysisVersion: number | null;
  analysisError: string | null;

  /** Manual overrides. Never written by analysis. */
  manualBpm: number | null;
  /** A hand-edited beat grid, replacing the detected one entirely. */
  manualGrid: BeatGrid | null;
  manualKeyTonic: number | null;
  manualKeyMode: "major" | "minor" | null;
  /** Set when the user has confirmed the automatic result is correct. */
  reviewedAt: number | null;
}

export interface AnalysisJob {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  priority: number;
  queuedAt: number;
  attempts: number;
  error: string | null;
}

export class LibraryDatabase extends Dexie {
  tracks!: EntityTable<StoredTrack, "id">;
  feedback!: EntityTable<import("./feedback").FeedbackEntry, "id">;
  stemCache!: EntityTable<import("./stems").StemCacheEntry, "id">;

  jobs!: EntityTable<AnalysisJob, "id">;

  constructor(name = "music-editor") {
    super(name);
    // v1: initial schema. Indexes cover the sorts and filters the library view
    // offers; `analysisVersion` is indexed so stale rows can be found cheaply.
    this.version(1).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt",
    });
    // v2 adds the manual grid. Indexes are unchanged, so the upgrade only has
    // to give existing rows the new field rather than rebuild the table.
    this.version(2)
      .stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt" })
      .upgrade(async (tx) => {
        await tx
          .table<StoredTrack>("tracks")
          .toCollection()
          .modify((track) => {
            track.manualGrid = null;
          });
      });
    // v3 adds tags. Existing rows get empty tags rather than being re-read;
    // re-reading would need every Blob decoded during an upgrade.
    this.version(3)
      .stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt" })
      .upgrade(async (tx) => {
        await tx
          .table<StoredTrack>("tracks")
          .toCollection()
          .modify((track) => {
            track.tags = { ...EMPTY_TAGS };
          });
      });
    this.version(4).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt",
      jobs: "id, status, priority, queuedAt",
    });
    // v9 adds the stem cache. lastUsedAt is indexed because eviction orders by
    // it, and audioHash because a lookup by recording is the common read.
    this.version(9).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
      jobs: "id, status, priority, queuedAt",
      feedback: "id, fromTrackId, toTrackId, action, at",
      stemCache: "id, audioHash, trackId, lastUsedAt, pinned",
    });
    // v8 adds the transition feedback log.
    this.version(8).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
      jobs: "id, status, priority, queuedAt",
      feedback: "id, fromTrackId, toTrackId, action, at",
    });
    // v7 adds the duplicate-detection columns. audioHash is indexed because
    // grouping by it is a lookup; fingerprints are compared pairwise, so they
    // are not.
    this.version(7).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
      jobs: "id, status, priority, queuedAt",
    });
    // v6 indexes filePath so a desktop re-import can find an existing row
    // rather than duplicating it.
    this.version(6).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath",
      jobs: "id, status, priority, queuedAt",
    });
    this.version(5).stores({
      tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash",
      jobs: "id, status, priority, queuedAt",
    });
  }
}

export const db = new LibraryDatabase();

export function effectiveBpm(track: StoredTrack): number | null {
  if (track.manualGrid?.anchors.length) return gridBpm(track.manualGrid);
  if (track.manualBpm !== null) return track.manualBpm;
  return track.analysis?.tempo.bpm ?? null;
}

export function bpmIsManual(track: StoredTrack): boolean {
  return track.manualGrid != null || track.manualBpm !== null;
}

export function effectiveKey(
  track: StoredTrack,
): { tonic: number; mode: "major" | "minor"; manual: boolean } | null {
  if (track.manualKeyTonic !== null && track.manualKeyMode !== null) {
    return { tonic: track.manualKeyTonic, mode: track.manualKeyMode, manual: true };
  }
  if (track.analysis) {
    return { tonic: track.analysis.key.tonic, mode: track.analysis.key.mode, manual: false };
  }
  return null;
}

/**
 * Store a fresh analysis without disturbing manual work.
 *
 * This is the single place analysis results are written, so the rule that
 * re-analysis must not erase overrides is enforced in one spot rather than
 * trusted to every call site.
 */
export async function saveAnalysis(id: string, result: AnalysisResult): Promise<void> {
  await db.tracks.update(id, {
    analysis: result,
    analysisVersion: result.analysisVersion,
    analysisError: null,
    reviewedAt: null,
    // Lifted out of the result so duplicate scanning does not have to load and
    // walk every stored analysis object.
    fingerprint: result.fingerprint?.buffer.slice(0) as ArrayBuffer | undefined,
  });
}

/**
 * Apply a merge onto the keeper.
 *
 * Only the fields the plan decided to move are written, so a merge can never
 * clobber an edit the keeper already had.
 */
export async function applyMerge(
  keeperId: string,
  edits: {
    manualBpm: number | null;
    manualKeyTonic: number | null;
    manualKeyMode: "major" | "minor" | null;
    manualGrid: BeatGrid | null;
    cues: { id: string; name: string; timeSec: number }[];
    reviewedAt: number | null;
  },
): Promise<void> {
  await db.tracks.update(keeperId, {
    manualBpm: edits.manualBpm,
    manualKeyTonic: edits.manualKeyTonic,
    manualKeyMode: edits.manualKeyMode,
    manualGrid: edits.manualGrid,
    cues: edits.cues,
    reviewedAt: edits.reviewedAt,
  });
}

export async function setAudioHash(id: string, audioHash: string): Promise<void> {
  await db.tracks.update(id, { audioHash });
}

export async function saveAnalysisError(id: string, message: string): Promise<void> {
  await db.tracks.update(id, { analysisError: message });
}

export async function setManualBpm(id: string, bpm: number | null): Promise<void> {
  if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 400)) {
    throw new Error("Tempo must be between 20 and 400 BPM");
  }
  await db.transaction("rw", db.tracks, async () => {
    const track = await db.tracks.get(id);
    if (!track) return;
    if (track.gridLocked) throw new Error("Unlock the grid before editing");
    const grid = effectiveGridOf(track).grid;
    await db.tracks.update(id, {
      manualBpm: bpm,
      manualGrid: bpm === null ? null : grid ? setGridBpm(grid, bpm) : null,
      reviewedAt: null,
    });
  });
}

export async function setManualKey(
  id: string,
  tonic: number | null,
  mode: "major" | "minor" | null,
): Promise<void> {
  if ((tonic === null) !== (mode === null) || (tonic !== null && (!Number.isInteger(tonic) || tonic < 0 || tonic > 11))) {
    throw new Error("Choose a valid key or clear both key fields");
  }
  await db.tracks.update(id, { manualKeyTonic: tonic, manualKeyMode: mode, reviewedAt: null });
}

export async function setManualGrid(id: string, grid: BeatGrid | null): Promise<void> {
  if (grid && (!grid.anchors.length || grid.anchors.some(a =>
    !Number.isFinite(a.bpm) || a.bpm < 20 || a.bpm > 400 || !Number.isFinite(a.timeSec)))) {
    throw new Error("Grid tempo must be between 20 and 400 BPM");
  }
  await db.transaction("rw", db.tracks, async () => {
    if ((await db.tracks.get(id))?.gridLocked) throw new Error("Unlock the grid before editing");
    await db.tracks.update(id, { manualGrid: grid, manualBpm: grid ? gridBpm(grid) : null, reviewedAt: null });
  });
}

export async function markReviewed(id: string, reviewed: boolean): Promise<void> {
  await db.tracks.update(id, { reviewedAt: reviewed ? Date.now() : null });
}

export async function addTrack(
  file: File,
  durationSec: number,
  peaks: Float32Array,
  tags: TrackTags = { ...EMPTY_TAGS },
  contentHash?: string,
  origin?: { filePath: string; relativePath: string },
): Promise<StoredTrack> {
  const track: StoredTrack = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name,
    ...(contentHash ? { contentHash } : {}),
    relativePath: origin?.relativePath || file.webkitRelativePath || file.name,
    ...(origin ? { filePath: origin.filePath } : {}),
    audio: file,
    mimeType: file.type || "audio/*",
    sizeBytes: file.size,
    durationSec,
    addedAt: Date.now(),
    peaks: peaks.buffer.slice(0) as ArrayBuffer,
    tags,
    analysis: null,
    analysisVersion: null,
    analysisError: null,
    manualBpm: null,
    manualGrid: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    reviewedAt: null,
  };
  await db.tracks.add(track);
  return track;
}

/** Find a track already imported from this absolute path, if any. */
export async function trackByFilePath(filePath: string): Promise<StoredTrack | undefined> {
  return db.tracks.where("filePath").equals(filePath).first();
}

export async function removeTrack(id: string): Promise<void> {
  await db.transaction("rw", db.tracks, db.jobs, async () => {
    await db.jobs.delete(id);
    await db.tracks.delete(id);
  });
}

export async function allTracks(): Promise<StoredTrack[]> {
  return db.tracks.orderBy("addedAt").reverse().toArray();
}

/** The beat grid in force: a hand edit if there is one, else the detected one. */
export function effectiveGridOf(
  track: StoredTrack,
): { grid: BeatGrid | null; manual: boolean } {
  if (track.manualGrid) return { grid: track.manualGrid, manual: true };
  const grid = track.analysis?.grid ?? null;
  if (grid && track.manualBpm !== null) return { grid: setGridBpm(grid, track.manualBpm), manual: true };
  return { grid, manual: false };
}

/** Tracks whose stored analysis predates the current algorithm version. */
export async function staleTracks(currentVersion: number): Promise<StoredTrack[]> {
  const rows = await db.tracks.toArray();
  return rows.filter((t) => t.analysis !== null && (t.analysisVersion ?? 0) < currentVersion);
}

export async function setGridLocked(id: string, locked: boolean): Promise<void> {
  await db.transaction("rw", db.tracks, async () => {
    const track = await db.tracks.get(id);
    if (!track) return;
    await db.tracks.update(id, { gridLocked: locked,
      ...(locked ? { manualGrid: effectiveGridOf(track).grid } : {}) });
  });
}

export async function addCue(id: string, timeSec: number, name: string): Promise<void> {
  await db.transaction("rw", db.tracks, async () => {
    const track = await db.tracks.get(id);
    if (!track) return;
    if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec >= track.durationSec) throw new Error("Cue must be within the track");
    const cues = [...(track.cues ?? []), { id: crypto.randomUUID(), name: name.trim() || "Cue", timeSec }];
    cues.sort((a, b) => a.timeSec - b.timeSec);
    await db.tracks.update(id, { cues });
  });
}

export async function removeCue(id: string, cueId: string): Promise<void> {
  await db.transaction("rw", db.tracks, async () => {
    const track = await db.tracks.get(id);
    if (track) await db.tracks.update(id, { cues: (track.cues ?? []).filter(c => c.id !== cueId) });
  });
}
