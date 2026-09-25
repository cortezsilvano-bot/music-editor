/**
 * Multi-level waveform peak pyramid helpers.
 *
 * Stored library peaks are typically ~2000 buckets. A pyramid keeps successive
 * max-downsampled levels so WaveformView can pick a resolution that matches the
 * current zoom window instead of always resampling the finest array.
 */
export interface PeakPyramidLevels {
  /** Coarsest first, finest last. */
  levels: Float32Array[];
  bucketCounts: number[];
}

const DEFAULT_BUCKETS = [32, 125, 500, 2000];

/** Max-downsample `source` into `buckets` samples. */
export function downsamplePeaks(source: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(Math.max(1, buckets));
  if (source.length === 0) return out;
  const span = source.length;
  for (let b = 0; b < out.length; b++) {
    const from = Math.floor((b / out.length) * span);
    const to = Math.floor(((b + 1) / out.length) * span);
    let peak = 0;
    for (let i = from; i < Math.max(from + 1, to); i++) {
      const v = source[Math.min(i, source.length - 1)] ?? 0;
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

/**
 * Build a pyramid from the finest peak buffer.
 * Levels are ordered coarse → fine; the finest is a copy of (or downsample to) target.
 */
export function buildPeakPyramid(
  peaks: Float32Array,
  bucketTargets: number[] = DEFAULT_BUCKETS,
): PeakPyramidLevels {
  const targets = [...bucketTargets]
    .map((n) => Math.max(1, Math.floor(n)))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b);
  const finestTarget = targets[targets.length - 1] ?? Math.max(1, peaks.length);
  const finest =
    peaks.length === finestTarget
      ? peaks.slice()
      : downsamplePeaks(peaks, finestTarget);
  const levels: Float32Array[] = [];
  for (const buckets of targets) {
    if (buckets >= finest.length) {
      levels.push(finest.slice());
    } else {
      levels.push(downsamplePeaks(finest, buckets));
    }
  }
  return { levels, bucketCounts: levels.map((level) => level.length) };
}

/**
 * Choose the coarsest level whose visible window still covers `outBuckets`
 * source samples (avoids heavy upsampling while zoomed out).
 */
export function selectPyramidLevel(
  levels: Float32Array[],
  viewSpan: number,
  outBuckets: number,
): Float32Array {
  if (levels.length === 0) return new Float32Array(0);
  const span = Number.isFinite(viewSpan) ? Math.min(1, Math.max(1e-6, viewSpan)) : 1;
  const need = Math.max(1, outBuckets);
  for (const level of levels) {
    if (level.length * span >= need) return level;
  }
  return levels[levels.length - 1]!;
}

/** Stable Dexie primary key: prefer content hash, else track-scoped id. */
export function peakPyramidId(trackId: string, contentHash?: string | null): string {
  if (contentHash && contentHash.length > 0) return `hash:${contentHash}`;
  return `track:${trackId}`;
}
