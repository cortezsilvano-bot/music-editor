/**
 * Beat tracking and grid construction (research Phase D).
 *
 * Dynamic-programming beat tracking in the style of Ellis (2007): pick the
 * beat sequence maximising onset strength minus a penalty for straying from
 * the estimated period. Downbeat phase is then chosen using the kick band,
 * because full-spectrum flux is dominated by hats and vocals.
 *
 * The grid is stored analytically - anchors plus a tempo - rather than as
 * thousands of beat rows, so a fixed-tempo track costs a handful of numbers
 * and beat positions are derived on demand.
 */
import { bandLimitedOnset, type OnsetEnvelope } from "./onset";

export interface GridAnchor {
  /** Seconds into the track. */
  timeSec: number;
  /** Beat number at this anchor, counting from the first detected beat. */
  beatIndex: number;
  /** Tempo in force from this anchor until the next. */
  bpm: number;
}

export interface BeatGrid {
  anchors: GridAnchor[];
  beatsPerBar: number;
  /** Time of the first downbeat, seconds. */
  firstDownbeatSec: number;
  /** True when one tempo describes the whole track. */
  isFixed: boolean;
  /** 0..1, how well detected beats line up with the analytic grid. */
  gridConfidence: number;
  /** 0..1, how strongly the chosen bar phase beats the alternatives. */
  downbeatConfidence: number;
}

export interface BeatTrackingResult {
  /** Detected beat times in seconds, before the grid is fitted. */
  beats: Float64Array;
  grid: BeatGrid;
  /** Mean absolute deviation of detected beats from the grid, seconds. */
  gridOffsetSec: number;
  /** 0..1, how steady the inter-beat intervals are. */
  tempoStability: number;
}

/**
 * Dynamic-programming beat tracker.
 *
 * `tightness` controls how strongly the tracker insists on a regular period;
 * the value follows the reference implementation and is deliberately high, as
 * a loose tracker produces grids that look right but drift across a phrase.
 */
export function trackBeats(
  envelope: OnsetEnvelope,
  bpm: number,
  tightness = 100,
): Float64Array {
  const env = envelope.values;
  const n = env.length;
  if (n === 0 || bpm <= 0) return new Float64Array(0);

  const period = (60 * envelope.frameRate) / bpm;
  if (!Number.isFinite(period) || period < 1) return new Float64Array(0);

  const score = new Float64Array(n);
  const previous = new Int32Array(n).fill(-1);

  // Search a window around one period back from each frame.
  const searchStart = Math.max(1, Math.round(period / 2));
  const searchEnd = Math.max(searchStart + 1, Math.round(period * 2));

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestIndex = -1;
    for (let back = searchStart; back <= searchEnd; back++) {
      const source = t - back;
      if (source < 0) break;
      // Log-squared penalty: symmetric in tempo ratio, so half and double
      // period deviations are punished equally.
      const ratio = Math.log(back / period);
      const candidate = score[source] - tightness * ratio * ratio;
      if (candidate > best) {
        best = candidate;
        bestIndex = source;
      }
    }
    if (bestIndex === -1) {
      score[t] = env[t];
      previous[t] = -1;
    } else {
      score[t] = env[t] + best;
      previous[t] = bestIndex;
    }
  }

  // Backtrace from the best scoring frame in the final stretch.
  let end = 0;
  for (let t = 1; t < n; t++) if (score[t] > score[end]) end = t;

  const reversed: number[] = [];
  for (let t = end; t >= 0; t = previous[t]) {
    reversed.push(t);
    if (previous[t] === -1) break;
  }
  reversed.reverse();

  const beats = new Float64Array(reversed.length);
  for (let i = 0; i < reversed.length; i++) beats[i] = reversed[i] / envelope.frameRate;
  return beats;
}

/**
 * Choose which beat starts the bar by scoring each phase against kick energy.
 *
 * Returns the phase (0..beatsPerBar-1) and a confidence derived from how far
 * the winner is ahead of the runner-up.
 */
export function estimateDownbeatPhase(
  envelope: OnsetEnvelope,
  beats: Float64Array,
  beatsPerBar: number,
): { phase: number; confidence: number } {
  if (beats.length < beatsPerBar * 2) return { phase: 0, confidence: 0 };

  const kick = bandLimitedOnset(envelope, 30, 140);
  const totals = new Float64Array(beatsPerBar);
  for (let i = 0; i < beats.length; i++) {
    const frame = Math.round(beats[i] * envelope.frameRate);
    if (frame < 0 || frame >= kick.length) continue;
    // Small window: the kick transient rarely lands exactly on the frame.
    let peak = 0;
    for (let k = -1; k <= 1; k++) {
      const idx = frame + k;
      if (idx >= 0 && idx < kick.length && kick[idx] > peak) peak = kick[idx];
    }
    totals[i % beatsPerBar] += peak;
  }

  let phase = 0;
  for (let p = 1; p < beatsPerBar; p++) if (totals[p] > totals[phase]) phase = p;

  const sorted = [...totals].sort((a, b) => b - a);
  const confidence = sorted[0] > 0 ? clamp01(1 - sorted[1] / sorted[0]) : 0;
  return { phase, confidence };
}

/**
 * Fit an analytic grid to detected beats.
 *
 * A single tempo is used when the beats are steady enough; otherwise anchors
 * are emitted where the local tempo shifts, which keeps live and hand-played
 * material usable without storing every beat.
 */
