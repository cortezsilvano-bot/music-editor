/**
 * Phrase estimation from an effective beat grid.
 *
 * 8/16/32-bar phrases are placed on bar lines of the grid in force (detected,
 * manual, or locked). When an energy curve is present the length is the one
 * whose boundaries line up with larger energy changes; otherwise 16 bars is
 * the default for a long enough track. This is a grid heuristic, not a
 * labelled-corpus phrase detector.
 */
import { deriveBeatTimes, type BeatGrid } from "./beats";

export type PhraseLength = 8 | 16 | 32;

export interface PhraseBoundary {
  startSec: number;
  endSec: number;
  /** 0-based bar index of the phrase start. */
  barIndex: number;
  lengthBars: PhraseLength;
}

export interface PhraseResult {
  lengthBars: PhraseLength;
  phrases: PhraseBoundary[];
  /** 0..1 alignment heuristic. Not a corpus accuracy figure. */
  confidence: number;
}

/** Bar-line times taken from the grid so phrases land on musical boundaries. */
export function phraseBarStarts(grid: BeatGrid, durationSec: number): number[] {
  const beats = deriveBeatTimes(grid, durationSec);
  const first = Array.from(beats).findIndex((t) => t >= grid.firstDownbeatSec - 1e-6);
  const starts = [0];
  if (first >= 0) {
    for (let i = first; i < beats.length; i += grid.beatsPerBar) {
      if (beats[i] > 0 && beats[i] < durationSec) starts.push(beats[i]);
    }
  }
  return starts;
}

function meanOverRange(curve: Float32Array, startSec: number, endSec: number): number {
  let sum = 0;
  let weight = 0;
  for (let s = Math.floor(startSec); s < Math.ceil(endSec); s++) {
    const overlap = Math.max(0, Math.min(endSec, s + 1) - Math.max(startSec, s));
    sum += (curve[s] ?? 0) * overlap;
    weight += overlap;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * How strongly energy changes sit on every L-th bar versus the other bars.
 *
 * A ratio above 1 means the candidate length is better than a uniform bar
 * split. Flat or missing energy scores a mild prior (16 preferred).
 */
function lengthScore(
  starts: number[],
  durationSec: number,
  lengthBars: PhraseLength,
  energyCurve?: Float32Array,
): number {
  const prior = lengthBars === 16 ? 0.12 : lengthBars === 8 ? 0.08 : 0.04;
  if (!energyCurve || energyCurve.length === 0 || starts.length < lengthBars + 4) {
    return prior;
  }
  let on = 0;
  let onN = 0;
  let off = 0;
  let offN = 0;
  for (let i = 4; i + 4 <= starts.length; i++) {
    const before = meanOverRange(energyCurve, starts[i - 4], starts[i]);
    const after = meanOverRange(
      energyCurve,
      starts[i],
      starts[Math.min(i + 4, starts.length - 1)] ?? durationSec,
    );
    const delta = Math.abs(after - before);
    if (i % lengthBars === 0) {
      on += delta;
      onN++;
    } else {
      off += delta;
      offN++;
    }
  }
  const onMean = onN > 0 ? on / onN : 0;
  const offMean = offN > 0 ? off / offN : 0;
  const ratio = offMean > 1e-6 ? onMean / offMean : onMean > 0 ? 1.2 : 0;
  return prior + Math.min(0.7, ratio * 0.25);
}

export function estimatePhrases(
  grid: BeatGrid,
  durationSec: number,
  energyCurve?: Float32Array,
): PhraseResult {
  if (durationSec <= 0 || grid.anchors.length === 0) {
    return { lengthBars: 8, phrases: [], confidence: 0 };
  }

  const starts = phraseBarStarts(grid, durationSec);
  const barCount = starts.length;
  const candidates: PhraseLength[] = [8, 16, 32];
  let lengthBars: PhraseLength = barCount >= 16 ? 16 : 8;
  let best = -1;
  for (const candidate of candidates) {
    if (barCount < candidate) continue;
    const score = lengthScore(starts, durationSec, candidate, energyCurve);
    if (score > best) {
      best = score;
      lengthBars = candidate;
    }
  }
  if (barCount < 8) lengthBars = 8;

  const phrases: PhraseBoundary[] = [];
  for (let i = 0; i < starts.length; i += lengthBars) {
    phrases.push({
      startSec: starts[i],
      endSec: starts[i + lengthBars] ?? durationSec,
      barIndex: i,
      lengthBars,
    });
  }

  const confidence = Math.max(0, Math.min(1, best < 0 ? 0.3 : best));
  return { lengthBars, phrases, confidence };
}
