/**
 * Peak window helpers for waveform zoom / pan.
 *
 * Stored peaks are a fixed-length envelope (typically ~2000 buckets). Zooming
 * re-samples a fractional window into a display buffer instead of keeping a
 * full multi-resolution pyramid on disk.
 */

/** Clamp a unit interval [start, end] into [0, 1] with end > start. */
export function clampViewWindow(
  start: number,
  end: number,
  minSpan = 1 / 64,
): { start: number; end: number } {
  let s = Number.isFinite(start) ? start : 0;
  let e = Number.isFinite(end) ? end : 1;
  if (e < s) [s, e] = [e, s];
  s = Math.max(0, Math.min(1, s));
  e = Math.max(0, Math.min(1, e));
  if (e - s < minSpan) {
    const mid = (s + e) / 2;
    s = Math.max(0, mid - minSpan / 2);
    e = Math.min(1, s + minSpan);
    s = Math.max(0, e - minSpan);
  }
  return { start: s, end: e };
}

/**
 * Downsample (or upsample by nearest) a peak slice covering [viewStart, viewEnd]
 * of the full peak array into `outBuckets` display samples using max amplitude.
 */
export function samplePeaksForView(
  peaks: Float32Array,
  viewStart: number,
  viewEnd: number,
  outBuckets: number,
): Float32Array {
  const { start, end } = clampViewWindow(viewStart, viewEnd);
  const out = new Float32Array(Math.max(1, outBuckets));
  if (peaks.length === 0) return out;

  const i0 = Math.floor(start * peaks.length);
  const i1 = Math.max(i0 + 1, Math.ceil(end * peaks.length));
  const span = i1 - i0;
  for (let b = 0; b < out.length; b++) {
    const from = i0 + Math.floor((b / out.length) * span);
    const to = i0 + Math.floor(((b + 1) / out.length) * span);
    let peak = 0;
    for (let i = from; i < Math.max(from + 1, to); i++) {
      const v = peaks[Math.min(i, peaks.length - 1)] ?? 0;
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

/** Map a timeline second into an x pixel within the current view window. */
export function timeToViewX(
  timeSec: number,
  durationSec: number,
  viewStart: number,
  viewEnd: number,
  width: number,
): number | null {
  if (durationSec <= 0 || width <= 0) return null;
  const { start, end } = clampViewWindow(viewStart, viewEnd);
  const frac = timeSec / durationSec;
  if (frac < start || frac > end) return null;
  return ((frac - start) / (end - start)) * width;
}

/** Map a click x into timeline seconds for the current view window. */
export function viewXToTime(
  x: number,
  width: number,
  durationSec: number,
  viewStart: number,
  viewEnd: number,
): number {
  if (width <= 0 || durationSec <= 0) return 0;
  const { start, end } = clampViewWindow(viewStart, viewEnd);
  const frac = start + (Math.max(0, Math.min(1, x / width))) * (end - start);
  return frac * durationSec;
}

/**
 * Zoom the view window around a focus fraction (0–1 across the widget),
 * multiplying span by factor (<1 zooms in).
 */
export function zoomViewWindow(
  viewStart: number,
  viewEnd: number,
  focusFrac: number,
  factor: number,
): { start: number; end: number } {
  const { start, end } = clampViewWindow(viewStart, viewEnd);
  const span = end - start;
  const focus = start + Math.max(0, Math.min(1, focusFrac)) * span;
  const nextSpan = span * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const left = focus - (focus - start) * (nextSpan / span);
  const right = left + nextSpan;
  return clampViewWindow(left, right);
}

/** Pan the window by a fraction of its own span (positive = later in the track). */
export function panViewWindow(
  viewStart: number,
  viewEnd: number,
  deltaFracOfSpan: number,
): { start: number; end: number } {
  const { start, end } = clampViewWindow(viewStart, viewEnd);
  const span = end - start;
  const shift = deltaFracOfSpan * span;
  return clampViewWindow(start + shift, end + shift);
}
