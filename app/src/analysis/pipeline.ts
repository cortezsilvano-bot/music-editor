/**
 * The analysis pipeline (research Phase C orchestration).
 *
 * One decode feeds every stage. Two spectrograms are computed because the
 * stages want opposite trade-offs - onsets need time resolution, chroma needs
 * frequency resolution - and nothing else is recalculated per stage.
 *
 * Results carry a compatibility version plus per-analyzer provenance. The UI
 * detects stale stages and retains result history; reruns still use the full
 * pipeline rather than reusing intermediate feature caches.
 */
import { recordProvenance, type AnalysisProvenance } from "./registry";
import {
  buildGrid,
  estimateDownbeatPhase,
  trackBeats,
  type BeatGrid,
} from "../dsp/beats";
import { analyseStructure, type StructureResult } from "../dsp/structure";
import { estimatePhrases, type PhraseResult } from "../dsp/phrase";
import { medianFilterHpss, type HpssResult } from "../dsp/hpss";
import { computeVocalActivity, type VocalActivity } from "../dsp/vocal";
import { computeEnergy, type EnergyResult } from "../dsp/energy";
import { computeFingerprint } from "./fingerprint";
import {
  applyKeySupport,
  computeChroma,
  detectKey,
  KEY_STFT,
  scoreKeyFromChroma,
  type KeyResult,
} from "../dsp/key";
import { measureLoudness, type LoudnessResult } from "../dsp/loudness";
import { computeOnsetEnvelope } from "../dsp/onset";
import { ANALYSIS_SAMPLE_RATE, computeStft, resample, toMono } from "../dsp/spectral";
import { estimateTempo, type TempoEstimate } from "../dsp/tempo";

/**
 * Bump when a stage's algorithm changes in a way that alters results.
 * Stored analyses with a lower version are flagged for reanalysis; manual overrides are
 * never discarded, whatever the version.
 */
export const ANALYSIS_VERSION = 5;

export interface AnalysisInput {
  /** Decoded channels at the source sample rate. Never modified. */
  channels: readonly Float32Array[];
  sampleRate: number;
}

export interface TempoAnalysis {
  bpm: number;
  rawBpm: number;
  confidence: number;
  octaveConfidence: number;
  alternates: { bpm: number; strength: number }[];
}

export interface AnalysisResult {
  provenance?: AnalysisProvenance;
  analysisVersion: number;
  durationSec: number;
  tempo: TempoAnalysis;
  grid: BeatGrid;
  /** Mean absolute deviation of detected beats from the grid, seconds. */
  gridOffsetSec: number;
  tempoStability: number;
  key: KeyResult;
  loudness: LoudnessResult;
  energy: EnergyResult;
  /** 8/16/32-bar phrases on the analysis grid. Recompute from the effective grid in the UI. */
  phrases?: PhraseResult;
  /** Median-filter HPSS energies. Heuristic split, not stems. */
  hpss?: Pick<HpssResult, "harmonicEnergy" | "percussiveEnergy" | "percussiveRatio">;
  /** Bass-chroma key support. Does not override a manual key. */
  keySupport?: {
    bassTonic: number;
    bassMode: KeyResult["mode"];
    bassName: string;
    agreed: boolean;
    method: "median-hpss-bass-chroma";
  };
  /** Perceptual fingerprint for duplicate detection (Phase N). */
  fingerprint: Uint32Array;
  /** Share of the track carrying voice, 0..1. */
  vocalCoverage: number;
  /** Per-second vocal activity, for the overlay and for mix warnings. */
  vocalCurve: Float32Array;
  structure?: StructureResult;
  /** Wall-clock milliseconds each stage took, for the job manager. */
  timings: Record<string, number>;
}

export interface AnalysisProgress {
  stage: string;
  /** 0..1 */
  progress: number;
}

export type ProgressCallback = (progress: AnalysisProgress) => void;

/** Thrown when a caller cancels between stages. */
export class AnalysisCancelledError extends Error {
  constructor() {
    super("Analysis cancelled");
    this.name = "AnalysisCancelledError";
  }
}

export interface AnalyzeOptions {
  onProgress?: ProgressCallback;
  /** Checked between stages so long jobs stay responsive to cancellation. */
  signal?: { aborted: boolean };
}

/** Average a per-frame curve down to one value per second. */
function perSecond(values: Float32Array, frameRate: number): Float32Array {
  const seconds = Math.max(1, Math.floor(values.length / frameRate));
  const out = new Float32Array(seconds);
  for (let s = 0; s < seconds; s++) {
    const start = Math.floor(s * frameRate);
    const end = Math.min(values.length, Math.floor((s + 1) * frameRate));
    let acc = 0;
    for (let i = start; i < end; i++) acc += values[i];
    out[s] = end > start ? acc / (end - start) : 0;
  }
  return out;
}

