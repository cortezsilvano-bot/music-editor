/**
 * Onset strength (research Phase D, first stage).
 *
 * SuperFlux-style spectral flux: differences are taken against a
 * frequency-maximum-filtered earlier frame, which stops vibrato and slow pitch
 * drift from registering as onsets the way plain spectral flux does.
 *
 * Band-limited envelopes fall out of the same filterbank and are reused by the
 * kick-alignment and energy stages, so the transform is only paid for once.
 */
import { frameAt, type Spectrogram } from "./spectral";

export interface OnsetOptions {
  /** Filterbank resolution. */
  bandCount: number;
  /** Frames to look back when differencing. */
  lag: number;
  /** Half-width, in bands, of the maximum filter. */
  maxFilterRadius: number;
  /** Log compression strength. */
  compression: number;
}

export const DEFAULT_ONSET: OnsetOptions = {
  bandCount: 84,
  lag: 2,
  maxFilterRadius: 1,
  compression: 1000,
};

export interface OnsetEnvelope {
  /** Per-frame onset strength, normalised to a maximum of 1. */
  readonly values: Float32Array;
  readonly frameRate: number;
  /** Log-compressed band energies: frame * bandCount + band. */
  readonly bands: Float32Array;
  readonly bandCount: number;
  /** Lower edge frequency of each band, Hz. */
  readonly bandFrequencies: Float64Array;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/**
 * Triangular mel filterbank, stored as per-band bin ranges and weights so the
 * per-frame application stays sparse.
 */
function buildFilterbank(spec: Spectrogram, bandCount: number, minHz: number, maxHz: number) {
  const nyquist = spec.sampleRate / 2;
  const top = Math.min(maxHz, nyquist);
  const edges = new Float64Array(bandCount + 2);
  const melLow = hzToMel(minHz);
  const melHigh = hzToMel(top);
  for (let i = 0; i < edges.length; i++) {
    edges[i] = melToHz(melLow + ((melHigh - melLow) * i) / (edges.length - 1));
  }

  const binOf = (hz: number) => (hz * spec.fftSize) / spec.sampleRate;
  const starts = new Int32Array(bandCount);
  const ends = new Int32Array(bandCount);
  const weights: Float32Array[] = [];
  const lowerEdges = new Float64Array(bandCount);

  for (let b = 0; b < bandCount; b++) {
    const lo = binOf(edges[b]);
    const mid = binOf(edges[b + 1]);
    const hi = binOf(edges[b + 2]);
    const start = Math.max(0, Math.floor(lo));
    const end = Math.min(spec.binCount - 1, Math.ceil(hi));
    const w = new Float32Array(Math.max(0, end - start + 1));
    for (let bin = start; bin <= end; bin++) {
      let weight = 0;
      if (bin >= lo && bin <= mid && mid > lo) weight = (bin - lo) / (mid - lo);
      else if (bin > mid && bin <= hi && hi > mid) weight = (hi - bin) / (hi - mid);
      w[bin - start] = weight;
    }
    starts[b] = start;
    ends[b] = end;
    weights.push(w);
    lowerEdges[b] = edges[b];
  }
  return { starts, ends, weights, lowerEdges };
}

export function computeOnsetEnvelope(
  spec: Spectrogram,
  options: Partial<OnsetOptions> = {},
): OnsetEnvelope {
  const opts = { ...DEFAULT_ONSET, ...options };
  const { bandCount, lag, maxFilterRadius, compression } = opts;
  const bank = buildFilterbank(spec, bandCount, 30, 11000);

  // Log-compressed band energies for every frame.
  const bands = new Float32Array(spec.frameCount * bandCount);
  for (let f = 0; f < spec.frameCount; f++) {
    const frame = frameAt(spec, f);
    const offset = f * bandCount;
    for (let b = 0; b < bandCount; b++) {
      const start = bank.starts[b];
      const end = bank.ends[b];
      const w = bank.weights[b];
      let acc = 0;
      for (let bin = start; bin <= end; bin++) acc += frame[bin] * w[bin - start];
      bands[offset + b] = Math.log1p(compression * acc);
    }
  }

  // SuperFlux difference against a frequency-max-filtered earlier frame.
  const values = new Float32Array(spec.frameCount);
  for (let f = lag; f < spec.frameCount; f++) {
    const cur = f * bandCount;
    const prev = (f - lag) * bandCount;
    let flux = 0;
    for (let b = 0; b < bandCount; b++) {
      let reference = 0;
      const lo = Math.max(0, b - maxFilterRadius);
      const hi = Math.min(bandCount - 1, b + maxFilterRadius);
      for (let k = lo; k <= hi; k++) {
        const v = bands[prev + k];
        if (v > reference) reference = v;
      }
      const diff = bands[cur + b] - reference;
      if (diff > 0) flux += diff;
    }
    values[f] = flux;
  }

  normaliseInPlace(values);

  return {
    values,
    frameRate: spec.frameRate,
    bands,
    bandCount,
    bandFrequencies: bank.lowerEdges,
  };
}

/**
 * Subtract a moving average and rescale to [0, 1].
 *
 * Without this a loud section produces a permanently raised floor and the beat
 * tracker biases towards it.
 */
function normaliseInPlace(values: Float32Array): void {
  const n = values.length;
  if (n === 0) return;
  const radius = 8;
  const smoothed = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i > 2 * radius) sum -= values[i - 2 * radius - 1];
    const count = Math.min(i + 1, 2 * radius + 1);
    smoothed[i] = sum / count;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i] - smoothed[i];
    values[i] = v > 0 ? v : 0;
    if (values[i] > peak) peak = values[i];
  }
  if (peak > 0) for (let i = 0; i < n; i++) values[i] /= peak;
}

/**
 * Onset strength restricted to a frequency range.
 *
 * The kick band drives downbeat and grid-offset decisions, where full-spectrum
 * flux is dominated by hats and vocals.
 */
export function bandLimitedOnset(
  envelope: OnsetEnvelope,
  lowHz: number,
  highHz: number,
): Float32Array {
  const { bandCount, bandFrequencies, bands } = envelope;
  const frameCount = envelope.values.length;
  const out = new Float32Array(frameCount);
  const lo = Math.max(0, bandFrequencies.findIndex((f) => f >= lowHz));
  let hi = bandCount - 1;
  for (let b = bandCount - 1; b >= 0; b--) {
    if (bandFrequencies[b] <= highHz) {
      hi = b;
      break;
    }
  }
  for (let f = 1; f < frameCount; f++) {
    const cur = f * bandCount;
    const prev = (f - 1) * bandCount;
    let flux = 0;
    for (let b = lo; b <= hi; b++) {
      const diff = bands[cur + b] - bands[prev + b];
      if (diff > 0) flux += diff;
    }
    out[f] = flux;
  }
  normaliseInPlace(out);
  return out;
}
