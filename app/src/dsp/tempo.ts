/**
 * Tempo estimation (research Phase D).
 *
 * Autocorrelation tempogram over the onset envelope, with harmonic
 * accumulation so the true period is preferred over its half and double, and
 * an explicit octave decision afterwards because that is the error DJs
 * actually notice.
 */
import type { OnsetEnvelope } from "./onset";

export interface TempoOptions {
  minBpm: number;
  maxBpm: number;
  /** Centre of the log-normal tempo prior. */
  priorBpm: number;
  /** Spread of the prior, in octaves. Larger trusts the prior less. */
  priorWidth: number;
  /** Tempo range preferred when reporting the headline figure. */
  preferredMinBpm: number;
  preferredMaxBpm: number;
}

export const DEFAULT_TEMPO: TempoOptions = {
  minBpm: 50,
  maxBpm: 220,
  priorBpm: 124,
  priorWidth: 0.9,
  preferredMinBpm: 78,
  preferredMaxBpm: 165,
};

export interface TempoCandidate {
  bpm: number;
  strength: number;
}

export interface TempoEstimate {
  /** Headline BPM, folded into the preferred range. */
  bpm: number;
  /** Strongest raw peak before octave folding. */
  rawBpm: number;
  /** Overall confidence in the tempo, 0..1. */
  confidence: number;
  /** Confidence specifically that the octave (not the pulse) is right, 0..1. */
  octaveConfidence: number;
  /** Other plausible tempi, strongest first. */
  alternates: TempoCandidate[];
  /** Normalised tempogram, for display and debugging. */
  tempogram: Float32Array;
  /** BPM value of each tempogram index. */
  tempogramBpm: Float64Array;
}

/** Fold a tempo into [min, max) by repeated halving or doubling. */
export function foldTempo(bpm: number, min: number, max: number): number {
  let out = bpm;
  let guard = 0;
  while (out < min && guard++ < 8) out *= 2;
  guard = 0;
  while (out > max && guard++ < 8) out /= 2;
  return out;
}

export function estimateTempo(
  envelope: OnsetEnvelope,
  options: Partial<TempoOptions> = {},
): TempoEstimate {
  const opts = { ...DEFAULT_TEMPO, ...options };
  const env = envelope.values;
  const frameRate = envelope.frameRate;

  const minLag = Math.max(1, Math.floor((60 * frameRate) / opts.maxBpm));
  const maxLag = Math.min(env.length - 1, Math.ceil((60 * frameRate) / opts.minBpm));
  if (maxLag <= minLag) {
    return emptyEstimate(opts);
  }

  // Unbiased autocorrelation over the usable lag range.
  const lagCount = maxLag - minLag + 1;
  const auto = new Float32Array(lagCount);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    const limit = env.length - lag;
    for (let t = 0; t < limit; t++) acc += env[t] * env[t + lag];
    auto[lag - minLag] = limit > 0 ? acc / limit : 0;
  }

  const bpmOf = (index: number) => (60 * frameRate) / (index + minLag);
  const tempogramBpm = new Float64Array(lagCount);
  for (let i = 0; i < lagCount; i++) tempogramBpm[i] = bpmOf(i);

  // Harmonic accumulation: a real pulse also has energy at 2x and 3x its lag.
  // Without this, a track with strong eighth notes reports double tempo.
  const scored = new Float32Array(lagCount);
  for (let i = 0; i < lagCount; i++) {
    const lag = i + minLag;
    let score = auto[i];
    for (const [multiple, weight] of [
      [2, 0.5],
      [3, 0.25],
      [4, 0.125],
    ] as const) {
      const harmonicIndex = lag * multiple - minLag;
      if (harmonicIndex >= 0 && harmonicIndex < lagCount) {
        score += weight * auto[harmonicIndex];
      }
    }
    // Log-normal prior: musically implausible tempi need more evidence.
    const octaves = Math.log2(tempogramBpm[i] / opts.priorBpm);
    score *= Math.exp(-0.5 * (octaves / opts.priorWidth) ** 2);
    scored[i] = score;
  }

  let peak = 0;
  for (let i = 1; i < lagCount; i++) if (scored[i] > scored[peak]) peak = i;
  const peakValue = scored[peak];
  if (peakValue <= 0) return emptyEstimate(opts);

  const tempogram = new Float32Array(lagCount);
  for (let i = 0; i < lagCount; i++) tempogram[i] = scored[i] / peakValue;

  const rawBpm = refinePeak(scored, tempogramBpm, peak);
  const bpm = foldTempo(rawBpm, opts.preferredMinBpm, opts.preferredMaxBpm);

  const alternates = collectAlternates(tempogram, tempogramBpm, peak);

  // Confidence: how far the winner stands above the best unrelated rival.
  let rivalStrength = 0;
  for (const candidate of alternates) {
    if (!isHarmonicallyRelated(candidate.bpm, rawBpm)) {
      rivalStrength = Math.max(rivalStrength, candidate.strength);
      break;
    }
  }
  const confidence = clamp01(1 - rivalStrength);

  // Octave confidence compares the winner with its own half and double only.
  const halfStrength = strengthAtBpm(tempogram, tempogramBpm, rawBpm / 2);
  const doubleStrength = strengthAtBpm(tempogram, tempogramBpm, rawBpm * 2);
  const octaveRival = Math.max(halfStrength, doubleStrength);
  const octaveConfidence = clamp01(1 - octaveRival);

  return {
    bpm,
    rawBpm,
    confidence,
    octaveConfidence,
    alternates,
    tempogram,
    tempogramBpm,
  };
}

