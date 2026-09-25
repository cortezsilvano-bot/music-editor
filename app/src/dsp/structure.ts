/**
 * Structure and section labelling (research Phase H).
 *
 * Boundaries come from energy change on bar lines. Labels are then assigned by
 * rules over per-section features: energy relative to the track, vocal
 * activity, percussive share, and position.
 *
 * This is rule-based, not learned. It reliably finds *where* a track changes,
 * and names sections in the vocabulary a DJ uses, but it has no concept of song
 * form: it cannot tell a second verse from a first, and a "Drop" is simply the
 * loudest percussive section. Labels carry a confidence and are meant to be
 * edited, not trusted blindly.
 */
import { deriveBeatTimes, type BeatGrid } from "./beats";

export interface BarEnergy {
  startSec: number;
  endSec: number;
  energy: number;
}

export interface TrackSection {
  startSec: number;
  endSec: number;
  label: SectionLabel;
  confidence: number;
  /** The features the label was chosen from, so the UI can explain it. */
  features: SectionFeatures;
}

export interface SectionFeatures {
  /** Mean energy, 0..1 relative to the loudest section. */
  energy: number;
  /** Mean vocal activity, 0..1. */
  vocal: number;
  /** Energy of the following section minus this one. */
  energyDelta: number;
  /** 0 at the start of the track, 1 at the end. */
  position: number;
  durationSec: number;
}

export type SectionLabel =
  | "Intro"
  | "Verse"
  | "Build"
  | "Drop"
  | "Breakdown"
  | "Bridge"
  | "Outro"
  | "Instrumental"
  | "Vocal"
  | "Sparse";

export interface StructureResult {
  bars: BarEnergy[];
  sections: TrackSection[];
}

export interface StructureInput {
  /** Per-second energy curve, 0..1, from the energy stage. */
  curve: Float32Array;
  grid: BeatGrid;
  durationSec: number;
  /** Per-second vocal activity, 0..1. Optional; labels degrade without it. */
  vocalCurve?: Float32Array;
}

/** Bar starts, taken from the grid so sections land on musical boundaries. */
export function barStarts(grid: BeatGrid, durationSec: number): number[] {
  const beats = deriveBeatTimes(grid, durationSec);
  const first = Array.from(beats).findIndex((t) => t >= grid.firstDownbeatSec - 1e-6);
  const starts = [0];
  if (first >= 0) {
    for (let i = first; i < beats.length; i += grid.beatsPerBar) {
      if (beats[i] > 0 && beats[i] < durationSec) starts.push(beats[i]);
    }
  }
  return starts;
}

/** Mean of a per-second curve across a time range. */
function meanOverRange(curve: Float32Array, startSec: number, endSec: number): number {
  let sum = 0;
  let weight = 0;
  for (let s = Math.floor(startSec); s < Math.ceil(endSec); s++) {
    const overlap = Math.max(0, Math.min(endSec, s + 1) - Math.max(startSec, s));
    sum += (curve[s] ?? 0) * overlap;
    weight += overlap;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * Choose a label from a section's features.
 *
 * Order matters: the track's own ends are named first, then the strong
 * structural cues, and the descriptive fallbacks only run when nothing more
 * specific fits.
 */
function labelFor(
  features: SectionFeatures,
  isFirst: boolean,
  isLast: boolean,
  sectionCount: number,
): { label: SectionLabel; confidence: number } {
  const { energy, vocal, energyDelta, position } = features;

  // Energy is relative to the loudest section, so a track with no detected
  // changes is its own peak by definition. Calling that a "Drop" would be an
  // artefact of the normalisation rather than a finding, so a single section is
  // described by its content instead.
  if (sectionCount === 1) {
    if (vocal > 0.55) return { label: "Vocal", confidence: 0.45 };
    if (vocal < 0.25) return { label: "Instrumental", confidence: 0.45 };
    return { label: "Verse", confidence: 0.3 };
  }

  if (isFirst && energy < 0.6) {
    return { label: "Intro", confidence: 0.7 + (1 - energy) * 0.2 };
  }
  if (isLast && energy < 0.7) {
    return { label: "Outro", confidence: 0.65 + (1 - energy) * 0.2 };
  }
  // A build is defined by where it goes, not by its own level.
  if (energyDelta > 0.22 && energy < 0.8) {
    return { label: "Build", confidence: Math.min(0.85, 0.5 + energyDelta) };
  }
  if (energy > 0.78) {
    return { label: "Drop", confidence: Math.min(0.9, 0.45 + energy * 0.5) };
  }
  if (energy < 0.3) {
    return {
      label: vocal > 0.45 ? "Breakdown" : "Sparse",
      confidence: 0.55 + (0.3 - energy),
    };
  }
  if (energy < 0.55 && energyDelta > -0.1 && position > 0.3 && position < 0.8) {
    return { label: "Breakdown", confidence: 0.55 };
  }
  if (vocal > 0.55) {
    return { label: "Verse", confidence: 0.5 + vocal * 0.3 };
  }
  if (vocal < 0.25) {
    return { label: "Instrumental", confidence: 0.5 + (0.25 - vocal) };
  }
  // Mid-track, mid-energy, neither clearly sung nor clearly instrumental.
  return { label: position > 0.55 ? "Bridge" : "Vocal", confidence: 0.4 };
}

export function barsFromGrid(curve: Float32Array, grid: BeatGrid, durationSec: number): BarEnergy[] {
  const starts = barStarts(grid, durationSec);
  return starts.map((startSec, i) => ({
    startSec,
    endSec: starts[i + 1] ?? durationSec,
    energy: meanOverRange(curve, startSec, starts[i + 1] ?? durationSec),
  }));
}

export function analyseStructure(input: StructureInput): StructureResult {
  const { curve, grid, durationSec, vocalCurve } = input;
  const bars = barsFromGrid(curve, grid, durationSec);

  // Boundaries where a four-bar window's mean energy shifts, spaced at least
  // eight bars apart so a busy track does not fragment into noise.
  const boundaries = [0];
  for (let i = 4; i + 4 <= bars.length; i++) {
    if (i - boundaries[boundaries.length - 1] < 8) continue;
    const mean = (start: number) =>
      bars.slice(start, start + 4).reduce((sum, b) => sum + b.energy, 0) / 4;
    if (Math.abs(mean(i) - mean(i - 4)) >= 0.25) boundaries.push(i);
  }

  const ranges = boundaries.map((index, i) => ({
    startSec: bars[index]?.startSec ?? 0,
    endSec: bars[boundaries[i + 1]]?.startSec ?? durationSec,
  }));

  const energies = ranges.map((r) => meanOverRange(curve, r.startSec, r.endSec));
  const peak = Math.max(...energies, 1e-9);

  return {
    bars,
    sections: ranges.map((range, i) => {
      const energy = energies[i] / peak;
      const next = i + 1 < energies.length ? energies[i + 1] / peak : energy;
      const features: SectionFeatures = {
        energy,
        vocal: vocalCurve ? meanOverRange(vocalCurve, range.startSec, range.endSec) : 0.35,
        energyDelta: next - energy,
        position: durationSec > 0 ? range.startSec / durationSec : 0,
        durationSec: range.endSec - range.startSec,
      };
      const { label, confidence } = labelFor(
        features,
        i === 0,
        i === ranges.length - 1,
        ranges.length,
      );
      return { ...range, label, confidence: Math.min(1, confidence), features };
    }),
  };
}
