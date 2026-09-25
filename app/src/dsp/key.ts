/**
 * Musical key detection (research Phase E).
 *
 * Chroma built from the shared spectrogram with an explicit tuning estimate,
 * scored against several published key profiles. Essentia's KeyExtractor is
 * AGPL, so the algorithm is reimplemented here from the published description
 * rather than linked.
 *
 * Relative-major/minor confusion is the dominant real-world error, so it is
 * detected and reported rather than hidden behind a single confident answer.
 */
import { binFrequencies, frameAt, type Spectrogram, type StftOptions } from "./spectral";

/**
 * STFT settings for key analysis.
 *
 * Chroma needs frequency resolution, not time resolution: at the onset stage's
 * 1024-point window a bin spans 21 Hz, which is wider than a semitone below
 * middle C, so adjacent pitch classes are indistinguishable. A 4096-point
 * window costs time precision the key stage does not need.
 */
export const KEY_STFT: StftOptions = { fftSize: 4096, hopSize: 2048 };

export type Mode = "major" | "minor";

export const PITCH_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export interface KeyCandidate {
  tonic: number;
  mode: Mode;
  score: number;
}

export interface KeyResult {
  /** Pitch class 0..11, C = 0. */
  tonic: number;
  mode: Mode;
  /** e.g. "F# minor". */
  name: string;
  camelot: string;
  openKey: string;
  /** Deviation from A440 in cents. */
  tuningCents: number;
  /** 0..1. */
  confidence: number;
  /** True when the relative key scores almost as well. */
  relativeAmbiguous: boolean;
  alternates: KeyCandidate[];
  /** Normalised 12-bin chroma the decision was made from. */
  chroma: Float64Array;
}

/**
 * Key profiles. Krumhansl-Kessler is the classic probe-tone result; Temperley
 * is a later correction that performs better on popular music. The electronic
 * profile flattens the leading-tone weighting, which otherwise drags
 * riff-driven tracks towards their relative.
 */
const PROFILES: Record<string, { major: number[]; minor: number[] }> = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
    minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
  },
  electronic: {
    major: [7.0, 1.5, 3.0, 1.5, 4.5, 4.0, 1.8, 5.5, 1.8, 3.2, 2.0, 2.2],
    minor: [7.0, 1.8, 3.2, 5.5, 1.8, 3.6, 1.9, 5.2, 3.4, 2.0, 3.0, 2.2],
  },
};

/** Open Key number 1..12. C major is 1d, A minor is 1m. */
export function openKeyNumber(tonic: number, mode: Mode): number {
  const relativeMajor = mode === "minor" ? (tonic + 3) % 12 : tonic;
  return ((relativeMajor * 7) % 12) + 1;
}

export function openKeyLabel(tonic: number, mode: Mode): string {
  return `${openKeyNumber(tonic, mode)}${mode === "major" ? "d" : "m"}`;
}

/** Camelot code, e.g. "8B" for C major. */
export function camelotLabel(tonic: number, mode: Mode): string {
  const number = ((openKeyNumber(tonic, mode) + 6) % 12) + 1;
  return `${number}${mode === "major" ? "B" : "A"}`;
}

export function keyName(tonic: number, mode: Mode): string {
  return `${PITCH_NAMES[tonic]} ${mode}`;
}

/** Pitch class of the relative major or minor. */
export function relativeKey(tonic: number, mode: Mode): { tonic: number; mode: Mode } {
  return mode === "major"
    ? { tonic: (tonic + 9) % 12, mode: "minor" }
    : { tonic: (tonic + 3) % 12, mode: "major" };
}

/**
 * Estimate deviation from A440 by pooling how far spectral peaks sit from
 * equal temperament. Material recorded a quarter-tone sharp otherwise smears
 * chroma across neighbouring pitch classes and flips the mode.
 *
 * Two details matter and both were wrong in the obvious implementation:
 *
 * - Peak frequencies must be interpolated. At the analysis FFT size a bin is
 *   tens of Hz wide, so the raw bin centre quantises the estimate into noise
 *   far larger than the tuning offset being measured.
 * - Deviations are circular. +49 and -49 cents are neighbours, so they are
 *   averaged as unit vectors rather than binned on a line, where they would
 *   cancel to zero.
 */
export function estimateTuningCents(spec: Spectrogram, maxFrames = 600): number {
  const step = Math.max(1, Math.floor(spec.frameCount / maxFrames));
  const binToHz = spec.sampleRate / spec.fftSize;
  let sumX = 0;
  let sumY = 0;

  for (let f = 0; f < spec.frameCount; f += step) {
    const frame = frameAt(spec, f);
    for (let b = 1; b < spec.binCount - 1; b++) {
      const beta = frame[b];
      const alpha = frame[b - 1];
      const gamma = frame[b + 1];
      if (beta <= alpha || beta < gamma || beta <= 0) continue;

      // Parabolic interpolation over the three bins around the peak.
      const denom = alpha - 2 * beta + gamma;
      const offset = denom !== 0 ? (0.5 * (alpha - gamma)) / denom : 0;
      if (!Number.isFinite(offset) || Math.abs(offset) > 1) continue;
      const hz = (b + offset) * binToHz;
      // Below this the bins are too wide to interpolate reliably; above it
      // partials dominate and carry their own detuning.
      if (hz < 200 || hz > 3000) continue;

      const midi = 69 + 12 * Math.log2(hz / 440);
      const deviation = midi - Math.round(midi); // -0.5..0.5 semitones
      const angle = 2 * Math.PI * deviation;
      sumX += beta * Math.cos(angle);
      sumY += beta * Math.sin(angle);
    }
  }

  if (sumX === 0 && sumY === 0) return 0;
  return (Math.atan2(sumY, sumX) / (2 * Math.PI)) * 100;
}

