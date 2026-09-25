/**
 * Persist waveform peak pyramids in Dexie (schema v14 `peakPyramids`).
 *
 * Keyed by content hash when present so re-imports of the same bytes reuse the
 * pyramid. A content-hash change leaves the old row orphaned and builds a new one.
 */
import { db, type LibraryDatabase } from "./library";
import {
  buildPeakPyramid,
  peakPyramidId,
  type PeakPyramidLevels,
} from "../ui/waveformPyramid";

export interface StoredPeakPyramid {
  id: string;
  trackId: string;
  contentHash: string | null;
  bucketCounts: number[];
  /** One ArrayBuffer per level (Float32), coarse → fine. */
  levels: ArrayBuffer[];
  builtAt: number;
}

export function encodePyramidLevels(pyramid: PeakPyramidLevels): ArrayBuffer[] {
  return pyramid.levels.map((level) => level.slice().buffer as ArrayBuffer);
}

export function decodePyramidLevels(row: StoredPeakPyramid): Float32Array[] {
  return row.levels.map((buf) => new Float32Array(buf));
}

export async function loadPeakPyramid(
  trackId: string,
  contentHash: string | null | undefined,
  database: LibraryDatabase = db,
): Promise<StoredPeakPyramid | undefined> {
  const id = peakPyramidId(trackId, contentHash);
  const byId = await database.peakPyramids.get(id);
  if (byId) return byId;
  // Legacy/orphan: same track id under a different hash key — ignore (invalidated).
  return undefined;
}

/**
 * Return a stored pyramid or build+persist one from the track's peak envelope.
 * Invalidates automatically when `contentHash` (and thus id) changes.
 */
export async function ensurePeakPyramid(
  trackId: string,
  contentHash: string | null | undefined,
  peaks: Float32Array,
  database: LibraryDatabase = db,
): Promise<PeakPyramidLevels> {
  const existing = await loadPeakPyramid(trackId, contentHash, database);
  if (existing && existing.levels.length > 0) {
    return { levels: decodePyramidLevels(existing), bucketCounts: existing.bucketCounts };
  }
  const pyramid = buildPeakPyramid(peaks);
  const row: StoredPeakPyramid = {
    id: peakPyramidId(trackId, contentHash),
    trackId,
    contentHash: contentHash ?? null,
    bucketCounts: pyramid.bucketCounts,
    levels: encodePyramidLevels(pyramid),
    builtAt: Date.now(),
  };
  await database.peakPyramids.put(row);
  return pyramid;
}

export async function invalidatePeakPyramid(
  trackId: string,
  contentHash: string | null | undefined,
  database: LibraryDatabase = db,
): Promise<void> {
  await database.peakPyramids.delete(peakPyramidId(trackId, contentHash));
}
