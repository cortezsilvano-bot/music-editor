/**
 * Energy model (research Phase F, second half).
 *
 * Deliberately not a black box. Each contributing feature is stored raw, the
 * weights are a visible table, and the 1-10 level is a weighted sum of
 * normalised features. Two things follow from that: the UI can say *why* a
 * track scored 8, and the whole library can be renormalised later without
 * decoding a single file again.
 */
import type { OnsetEnvelope } from "./onset";
import { binFrequencies, frameAt, type Spectrogram } from "./spectral";

/** Raw, un-normalised measurements. Stored so scoring can change later. */
export interface EnergyFeatures {
  /** Integrated loudness, LUFS. */
  loudnessLufs: number;
  /** Share of spectral energy below 200 Hz, 0..1. */
  bassRatio: number;
  /** Mean onset strength in the kick band. */
  kickStrength: number;
  /** Detected onsets per second. */
  onsetDensity: number;
  /** Share of spectral energy above 4 kHz, 0..1. */
  highFrequencyActivity: number;
  /** Mean positive spectral flux. */
  spectralFlux: number;
  /** Percussive share from the harmonic/percussive split, 0..1. */
  percussiveRatio: number;
  /** Peak-to-RMS ratio in dB; low means heavily compressed, so loud. */
  crestFactorDb: number;
  /** Tempo in BPM, folded into the DJ range. */
  bpm: number;
}

export interface EnergyResult {
  /** 1..10. */
  level: number;
  /** 0..1, how much the contributing features agree. */
  confidence: number;
  features: EnergyFeatures;
  /** Per-second energy, 0..1, for the overlay curve. */
  curve: Float32Array;
  /** Ordered strongest-first, for "why is this an 8?". */
  contributions: { name: string; normalised: number; weight: number; points: number }[];
}

/**
 * Feature weights.
 *
 * Loudness and kick dominate because they are what makes a floor move; onset
 * density and highs separate a busy track from a sparse one at the same level.
 * These are engineering judgement, not fitted parameters - there is no labelled
 * dataset here - which is precisely why they are kept visible and the raw
 * features are retained.
 */
const WEIGHTS: Record<keyof NormalisedFeatures, number> = {
  loudness: 0.3,
  kick: 0.22,
  onsetDensity: 0.15,
  bass: 0.1,
  highs: 0.1,
  flux: 0.08,
  percussive: 0.05,
};

interface NormalisedFeatures {
  loudness: number;
  kick: number;
  onsetDensity: number;
  bass: number;
  highs: number;
  flux: number;
  percussive: number;
}

