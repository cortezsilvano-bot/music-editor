/**
 * Shared analysis preprocessing (research Phase C).
 *
 * Every downstream stage - onsets, tempo, key, energy - reads from the one
 * spectrogram produced here rather than recomputing its own transform. The
 * analysis signal is mono and downsampled; the caller's original audio is
 * never modified.
 */
import { FFT } from "./fft";

/** Sample rate every analysis stage operates at. */
export const ANALYSIS_SAMPLE_RATE = 22050;

export interface StftOptions {
  fftSize: number;
  hopSize: number;
}

export const DEFAULT_STFT: StftOptions = { fftSize: 1024, hopSize: 256 };

export interface Spectrogram {
  /** Row-major magnitudes: frame * binCount + bin. */
  readonly data: Float32Array;
  readonly frameCount: number;
  readonly binCount: number;
  /** Frames per second. */
  readonly frameRate: number;
  readonly sampleRate: number;
  readonly fftSize: number;
  readonly hopSize: number;
}

/** Periodic Hann window - the correct form for overlap-add analysis. */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  }
  return w;
}

/** Average all channels into one. Returns the input untouched if already mono. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const out = new Float32Array(length);
  for (const channel of channels) {
    const n = Math.min(length, channel.length);
    for (let i = 0; i < n; i++) out[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}

/**
 * Resample with a windowed-sinc low-pass when decimating.
 *
 * Plain interpolation would alias energy above the new Nyquist back down into
 * the band the tempo and chroma stages read, which shows up as phantom onsets.
 */
export function resample(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate || input.length === 0) return input;

  const ratio = targetRate / sourceRate;
  let signal = input;

  if (ratio < 1) {
    // Low-pass at the destination Nyquist before decimating.
    const cutoff = 0.5 * ratio;
    const taps = 63;
    const half = (taps - 1) / 2;
    const kernel = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - half;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      // Blackman window keeps the stop-band down where it matters.
      const w =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      kernel[i] = sinc * w;
      sum += kernel[i];
    }
    for (let i = 0; i < taps; i++) kernel[i] /= sum;

    const filtered = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const j = i + k - half;
        if (j >= 0 && j < input.length) acc += input[j] * kernel[k];
      }
      filtered[i] = acc;
    }
    signal = filtered;
  }

  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = signal[Math.min(i0, signal.length - 1)];
    const b = signal[Math.min(i0 + 1, signal.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Magnitude STFT. Frames are centred, so frame `i` is at sample `i * hop`. */
export function computeStft(
  signal: Float32Array,
  sampleRate: number,
  options: StftOptions = DEFAULT_STFT,
): Spectrogram {
  const { fftSize, hopSize } = options;
  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const binCount = fftSize / 2 + 1;
  const half = fftSize / 2;

  const frameCount = Math.max(1, Math.ceil(signal.length / hopSize));
  const data = new Float32Array(frameCount * binCount);
  const frame = new Float64Array(fftSize);
  const mags = new Float64Array(binCount);

  for (let f = 0; f < frameCount; f++) {
    const centre = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      const s = centre + i - half;
      frame[i] = s >= 0 && s < signal.length ? signal[s] * window[i] : 0;
    }
    fft.magnitudes(frame, mags);
    const offset = f * binCount;
    for (let b = 0; b < binCount; b++) data[offset + b] = mags[b];
  }

  return {
    data,
    frameCount,
    binCount,
    frameRate: sampleRate / hopSize,
    sampleRate,
    fftSize,
    hopSize,
  };
}

/** Centre frequency of each STFT bin, in Hz. */
export function binFrequencies(spec: Spectrogram): Float64Array {
  const freqs = new Float64Array(spec.binCount);
  for (let b = 0; b < spec.binCount; b++) {
    freqs[b] = (b * spec.sampleRate) / spec.fftSize;
  }
  return freqs;
}

/** One frame's magnitudes as a subarray view - no copy. */
export function frameAt(spec: Spectrogram, index: number): Float32Array {
  const offset = index * spec.binCount;
  return spec.data.subarray(offset, offset + spec.binCount);
}
