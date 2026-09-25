import type { TrackMetadata } from "./catalog";
import { gridBpm } from "../dsp/gridEdit";

export function effectiveBpm(track: TrackMetadata): number | null {
  if (track.manualGrid?.anchors.length) return gridBpm(track.manualGrid);
  if (track.manualBpm !== null) return track.manualBpm;
  return track.analysis?.tempo.bpm ?? null;
}