/** Map a value onto 0..1 with a soft floor and ceiling. */
function normalise(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return 0;
  if (high === low) return 0;
  const t = (value - low) / (high - low);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function computeEnergy(
  spec: Spectrogram,
  envelope: OnsetEnvelope,
  loudnessLufs: number,
  bpm: number,
  channels: readonly Float32Array[],
): EnergyResult {
  const freqs = binFrequencies(spec);

  // Spectral band shares, averaged over the track.
  let lowSum = 0;
  let highSum = 0;
  let totalSum = 0;
  let fluxSum = 0;
  let previous: Float32Array | null = null;

  for (let f = 0; f < spec.frameCount; f++) {
    const frame = frameAt(spec, f);
    for (let b = 1; b < spec.binCount; b++) {
      const magnitude = frame[b];
      totalSum += magnitude;
      if (freqs[b] < 200) lowSum += magnitude;
      else if (freqs[b] > 4000) highSum += magnitude;
    }
    if (previous) {
      for (let b = 1; b < spec.binCount; b++) {
        const diff = frame[b] - previous[b];
        if (diff > 0) fluxSum += diff;
      }
    }
    previous = frame;
  }

  const bassRatio = totalSum > 0 ? lowSum / totalSum : 0;
  const highFrequencyActivity = totalSum > 0 ? highSum / totalSum : 0;
  const spectralFlux = spec.frameCount > 1 ? fluxSum / (spec.frameCount - 1) : 0;

  // Onset density: peaks in the envelope, per second.
  const values = envelope.values;
  let peaks = 0;
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] > 0.15 && values[i] >= values[i - 1] && values[i] > values[i + 1]) peaks++;
  }
  const seconds = values.length / envelope.frameRate;
  const onsetDensity = seconds > 0 ? peaks / seconds : 0;

  // Kick strength from the low band of the shared filterbank.
  const kickBandCount = Math.max(
    1,
    envelope.bandFrequencies.findIndex((hz) => hz > 140),
  );
  let kickSum = 0;
  for (let f = 0; f < spec.frameCount; f++) {
    const offset = f * envelope.bandCount;
    let frameMax = 0;
    for (let b = 0; b < kickBandCount; b++) {
      const v = envelope.bands[offset + b];
      if (v > frameMax) frameMax = v;
    }
    kickSum += frameMax;
  }
  const kickStrength = spec.frameCount > 0 ? kickSum / spec.frameCount : 0;

  // Percussive share: how much of the flux is transient rather than sustained.
  const percussiveRatio = spectralFlux > 0 ? normalise(spectralFlux, 0, 40) : 0;

  // Crest factor from the original audio, not the analysis signal.
  let peak = 0;
  let squareSum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i]);
      if (v > peak) peak = v;
      squareSum += channel[i] * channel[i];
      count++;
    }
  }
  const rms = count > 0 ? Math.sqrt(squareSum / count) : 0;
  const crestFactorDb = rms > 0 && peak > 0 ? 20 * Math.log10(peak / rms) : 0;

  const features: EnergyFeatures = {
    loudnessLufs,
    bassRatio,
    kickStrength,
    onsetDensity,
    highFrequencyActivity,
    spectralFlux,
    percussiveRatio,
    crestFactorDb,
    bpm,
  };

  // Normalisation ranges chosen from typical released material: -30 LUFS is
  // very quiet, -6 is a loud master; 8 onsets a second is dense.
  const normalised: NormalisedFeatures = {
    loudness: normalise(loudnessLufs, -30, -6),
    kick: normalise(kickStrength, 0, 6),
    onsetDensity: normalise(onsetDensity, 0.5, 8),
    bass: normalise(bassRatio, 0.05, 0.45),
    highs: normalise(highFrequencyActivity, 0.02, 0.3),
    flux: normalise(spectralFlux, 0, 40),
    percussive: percussiveRatio,
  };

  let score = 0;
  const contributions: EnergyResult["contributions"] = [];
  for (const key of Object.keys(WEIGHTS) as (keyof NormalisedFeatures)[]) {
    const weight = WEIGHTS[key];
    const value = normalised[key];
    const points = value * weight;
    score += points;
    contributions.push({ name: key, normalised: value, weight, points });
  }
  contributions.sort((a, b) => b.points - a.points);

  const level = Math.max(1, Math.min(10, Math.round(1 + score * 9)));

  // Confidence: features pointing the same way is evidence; a track that is
  // loud but sparse, or busy but quiet, is genuinely ambiguous.
  const spread = Object.values(normalised);
  const mean = spread.reduce((a, b) => a + b, 0) / spread.length;
  const variance = spread.reduce((a, b) => a + (b - mean) ** 2, 0) / spread.length;
  const confidence = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) * 2));

  // Per-second curve from the short-window onset energy.
  const perSecond = Math.max(1, Math.round(envelope.frameRate));
  const curveLength = Math.max(1, Math.floor(values.length / perSecond));
  const curve = new Float32Array(curveLength);
  for (let i = 0; i < curveLength; i++) {
    let acc = 0;
    const start = i * perSecond;
    const end = Math.min(start + perSecond, values.length);
    for (let j = start; j < end; j++) acc += values[j];
    curve[i] = end > start ? acc / (end - start) : 0;
  }
  let curvePeak = 0;
  for (let i = 0; i < curve.length; i++) if (curve[i] > curvePeak) curvePeak = curve[i];
  if (curvePeak > 0) for (let i = 0; i < curve.length; i++) curve[i] /= curvePeak;

  return { level, confidence, features, curve, contributions };
}