/**
 * Harmonic pitch class profile.
 *
 * Each bin contributes to its own pitch class and, at reduced weight, to the
 * pitch classes its lower harmonics imply, which stops bass-heavy mixes from
 * scoring their root's overtones as independent evidence.
 */
export function computeChroma(
  spec: Spectrogram,
  tuningCents: number,
  options: { minHz?: number; maxHz?: number } = {},
): Float64Array {
  const minHz = options.minHz ?? 55;
  const maxHz = options.maxHz ?? 5000;
  const freqs = binFrequencies(spec);
  const reference = 440 * 2 ** (tuningCents / 1200);
  const chroma = new Float64Array(12);

  const harmonicWeights = [1, 0.5, 0.33, 0.25];

  for (let f = 0; f < spec.frameCount; f++) {
    const frame = frameAt(spec, f);
    for (let b = 1; b < spec.binCount; b++) {
      const magnitude = frame[b];
      if (magnitude <= 0) continue;
      const hz = freqs[b];
      if (hz < minHz || hz > maxHz) continue;
      for (let h = 0; h < harmonicWeights.length; h++) {
        const fundamental = hz / (h + 1);
        if (fundamental < minHz) break;
        const midi = 69 + 12 * Math.log2(fundamental / reference);
        const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
        // Log compression: one loud sustained note should not dominate.
        chroma[pitchClass] += Math.log1p(magnitude) * harmonicWeights[h];
      }
    }
  }

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total > 0) for (let i = 0; i < 12; i++) chroma[i] /= total;
  return chroma;
}

function correlate(chroma: Float64Array, profile: number[], rotation: number): number {
  let meanC = 0;
  let meanP = 0;
  for (let i = 0; i < 12; i++) {
    meanC += chroma[i];
    meanP += profile[i];
  }
  meanC /= 12;
  meanP /= 12;

  let num = 0;
  let denC = 0;
  let denP = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + rotation) % 12] - meanC;
    const p = profile[i] - meanP;
    num += c * p;
    denC += c * c;
    denP += p * p;
  }
  const den = Math.sqrt(denC * denP);
  return den > 0 ? num / den : 0;
}

export function scoreKeyFromChroma(chroma: Float64Array, tuningCents: number): KeyResult {
  // Average the profiles' verdicts rather than trusting any single one.
  const scores: KeyCandidate[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      let total = 0;
      let count = 0;
      for (const profile of Object.values(PROFILES)) {
        total += correlate(chroma, profile[mode], tonic);
        count++;
      }
      scores.push({ tonic, mode, score: total / count });
    }
  }
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  const runnerUp = scores[1];

  // Correlations live in [-1, 1]; map the winner's margin into a 0..1 figure.
  const margin = best.score - runnerUp.score;
  const confidence = clamp01(Math.max(0, best.score) * 0.6 + margin * 2);

  const relative = relativeKey(best.tonic, best.mode);
  const relativeScore =
    scores.find((s) => s.tonic === relative.tonic && s.mode === relative.mode)?.score ?? -1;
  const relativeAmbiguous = best.score - relativeScore < 0.05;

  return {
    tonic: best.tonic,
    mode: best.mode,
    name: keyName(best.tonic, best.mode),
    camelot: camelotLabel(best.tonic, best.mode),
    openKey: openKeyLabel(best.tonic, best.mode),
    tuningCents,
    confidence,
    relativeAmbiguous,
    alternates: scores.slice(1, 4),
    chroma,
  };
}

export function detectKey(spec: Spectrogram): KeyResult {
  const tuningCents = estimateTuningCents(spec);
  const chroma = computeChroma(spec, tuningCents);
  return scoreKeyFromChroma(chroma, tuningCents);
}

/**
 * Bass-chroma (or any second chroma) as a confidence aid.
 *
 * Never replaces the detected tonic/mode. Agreement lifts confidence slightly;
 * disagreement is recorded as an alternate and trims confidence. Manual key
 * overrides live on the track row and are not touched here.
 */
export function applyKeySupport(detected: KeyResult, support: KeyResult): KeyResult {
  const agreed = detected.tonic === support.tonic && detected.mode === support.mode;
  let confidence = detected.confidence;
  if (agreed) confidence = clamp01(confidence + 0.08);
  else if (detected.tonic === support.tonic) confidence = clamp01(confidence + 0.03);
  else confidence = clamp01(confidence * 0.9);

  const alternates = [...detected.alternates];
  if (!agreed && !alternates.some((a) => a.tonic === support.tonic && a.mode === support.mode)) {
    alternates.push({ tonic: support.tonic, mode: support.mode, score: support.confidence });
    alternates.sort((a, b) => b.score - a.score);
  }
  return { ...detected, confidence, alternates: alternates.slice(0, 4) };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
