/**
 * Vocal activity estimation (research Phase H).
 *
 * Not a source-separation model and not presented as one. It combines three
 * cheap cues that together separate sung passages from instrumental ones well
 * enough to label sections and to warn about vocal clashes when mixing:
 *
 * 1. **Band energy.** Sung vowels put most of their power between roughly
 *    200 Hz and 4 kHz. On its own this also fires on guitars and synths.
 * 2. **Harmonicity.** Voice is pitched, so it survives a median filter along
 *    time while drums do not. Percussion is discounted.
 * 3. **Modulation.** A held synth pad is steady; a voice moves constantly from
 *    vibrato, consonants and phrasing. Measuring how much the band energy
 *    fluctuates at 3-8 Hz is what separates the two, and it is the cue that
 *    stops pads from reading as singing.
 *
 * Output is 0..1 per frame, smoothed. Treat it as evidence, not truth.
 */
import { binFrequencies, frameAt, type Spectrogram } from "./spectral";

export interface VocalActivity {
  /** Per-frame likelihood, 0..1. */
  values: Float32Array;
  frameRate: number;
  /** Share of the track above the activity threshold, 0..1. */
  coverage: number;
}

/** Above this a frame counts as containing voice. */
export const VOCAL_THRESHOLD = 0.45;

const VOCAL_LOW_HZ = 200;
const VOCAL_HIGH_HZ = 4000;

/** Median of a window, used to separate sustained from transient content. */
function medianOf(values: Float64Array, centre: number, radius: number): number {
  const start = Math.max(0, centre - radius);
  const end = Math.min(values.length, centre + radius + 1);
  const slice = Array.prototype.slice.call(values, start, end) as number[];
  slice.sort((a, b) => a - b);
  return slice[slice.length >> 1] ?? 0;
}

export function computeVocalActivity(spec: Spectrogram): VocalActivity {
  const freqs = binFrequencies(spec);
  const frames = spec.frameCount;

  // Per-frame energy inside and outside the vocal band.
  const band = new Float64Array(frames);
  const total = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const frame = frameAt(spec, f);
    let inBand = 0;
    let all = 0;
    for (let b = 1; b < spec.binCount; b++) {
      const magnitude = frame[b];
      all += magnitude;
      if (freqs[b] >= VOCAL_LOW_HZ && freqs[b] <= VOCAL_HIGH_HZ) inBand += magnitude;
    }
    band[f] = inBand;
    total[f] = all;
  }

  // Harmonicity: how much of the band energy survives smoothing along time.
  const smoothRadius = Math.max(1, Math.round(spec.frameRate * 0.12));
  const harmonic = new Float64Array(frames);
  for (let f = 0; f < frames; f++) harmonic[f] = medianOf(band, f, smoothRadius);

  // Modulation: deviation from the local mean, which voice has and pads lack.
  const modRadius = Math.max(2, Math.round(spec.frameRate * 0.35));
  const modulation = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = Math.max(0, f - modRadius);
    const end = Math.min(frames, f + modRadius + 1);
    let mean = 0;
    for (let i = start; i < end; i++) mean += band[i];
    mean /= Math.max(1, end - start);
    let variance = 0;
    for (let i = start; i < end; i++) variance += (band[i] - mean) ** 2;
    variance /= Math.max(1, end - start);
    modulation[f] = mean > 0 ? Math.sqrt(variance) / mean : 0;
  }

  const values = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (total[f] <= 0) continue;
    const share = band[f] / total[f];
    const harmonicity = band[f] > 0 ? Math.min(1, harmonic[f] / band[f]) : 0;
    // Modulation around 0.15-0.5 is typical of singing; scale into 0..1.
    const moved = Math.min(1, modulation[f] / 0.45);
    values[f] = clamp01(share * 1.4) * clamp01(harmonicity * 1.2) * clamp01(0.35 + moved);
  }

  // Smooth: vocals last syllables, not frames, so isolated spikes are noise.
  const smoothed = new Float32Array(frames);
  const radius = Math.max(1, Math.round(spec.frameRate * 0.25));
  for (let f = 0; f < frames; f++) {
    const start = Math.max(0, f - radius);
    const end = Math.min(frames, f + radius + 1);
    let acc = 0;
    for (let i = start; i < end; i++) acc += values[i];
    smoothed[f] = acc / Math.max(1, end - start);
  }

  // Normalise against the track's own maximum: absolute levels vary far too
  // much between productions for a fixed scale to mean anything.
  let peak = 0;
  for (let f = 0; f < frames; f++) if (smoothed[f] > peak) peak = smoothed[f];
  if (peak > 0) for (let f = 0; f < frames; f++) smoothed[f] /= peak;

  let above = 0;
  for (let f = 0; f < frames; f++) if (smoothed[f] >= VOCAL_THRESHOLD) above++;

  return {
    values: smoothed,
    frameRate: spec.frameRate,
    coverage: frames > 0 ? above / frames : 0,
  };
}

/** Mean vocal activity over a time range. */
export function vocalActivityBetween(
  activity: VocalActivity,
  startSec: number,
  endSec: number,
): number {
  const from = Math.max(0, Math.floor(startSec * activity.frameRate));
  const to = Math.min(activity.values.length, Math.ceil(endSec * activity.frameRate));
  if (to <= from) return 0;
  let acc = 0;
  for (let i = from; i < to; i++) acc += activity.values[i];
  return acc / (to - from);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
