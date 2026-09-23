/**
 * Loudness to EBU R128 / ITU-R BS.1770-4 (research Phase F).
 *
 * K-weighting, 400 ms blocks at 75% overlap, two-stage gating, and 4x
 * oversampled true peak. Filter coefficients are derived from the analog
 * prototypes at the actual sample rate rather than hard-coded for 48 kHz, so
 * 44.1 kHz material measures correctly instead of being a few tenths out.
 */

export interface LoudnessResult {
  /** Integrated loudness over the whole programme, LUFS. */
  integratedLufs: number;
  /** Loudness range, LU. */
  rangeLu: number;
  /** Highest 400 ms window, LUFS. */
  maxMomentaryLufs: number;
  /** Highest 3 s window, LUFS. */
  maxShortTermLufs: number;
  /** Peak after 4x oversampling, dBTP. */
  truePeakDbtp: number;
  /** Sample peak before oversampling, dBFS. */
  samplePeakDbfs: number;
  /** Short-term values, one per second, for the energy curve. */
  shortTermLufs: Float32Array;
}

/** Below this a block is treated as silence and excluded. */
const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate sits this far below the mean of the surviving blocks. */
const RELATIVE_GATE_LU = -10;
/** LRA uses a looser relative gate than the integrated measurement. */
const LRA_RELATIVE_GATE_LU = -20;
/** The BS.1770 calibration offset. */
const OFFSET = -0.691;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages for a given rate.
 *
 * Stage one is a high shelf approximating the acoustic effect of the head;
 * stage two is a high-pass that discounts subsonic energy. The constants are
 * the analog prototype values from BS.1770.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf.
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q1 = 0.7071752369554196;
  const K1 = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const a0 = 1 + K1 / Q1 + K1 * K1;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / a0,
    b1: (2 * (K1 * K1 - Vh)) / a0,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / a0,
    a1: (2 * (K1 * K1 - 1)) / a0,
    a2: (1 - K1 / Q1 + K1 * K1) / a0,
  };

  // Stage 2: high pass.
  const f1 = 38.13547087602444;
  const Q2 = 0.5003270373238773;
  const K2 = Math.tan((Math.PI * f1) / sampleRate);
  const denom = 1 + K2 / Q2 + K2 * K2;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / denom,
    a2: (1 - K2 / Q2 + K2 * K2) / denom,
  };

  return [shelf, highpass];
}

function applyBiquad(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

export function kWeight(channel: Float32Array, sampleRate: number): Float32Array {
  const [shelf, highpass] = kWeightingFilters(sampleRate);
  return applyBiquad(applyBiquad(channel, shelf), highpass);
}

/** Loudness of one block from its per-channel mean squares. */
function blockLoudness(meanSquares: number[], weights: number[]): number {
  let sum = 0;
  for (let c = 0; c < meanSquares.length; c++) sum += weights[c] * meanSquares[c];
  if (sum <= 0) return -Infinity;
  return OFFSET + 10 * Math.log10(sum);
}

/**
 * Sliding mean squares of the K-weighted channels.
 *
 * Returns one entry per block, each holding the per-channel mean square, so the
 * gating stages can re-weight without refiltering.
 */
function blockMeanSquares(
  weighted: Float32Array[],
  sampleRate: number,
  blockSeconds: number,
  stepSeconds: number,
): number[][] {
  const blockSize = Math.round(blockSeconds * sampleRate);
  const step = Math.round(stepSeconds * sampleRate);
  const length = weighted[0]?.length ?? 0;
  const blocks: number[][] = [];
  if (blockSize <= 0 || length < blockSize) return blocks;

  for (let start = 0; start + blockSize <= length; start += step) {
    const perChannel: number[] = [];
    for (const channel of weighted) {
      let acc = 0;
      for (let i = start; i < start + blockSize; i++) acc += channel[i] * channel[i];
      perChannel.push(acc / blockSize);
    }
    blocks.push(perChannel);
  }
  return blocks;
}

/**
 * Two-stage gating.
 *
 * The relative gate is what stops a long quiet intro from dragging a
 * programme's integrated figure below what anyone actually hears.
 */
function gatedLoudness(blocks: number[][], weights: number[], relativeGateLu: number): number {
  if (blocks.length === 0) return -Infinity;

  const loudness = blocks.map((b) => blockLoudness(b, weights));

  const aboveAbsolute: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (loudness[i] > ABSOLUTE_GATE_LUFS) aboveAbsolute.push(i);
  }
  if (aboveAbsolute.length === 0) return -Infinity;

  const meanOf = (indices: number[]): number => {
    const channels = blocks[0].length;
    const sums = new Array<number>(channels).fill(0);
    for (const i of indices) {
      for (let c = 0; c < channels; c++) sums[c] += blocks[i][c];
    }
    for (let c = 0; c < channels; c++) sums[c] /= indices.length;
    return blockLoudness(sums, weights);
  };

  const threshold = meanOf(aboveAbsolute) + relativeGateLu;
  const surviving = aboveAbsolute.filter((i) => loudness[i] > threshold);
  if (surviving.length === 0) return -Infinity;
  return meanOf(surviving);
}

