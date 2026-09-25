import { staleAnalyzers } from "../analysis/registry";
import { ANALYSIS_VERSION } from "../analysis/pipeline";
import type { StoredTrack } from "./library";

/** Review reasons remain visible even after acknowledgement. Thresholds are heuristic. */
export function reviewReasons(track: StoredTrack): string[] {
  if (track.analysisError) return [`Analysis failed: ${track.analysisError}`];
  const a = track.analysis;
  if (!a) return ["Not analysed"];
  const reasons: string[] = [];
  if ((track.analysisVersion ?? 0) < ANALYSIS_VERSION || !a.loudness || !a.energy || staleAnalyzers(a).length > 0) reasons.push("Analysis needs updating");
  if (!track.manualGrid && track.manualBpm === null && a.tempo.confidence < 0.7) reasons.push("Tempo confidence below 70%");
  if (!track.manualGrid && a.grid.gridConfidence < 0.7) reasons.push("Beat-grid confidence below 70%");
  if (track.manualKeyTonic === null) {
    if (a.key.confidence < 0.7) reasons.push("Key confidence below 70%");
    if (a.key.relativeAmbiguous) reasons.push("Relative major/minor is ambiguous");
  }
  return reasons;
}

export function needsReview(track: StoredTrack): boolean {
  return track.reviewedAt === null && reviewReasons(track).length > 0;
}
