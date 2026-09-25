/**
 * Transition audition payload (ranking -> short Mix preview).
 *
 * Builds the numbers Mix Mode needs to load outgoing + incoming decks:
 * effective BPMs (locked/manual respected), durations, and a short
 * end-of-outgoing / start-of-incoming window. Does not play audio itself.
 */
import type { TrackMetadata } from "../db/catalog";
import { effectiveBpm, effectiveGridOf } from "../db/library";
import type { Recommendation } from "./recommendations";

export interface AuditionPayload {
  fromTrackId: string;
  toTrackId: string;
  fromBpm: number;
  toBpm: number;
  fromDurationSec: number;
  toDurationSec: number;
  fromStartSec: number;
  toStartSec: number;
  crossfadeSec: number;
  predictedScore: number;
  rank: number;
}

export interface AuditionOptions {
  /** Phrase-sized preview window in bars of the outgoing grid. */
  bars?: number;
  crossfadeSec?: number;
}

/** Seconds for `bars` bars on a 4/4 grid at this BPM. */
export function barsToSeconds(bpm: number, bars: number, beatsPerBar = 4): number {
  if (!(bpm > 0) || !(bars > 0)) return 0;
  return (60 / bpm) * beatsPerBar * bars;
}

export function buildAuditionPayload(
  source: TrackMetadata,
  recommendation: Recommendation,
  rank: number,
  options: AuditionOptions = {},
): AuditionPayload | null {
  const fromBpm = effectiveBpm(source);
  const toBpm = effectiveBpm(recommendation.track);
  if (!fromBpm || !toBpm) return null;

  const fromDurationSec = source.durationSec;
  const toDurationSec = recommendation.track.durationSec;
  if (!(fromDurationSec > 0) || !(toDurationSec > 0)) return null;

  const fromGrid = effectiveGridOf(source).grid;
  const beatsPerBar = fromGrid?.beatsPerBar ?? 4;
  const bars = options.bars ?? 16;
  const windowSec = barsToSeconds(fromBpm, bars, beatsPerBar);
  const incomingWindow = barsToSeconds(toBpm, Math.min(bars, 8), beatsPerBar);
  const defaultFade = Math.min(8, windowSec / 2, incomingWindow, fromDurationSec / 4, toDurationSec / 4);
  const crossfadeSec = Math.max(1, options.crossfadeSec ?? defaultFade);

  const fromStartSec = Math.max(0, fromDurationSec - Math.max(crossfadeSec * 2, windowSec / 2));
  const toStartSec = 0;

  return {
    fromTrackId: source.id,
    toTrackId: recommendation.track.id,
    fromBpm,
    toBpm,
    fromDurationSec,
    toDurationSec,
    fromStartSec,
    toStartSec,
    crossfadeSec,
    predictedScore: recommendation.score,
    rank,
  };
}