export function analyze(input: AnalysisInput, options: AnalyzeOptions = {}): AnalysisResult {
  const { onProgress, signal } = options;
  const timings: Record<string, number> = {};

  const checkpoint = (stage: string, progress: number) => {
    if (signal?.aborted) throw new AnalysisCancelledError();
    onProgress?.({ stage, progress });
  };

  const time = <T>(stage: string, fn: () => T): T => {
    const started = performance.now();
    const value = fn();
    timings[stage] = performance.now() - started;
    return value;
  };

  checkpoint("preparing", 0);
  const durationSec = input.channels[0] ? input.channels[0].length / input.sampleRate : 0;

  // Analysis signal: mono at a fixed rate. The caller's audio is untouched.
  const mono = time("downmix", () => toMono(input.channels));
  const signalAtRate = time("resample", () =>
    resample(mono, input.sampleRate, ANALYSIS_SAMPLE_RATE),
  );

  checkpoint("onsets", 0.15);
  const onsetSpec = time("stft.onset", () => computeStft(signalAtRate, ANALYSIS_SAMPLE_RATE));
  const envelope = time("onset", () => computeOnsetEnvelope(onsetSpec));

  checkpoint("tempo", 0.4);
  const tempo: TempoEstimate = time("tempo", () => estimateTempo(envelope));

  checkpoint("beats", 0.55);
  const beats = time("beats", () => trackBeats(envelope, tempo.rawBpm));
  const downbeat = time("downbeat", () => estimateDownbeatPhase(envelope, beats, 4));
  const fitted = time("grid", () =>
    buildGrid(beats, tempo.rawBpm, downbeat.phase, 4, downbeat.confidence),
  );

  checkpoint("key", 0.7);
  const keySpec = time("stft.key", () =>
    computeStft(signalAtRate, ANALYSIS_SAMPLE_RATE, KEY_STFT),
  );
  const detectedKey = time("key", () => detectKey(keySpec));
  const hpss = time("hpss", () => medianFilterHpss(keySpec));
  const bassChroma = time("bassChroma", () =>
    computeChroma(hpss.harmonic, detectedKey.tuningCents, { minHz: 40, maxHz: 250 }),
  );
  const bassKey = time("bassKey", () => scoreKeyFromChroma(bassChroma, detectedKey.tuningCents));
  const key = time("keySupport", () => applyKeySupport(detectedKey, bassKey));
  const keySupport = {
    bassTonic: bassKey.tonic,
    bassMode: bassKey.mode,
    bassName: bassKey.name,
    agreed: detectedKey.tonic === bassKey.tonic && detectedKey.mode === bassKey.mode,
    method: "median-hpss-bass-chroma" as const,
  };

  checkpoint("loudness", 0.85);
  // Measure original channels; true-peak interpolation uses precomputed kernels.
  const loudness = time("loudness", () =>
    measureLoudness(input.channels, input.sampleRate),
  );

  checkpoint("energy", 0.93);
  const energy = time("energy", () =>
    computeEnergy(onsetSpec, envelope, loudness.integratedLufs, tempo.bpm, input.channels),
  );

  const vocals: VocalActivity = time("vocals", () => computeVocalActivity(onsetSpec));
  // Both curves are per-second so the section labeller can average either.
  const vocalCurve = time("vocalCurve", () => perSecond(vocals.values, vocals.frameRate));
  const structure = time("structure", () =>
    analyseStructure({ curve: energy.curve, grid: fitted.grid, durationSec, vocalCurve }),
  );
  const phrases = time("phrases", () => estimatePhrases(fitted.grid, durationSec, energy.curve));

  checkpoint("fingerprint", 0.97);
  // Reuses the onset spectrogram, so this costs a scan rather than a transform.
  const fingerprint = time("fingerprint", () => computeFingerprint(onsetSpec));

  checkpoint("done", 1);

  const result: AnalysisResult = {
    analysisVersion: ANALYSIS_VERSION,
    durationSec,
    tempo: {
      bpm: tempo.bpm,
      rawBpm: tempo.rawBpm,
      confidence: tempo.confidence,
      octaveConfidence: tempo.octaveConfidence,
      alternates: tempo.alternates,
    },
    grid: fitted.grid,
    gridOffsetSec: fitted.offsetSec,
    tempoStability: fitted.stability,
    key,
    loudness,
    energy,
    structure,
    phrases,
    hpss: {
      harmonicEnergy: hpss.harmonicEnergy,
      percussiveEnergy: hpss.percussiveEnergy,
      percussiveRatio: hpss.percussiveRatio,
    },
    keySupport,
    fingerprint,
    vocalCoverage: vocals.coverage,
    vocalCurve,
    timings,
  };
  result.provenance = recordProvenance(result);
  return result;
}