/** Parabolic interpolation around the peak for sub-bin tempo resolution. */
function refinePeak(scored: Float32Array, bpms: Float64Array, peak: number): number {
  if (peak <= 0 || peak >= scored.length - 1) return bpms[peak];
  const a = scored[peak - 1];
  const b = scored[peak];
  const c = scored[peak + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return bpms[peak];
  const shift = (0.5 * (a - c)) / denom;
  const lo = bpms[peak - 1];
  const hi = bpms[peak + 1];
  // Interpolate in BPM directly; the range is narrow enough for this to hold.
  return shift < 0 ? bpms[peak] + shift * (bpms[peak] - lo) : bpms[peak] + shift * (hi - bpms[peak]);
}

function collectAlternates(
  tempogram: Float32Array,
  bpms: Float64Array,
  peak: number,
): TempoCandidate[] {
  const found: TempoCandidate[] = [];
  for (let i = 1; i < tempogram.length - 1; i++) {
    if (i === peak) continue;
    if (tempogram[i] > tempogram[i - 1] && tempogram[i] >= tempogram[i + 1] && tempogram[i] > 0.2) {
      found.push({ bpm: bpms[i], strength: tempogram[i] });
    }
  }
  found.sort((x, y) => y.strength - x.strength);
  // Drop near-duplicates so the list is genuinely distinct options.
  const distinct: TempoCandidate[] = [];
  for (const candidate of found) {
    if (!distinct.some((d) => Math.abs(d.bpm - candidate.bpm) < 1.5)) distinct.push(candidate);
    if (distinct.length >= 4) break;
  }
  return distinct;
}

function strengthAtBpm(tempogram: Float32Array, bpms: Float64Array, bpm: number): number {
  let best = 0;
  for (let i = 0; i < bpms.length; i++) {
    if (Math.abs(bpms[i] - bpm) < 1.5) best = Math.max(best, tempogram[i]);
  }
  return best;
}

function isHarmonicallyRelated(a: number, b: number): boolean {
  for (const ratio of [0.5, 1, 2, 1 / 3, 3, 2 / 3, 1.5]) {
    if (Math.abs(a - b * ratio) < 2) return true;
  }
  return false;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function emptyEstimate(opts: TempoOptions): TempoEstimate {
  return {
    bpm: opts.priorBpm,
    rawBpm: opts.priorBpm,
    confidence: 0,
    octaveConfidence: 0,
    alternates: [],
    tempogram: new Float32Array(0),
    tempogramBpm: new Float64Array(0),
  };
}
