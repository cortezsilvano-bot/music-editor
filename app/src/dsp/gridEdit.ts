/**
 * Manual beat-grid editing (research Phase D, editor half).
 *
 * Every operation is a pure function from grid to grid. Keeping them out of the
 * component means the awkward cases - shifting a dynamic grid, halving a tempo
 * without moving the downbeat - are unit-testable rather than only reachable by
 * clicking.
 *
 * Edits produce a *manual* grid stored beside the automatic one. Nothing here
 * ever writes to the analysis result.
 */
import { deriveBeatTimes, type BeatGrid, type GridAnchor } from "./beats";

/** Deep copy so callers never alias an anchor array into two grids. */
export function cloneGrid(grid: BeatGrid): BeatGrid {
  return { ...grid, anchors: grid.anchors.map((a) => ({ ...a })) };
}

/** Shift the whole grid in time, downbeat included. */
export function nudgeGrid(grid: BeatGrid, deltaSec: number): BeatGrid {
  const next = cloneGrid(grid);
  for (const anchor of next.anchors) anchor.timeSec += deltaSec;
  next.firstDownbeatSec += deltaSec;
  return next;
}

/**
 * Move the grid so a beat lands exactly on `timeSec`.
 *
 * The nearest existing beat is chosen rather than the first, so clicking near a
 * kick two minutes in does not drag bar one across the whole track.
 */
export function setFirstBeat(grid: BeatGrid, timeSec: number, durationSec: number): BeatGrid {
  const beats = deriveBeatTimes(grid, durationSec);
  if (beats.length === 0) return nudgeGrid(grid, timeSec);
  let nearest = beats[0];
  let best = Math.abs(beats[0] - timeSec);
  for (let i = 1; i < beats.length; i++) {
    const distance = Math.abs(beats[i] - timeSec);
    if (distance < best) {
      best = distance;
      nearest = beats[i];
    }
  }
  return nudgeGrid(grid, timeSec - nearest);
}

/**
 * Declare which beat is beat one of a bar.
 *
 * Only the downbeat marker moves; beat positions are untouched, because getting
 * the bar phase wrong is a different mistake from getting the beats wrong.
 */
export function setDownbeat(grid: BeatGrid, timeSec: number, durationSec: number): BeatGrid {
  const beats = deriveBeatTimes(grid, durationSec);
  const next = cloneGrid(grid);
  if (beats.length === 0) {
    next.firstDownbeatSec = timeSec;
    return next;
  }
  let nearest = beats[0];
  let best = Math.abs(beats[0] - timeSec);
  for (let i = 1; i < beats.length; i++) {
    const distance = Math.abs(beats[i] - timeSec);
    if (distance < best) {
      best = distance;
      nearest = beats[i];
    }
  }
  next.firstDownbeatSec = nearest;
  next.downbeatConfidence = 1;
  return next;
}

/**
 * Multiply every tempo by `factor`, pivoting on the first downbeat.
 *
 * Pivoting matters: halving a tempo about time zero slides the downbeat, so the
 * grid would come back at the right speed in the wrong place.
 */
export function scaleTempo(grid: BeatGrid, factor: number): BeatGrid {
  if (!Number.isFinite(factor) || factor <= 0) return cloneGrid(grid);
  const pivot = grid.firstDownbeatSec;
  const next = cloneGrid(grid);
  for (const anchor of next.anchors) {
    anchor.bpm *= factor;
    anchor.timeSec = pivot + (anchor.timeSec - pivot) / factor;
  }
  return next;
}

/** Set an explicit tempo, keeping the first downbeat where it is. */
export function setGridBpm(grid: BeatGrid, bpm: number): BeatGrid {
  if (!Number.isFinite(bpm) || bpm <= 0) return cloneGrid(grid);
  const pivot = grid.firstDownbeatSec;
  return {
    ...grid,
    // An explicit tempo collapses a dynamic grid to a single anchor; the user
    // has asserted one tempo for the whole track.
    anchors: [{ timeSec: pivot, beatIndex: 0, bpm }],
    isFixed: true,
    gridConfidence: 1,
  };
}

/** Tempo implied by a run of tap times, in seconds. */
export function tapTempo(taps: readonly number[]): number | null {
  if (taps.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < taps.length; i++) {
    const gap = taps[i] - taps[i - 1];
    // Ignore double-hits and long pauses rather than letting them skew the mean.
    if (gap > 0.2 && gap < 2) intervals.push(gap);
  }
  if (intervals.length === 0) return null;
  // Median is steadier than mean over a handful of human taps.
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return 60 / median;
}

/** The grid in force: a manual edit if there is one, otherwise the automatic. */
export function effectiveGrid(
  automatic: BeatGrid | null,
  manual: BeatGrid | null,
): { grid: BeatGrid | null; manual: boolean } {
  if (manual) return { grid: manual, manual: true };
  return { grid: automatic, manual: false };
}

/** Tempo of the first anchor, which is what the UI shows as "the" BPM. */
export function gridBpm(grid: BeatGrid): number {
  const first: GridAnchor | undefined = grid.anchors[0];
  return first ? first.bpm : 0;
}