/** Percentile of a sorted array, linearly interpolated. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return -Infinity;
  if (sorted.length === 1) return sorted[0];
  const position = fraction * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

/**
 * Peak after 4x oversampling.
 *
 * A signal can sit under 0 dBFS at every sample and still exceed it between
 * them; that is what clips a downstream converter, so it is what gets reported.
 */
export function truePeakDbtp(channels: readonly Float32Array[]): number {
  let peak = 0;
  // Windowed-sinc half-band interpolation at 4x, evaluated on the fly.
  const taps = 33;
  const half = (taps - 1) / 2;
  const kernels = [1, 2, 3].map(phase => Float64Array.from({ length: taps }, (_, n) => {
    const x = n - half - phase / 4;
    return Math.sin(Math.PI * x) / (Math.PI * x) * (0.54 + 0.46 * Math.cos(Math.PI * x / (half + 1)));
  }));
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const direct = Math.abs(channel[i]);
      if (direct > peak) peak = direct;
      for (let phase = 1; phase < 4; phase++) {
        const kernel = kernels[phase - 1];
        let acc = 0;
        for (let k = -half; k <= half; k++) {
          const index = i + k;
          if (index < 0 || index >= channel.length) continue;
          acc += channel[index] * kernel[k + half];
        }
        const value = Math.abs(acc);
        if (value > peak) peak = value;
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export interface LoudnessOptions {
  /** True peak is expensive; skip it when only loudness is wanted. */
  skipTruePeak?: boolean;
}

export function measureLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: LoudnessOptions = {},
): LoudnessResult {
  if (channels.length === 0 || channels[0].length === 0) {
    return {
      integratedLufs: -Infinity,
      rangeLu: 0,
      maxMomentaryLufs: -Infinity,
      maxShortTermLufs: -Infinity,
      truePeakDbtp: -Infinity,
      samplePeakDbfs: -Infinity,
      shortTermLufs: new Float32Array(0),
    };
  }

  // Stereo and mono both weight every channel at 1.0; only surround adds gain.
  const weights = channels.map(() => 1);
  const weighted = channels.map((c) => kWeight(c, sampleRate));

  const momentaryBlocks = blockMeanSquares(weighted, sampleRate, 0.4, 0.1);
  const shortTermBlocks = blockMeanSquares(weighted, sampleRate, 3.0, 1.0);

  const integratedLufs = gatedLoudness(momentaryBlocks, weights, RELATIVE_GATE_LU);

  const momentaryValues = momentaryBlocks.map((b) => blockLoudness(b, weights));
  const shortTermValues = shortTermBlocks.map((b) => blockLoudness(b, weights));

  // LRA: percentile spread of short-term blocks, gated the same way.
  let rangeLu = 0;
  const stAboveAbsolute = shortTermValues.filter((v) => v > ABSOLUTE_GATE_LUFS);
  if (stAboveAbsolute.length > 1) {
    const gatingBlocks = shortTermBlocks.filter(
      (_, i) => shortTermValues[i] > ABSOLUTE_GATE_LUFS,
    );
    const channelCount = gatingBlocks[0].length;
    const sums = new Array<number>(channelCount).fill(0);
    for (const block of gatingBlocks) {
      for (let c = 0; c < channelCount; c++) sums[c] += block[c];
    }
    for (let c = 0; c < channelCount; c++) sums[c] /= gatingBlocks.length;
    const threshold = blockLoudness(sums, weights) + LRA_RELATIVE_GATE_LU;
    const surviving = stAboveAbsolute.filter((v) => v > threshold).sort((a, b) => a - b);
    if (surviving.length > 1) {
      rangeLu = percentile(surviving, 0.95) - percentile(surviving, 0.1);
    }
  }

  let samplePeak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i]);
      if (v > samplePeak) samplePeak = v;
    }
  }

  return {
    integratedLufs,
    rangeLu,
    maxMomentaryLufs: momentaryValues.length ? Math.max(...momentaryValues) : -Infinity,
    maxShortTermLufs: shortTermValues.length ? Math.max(...shortTermValues) : -Infinity,
    truePeakDbtp: options.skipTruePeak
      ? 20 * Math.log10(samplePeak || Number.MIN_VALUE)
      : truePeakDbtp(channels),
    samplePeakDbfs: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity,
    shortTermLufs: Float32Array.from(shortTermValues),
  };
}
