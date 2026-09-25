/**
 * Median-filter harmonic/percussive source separation.
 *
 * Harmonic residual: median along time (sustained partials). Percussive
 * residual: median along frequency (vertical transients). Soft-masked back
 * onto the input spectrogram. In-repo only; no licensed HPSS library.
 *
 * This is a lightweight heuristic split for bass-chroma / key support, not a
 * stem separator and not a certified transcription front-end.
 */
import { frameAt, type Spectrogram } from "./spectral";

export const HPSS_HARMONIC_WIDTH = 17;
export const HPSS_PERCUSSIVE_WIDTH = 17;

export interface HpssResult {
  harmonic: Spectrogram;
  percussive: Spectrogram;
  harmonicEnergy: number;
  percussiveEnergy: number;
  /** Percussive share of (H + P), 0..1. */
  percussiveRatio: number;
}

function medianOf(values: Float32Array, count: number): number {
  const slice = Array.from(values.subarray(0, count));
  slice.sort((a, b) => a - b);
  const mid = (count - 1) >> 1;
  return count % 2 === 0 ? 0.5 * (slice[mid] + slice[mid + 1]) : slice[mid];
}

function medianFilter(input: Float32Array, window: number): Float32Array {
  const width = Math.max(1, window | 1);
  const half = (width - 1) >> 1;
  const out = new Float32Array(input.length);
  const buf = new Float32Array(width);
  for (let i = 0; i < input.length; i++) {
    let n = 0;
    const start = Math.max(0, i - half);
    const end = Math.min(input.length, i + half + 1);
    for (let j = start; j < end; j++) buf[n++] = input[j];
    out[i] = medianOf(buf, n);
  }
  return out;
}

function withData(spec: Spectrogram, data: Float32Array): Spectrogram {
  return {
    data,
    frameCount: spec.frameCount,
    binCount: spec.binCount,
    frameRate: spec.frameRate,
    sampleRate: spec.sampleRate,
    fftSize: spec.fftSize,
    hopSize: spec.hopSize,
  };
}

export function medianFilterHpss(
  spec: Spectrogram,
  options: { harmonicWidth?: number; percussiveWidth?: number } = {},
): HpssResult {
  const harmonicWidth = options.harmonicWidth ?? HPSS_HARMONIC_WIDTH;
  const percussiveWidth = options.percussiveWidth ?? HPSS_PERCUSSIVE_WIDTH;
  const { frameCount, binCount } = spec;

  const harmFilt = new Float32Array(frameCount * binCount);
  const percFilt = new Float32Array(frameCount * binCount);

  const timeCol = new Float32Array(frameCount);
  for (let b = 0; b < binCount; b++) {
    for (let f = 0; f < frameCount; f++) timeCol[f] = spec.data[f * binCount + b];
    const filtered = medianFilter(timeCol, harmonicWidth);
    for (let f = 0; f < frameCount; f++) harmFilt[f * binCount + b] = filtered[f];
  }

  for (let f = 0; f < frameCount; f++) {
    const frame = frameAt(spec, f);
    const filtered = medianFilter(frame, percussiveWidth);
    percFilt.set(filtered, f * binCount);
  }

  const harmData = new Float32Array(frameCount * binCount);
  const percData = new Float32Array(frameCount * binCount);
  let harmonicEnergy = 0;
  let percussiveEnergy = 0;
  for (let i = 0; i < harmFilt.length; i++) {
    const h = harmFilt[i];
    const p = percFilt[i];
    const denom = h + p;
    const hm = denom > 0 ? h / denom : 0.5;
    const mag = spec.data[i];
    const hv = mag * hm;
    const pv = mag * (1 - hm);
    harmData[i] = hv;
    percData[i] = pv;
    harmonicEnergy += hv;
    percussiveEnergy += pv;
  }

  const total = harmonicEnergy + percussiveEnergy;
  return {
    harmonic: withData(spec, harmData),
    percussive: withData(spec, percData),
    harmonicEnergy,
    percussiveEnergy,
    percussiveRatio: total > 0 ? percussiveEnergy / total : 0,
  };
}
