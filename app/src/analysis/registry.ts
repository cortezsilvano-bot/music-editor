import type { AnalysisResult } from "./pipeline";
import { ANALYSIS_SAMPLE_RATE, DEFAULT_STFT } from "../dsp/spectral";
import { KEY_STFT } from "../dsp/key";
type Parameters = Record<string, string | number | boolean>;
export const ANALYZERS = {
  preprocessing: { version: "1.0.0", parameters: { sampleRate: ANALYSIS_SAMPLE_RATE, ...DEFAULT_STFT } },
  tempo: { version: "1.0.0", parameters: { method: "autocorrelation-harmonic-prior" } },
  grid: { version: "1.0.0", parameters: { method: "dynamic-programming", beatsPerBar: 4 } },
  key: { version: "1.1.0", parameters: { ...KEY_STFT, profiles: "krumhansl,temperley,electronic", bassChroma: "hpss-lowband" } },
  loudness: { version: "1.0.0", parameters: { sampleRate: "source", truePeakFactor: 4 } },
  energy: { version: "1.1.0", parameters: { curve: "per-second", weights: "fixed-v1", rawScore: true } },
  vocals: { version: "1.0.0", parameters: { method: "spectral-heuristic" } },
  structure: { version: "1.0.0", parameters: { method: "energy-vocal-bar-suggestions" } },
  phrase: { version: "1.0.0", parameters: { method: "effective-grid-8-16-32", heuristic: true } },
  hpss: { version: "1.0.0", parameters: { method: "median-filter", harmonicWidth: 17, percussiveWidth: 17 } },
  fingerprint: { version: "1.0.0", parameters: { method: "spectral-fingerprint" } },
} satisfies Record<string, { version: string; parameters: Parameters }>;
export type AnalyzerId = keyof typeof ANALYZERS;
export interface AnalyzerRun {
  id: AnalyzerId; version: string; paramsHash: string; parameters: Parameters;
  status: "completed"; completedAt: number; confidence: number | null;
}
export type AnalysisProvenance = Partial<Record<AnalyzerId, AnalyzerRun>>;

/** FNV-1a 64-bit identifier for config changes, not a content/security hash. */
export function parameterHash(parameters: Parameters): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))));
  let hash = 0xcbf29ce484222325n;
  for (const char of new TextEncoder().encode(canonical)) hash = BigInt.asUintN(64, (hash ^ BigInt(char)) * 0x100000001b3n);
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
const CURRENT = Object.entries(ANALYZERS).map(([id, descriptor]) => ({
  id: id as AnalyzerId, ...descriptor, paramsHash: parameterHash(descriptor.parameters),
}));

export function recordProvenance(result: AnalysisResult, completedAt = Date.now()): AnalysisProvenance {
  const confidence: Partial<Record<AnalyzerId, number>> = {
    tempo: result.tempo.confidence, grid: result.grid.gridConfidence, key: result.key.confidence, energy: result.energy.confidence,
    phrase: result.phrases?.confidence, hpss: result.hpss ? 1 - Math.abs(0.5 - result.hpss.percussiveRatio) : undefined,
  };
  return Object.fromEntries(CURRENT.map(descriptor => [descriptor.id, {
    ...descriptor, parameters: { ...descriptor.parameters }, status: "completed", completedAt,
    confidence: confidence[descriptor.id] ?? null,
  }])) as AnalysisProvenance;
}

/** Missing provenance means unverified legacy results; never fabricate metadata. */
export function staleAnalyzers(result: Pick<AnalysisResult, "provenance">): AnalyzerId[] {
  return CURRENT.filter(expected => {
    const previous = result.provenance?.[expected.id];
    return !previous || previous.version !== expected.version || previous.paramsHash !== expected.paramsHash;
  }).map(expected => expected.id);
}