export function buildGrid(
  beats: Float64Array,
  bpm: number,
  downbeatPhase: number,
  beatsPerBar: number,
  downbeatConfidence: number,
): { grid: BeatGrid; offsetSec: number; stability: number } {
  if (beats.length < 2) {
    return {
      grid: {
        anchors: [{ timeSec: 0, beatIndex: 0, bpm }],
        beatsPerBar,
        firstDownbeatSec: 0,
        isFixed: true,
        gridConfidence: 0,
        downbeatConfidence: 0,
      },
      offsetSec: 0,
      stability: 0,
    };
  }

  const intervals = new Float64Array(beats.length - 1);
  for (let i = 0; i < intervals.length; i++) intervals[i] = beats[i + 1] - beats[i];
  const meanInterval = mean(intervals);
  const stability = clamp01(1 - stdDev(intervals) / Math.max(meanInterval, 1e-9));

  // Least-squares line through beat times: time = slope * index + intercept.
  const count = beats.length;
  let sumI = 0;
  let sumT = 0;
  let sumII = 0;
  let sumIT = 0;
  for (let i = 0; i < count; i++) {
    sumI += i;
    sumT += beats[i];
    sumII += i * i;
    sumIT += i * beats[i];
  }
  const denom = count * sumII - sumI * sumI;
  const slope = denom !== 0 ? (count * sumIT - sumI * sumT) / denom : meanInterval;
  const intercept = (sumT - slope * sumI) / count;

  const fittedBpm = slope > 0 ? 60 / slope : bpm;

  let deviation = 0;
  for (let i = 0; i < count; i++) deviation += Math.abs(beats[i] - (slope * i + intercept));
  const offsetSec = deviation / count;

  // A steady track is one whose beats sit within a few ms of the fitted line.
  const isFixed = stability > 0.9 && offsetSec < 0.035;

  const anchors: GridAnchor[] = [];
  if (isFixed) {
    anchors.push({ timeSec: intercept, beatIndex: 0, bpm: fittedBpm });
  } else {
    // Emit an anchor whenever the local tempo departs from the running one.
    const windowSize = Math.max(4, beatsPerBar * 2);
    let anchorIndex = 0;
    let anchorBpm = 60 / localInterval(intervals, 0, windowSize);
    anchors.push({ timeSec: beats[0], beatIndex: 0, bpm: anchorBpm });
    for (let i = windowSize; i < count - 1; i += windowSize) {
      const localBpm = 60 / localInterval(intervals, i, windowSize);
      if (Math.abs(localBpm - anchorBpm) / anchorBpm > 0.02) {
        anchors.push({ timeSec: beats[i], beatIndex: i, bpm: localBpm });
        anchorBpm = localBpm;
        anchorIndex = i;
      }
    }
    void anchorIndex;
  }

  const gridConfidence = clamp01(1 - offsetSec / 0.05) * stability;
  const firstDownbeatSec = beats[Math.min(downbeatPhase, beats.length - 1)];

  return {
    grid: {
      anchors,
      beatsPerBar,
      firstDownbeatSec,
      isFixed,
      gridConfidence,
      downbeatConfidence,
    },
    offsetSec,
    stability,
  };
}

function localInterval(intervals: Float64Array, start: number, size: number): number {
  let acc = 0;
  let n = 0;
  for (let i = start; i < Math.min(start + size, intervals.length); i++) {
    acc += intervals[i];
    n++;
  }
  return n > 0 ? acc / n : 0.5;
}

/**
 * Derive beat times from an analytic grid.
 *
 * This is the counterpart to storing anchors instead of beat rows: everything
 * that needs beat positions - the waveform overlay, loops, cue snapping -
 * calls this rather than reading a table.
 */
export function deriveBeatTimes(grid: BeatGrid, durationSec: number): Float64Array {
  if (grid.anchors.length === 0 || durationSec <= 0) return new Float64Array(0);
  const out: number[] = [];

  for (let a = 0; a < grid.anchors.length; a++) {
    const anchor = grid.anchors[a];
    const next = grid.anchors[a + 1];
    const interval = 60 / anchor.bpm;
    if (!Number.isFinite(interval) || interval <= 0) continue;
    const endTime = next ? next.timeSec : durationSec;

    // Walk backwards from the first anchor so beats before it still appear.
    if (a === 0) {
      for (let t = anchor.timeSec - interval; t >= 0; t -= interval) out.push(t);
      out.reverse();
    }
    for (let t = anchor.timeSec; t < endTime - 1e-9; t += interval) out.push(t);
  }

  out.sort((x, y) => x - y);
  return Float64Array.from(out.filter((t) => t >= 0 && t <= durationSec));
}

/** Bar number for a time, or -1 before the first downbeat. */
export function barIndexAt(grid: BeatGrid, timeSec: number, durationSec: number): number {
  const beats = deriveBeatTimes(grid, durationSec);
  if (beats.length === 0) return -1;
  let firstDownbeat = 0;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] >= grid.firstDownbeatSec - 1e-6) {
      firstDownbeat = i;
      break;
    }
  }
  let beatIndex = -1;
  for (let i = beats.length - 1; i >= 0; i--) {
    if (beats[i] <= timeSec + 1e-9) {
      beatIndex = i;
      break;
    }
  }
  if (beatIndex < firstDownbeat) return -1;
  return Math.floor((beatIndex - firstDownbeat) / grid.beatsPerBar);
}

function mean(values: Float64Array): number {
  if (values.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc += values[i];
  return acc / values.length;
}

function stdDev(values: Float64Array): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (let i = 0; i < values.length; i++) acc += (values[i] - m) ** 2;
  return Math.sqrt(acc / values.length);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
