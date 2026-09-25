import type { TrackMetadata } from "../db/catalog";
/**
 * Transition recommendations (research Phase L).
 *
 * A transparent weighted score over things that can be measured, not a learned
 * model. The brief is explicit that a small local library does not justify an
 * opaque one, and an explainable score is worth more here anyway: a DJ can
 * disagree with a reason, but not with a number.
 *
 * Every component returns 0..1 and carries a sentence explaining itself. The
 * weights are visible and adjustable, and feedback is recorded so they can be
 * revisited against real choices later.
 */
import { effectiveBpm, effectiveKey } from "../db/library";
import { camelotLabel } from "../dsp/key";

export interface Reason {
  factor: string;
  /** 0..1 */
  score: number;
  weight: number;
  text: string;
}

export interface Recommendation {
  track: TrackMetadata;
  /** 0..100. */
  score: number;
  reasons: Reason[];
  /** Reasons that actively count against this transition. */
  warnings: string[];
}

/**
 * Component weights.
 *
 * Tempo and key dominate because a clash in either is immediately audible.
 * Vocal conflict is a penalty rather than a bonus, so it is applied after.
 */
export const WEIGHTS = {
  tempo: 0.34,
  harmonic: 0.3,
  energy: 0.16,
  section: 0.12,
  vocal: 0.08,
} as const;

/** Ratio tolerance before a tempo match stops being comfortable. */
const TEMPO_TOLERANCE = 0.06;

/** Distance in Camelot steps, accounting for the wheel wrapping at 12. */
function wheelDistance(a: string, b: string): number {
  const numberA = Number.parseInt(a, 10);
  const numberB = Number.parseInt(b, 10);
  const raw = Math.abs(numberA - numberB);
  return Math.min(raw, 12 - raw);
}

/**
 * Harmonic compatibility on the Camelot wheel.
 *
 * Same key is perfect; one step round the wheel or the relative major/minor are
 * the standard safe moves; everything else is a contrast, not a match.
 */
export function harmonicScore(from: string, to: string): { score: number; text: string } {
  if (from === to) return { score: 1, text: `Same key (${to})` };
  const sameLetter = from.slice(-1) === to.slice(-1);
  const distance = wheelDistance(from, to);

  if (!sameLetter && distance === 0) {
    return { score: 0.85, text: `Relative major/minor (${from} to ${to})` };
  }
  if (sameLetter && distance === 1) {
    return { score: 0.8, text: `One step on the wheel (${from} to ${to})` };
  }
  if (sameLetter && distance === 2) {
    return { score: 0.45, text: `Two steps on the wheel (${from} to ${to})` };
  }
  return { score: 0.1, text: `Key contrast (${from} to ${to})` };
}

/**
 * Tempo compatibility, allowing half and double time.
 *
 * The comparison is on the log ratio so speeding up 6% and slowing 6% score the
 * same, which they do not on a plain difference.
 */
export function tempoScore(fromBpm: number, toBpm: number): { score: number; text: string } {
  const ratios = [1, 2, 0.5];
  let best = Infinity;
  let bestRatio = 1;
  for (const ratio of ratios) {
    const distance = Math.abs(Math.log2(toBpm / (fromBpm * ratio)));
    if (distance < best) {
      best = distance;
      bestRatio = ratio;
    }
  }
  const score = Math.max(0, 1 - best / TEMPO_TOLERANCE);
  const percent = ((2 ** best - 1) * 100).toFixed(1);
  const note = bestRatio === 1 ? "" : bestRatio === 2 ? " at double time" : " at half time";
  return {
    score,
    text: `${toBpm.toFixed(1)} BPM, ${percent}% away${note}`,
  };
}

/** Energy flow: a small lift is ideal, a big drop is not. */
export function energyScore(from: number, to: number): { score: number; text: string } {
  const delta = to - from;
  // +1 is the sweet spot for building a set; -3 kills a floor.
  const score = Math.max(0, 1 - Math.abs(delta - 1) / 4);
  const direction = delta > 0 ? `up ${delta}` : delta < 0 ? `down ${-delta}` : "level";
  return { score, text: `Energy ${to}/10 (${direction})` };
}

/**
 * Vocal conflict.
 *
 * Two vocal tracks overlapping is the most common avoidable mistake in a
 * transition, so heavy vocals on both sides scores badly even when tempo and
 * key agree.
 */
export function vocalScore(from: number, to: number): { score: number; text: string } {
  const conflict = from * to;
  const score = Math.max(0, 1 - conflict * 1.6);
  if (conflict > 0.45) {
    return { score, text: `Both tracks are vocal-heavy (${Math.round(conflict * 100)}% overlap)` };
  }
  if (to < 0.2) return { score, text: "Incoming track is largely instrumental" };
  return { score, text: `Vocal overlap is manageable` };
}

/** Does the incoming track open in a way that suits mixing in? */
export function sectionScore(track: TrackMetadata): { score: number; text: string } {
  const sections = track.analysis?.structure?.sections;
  if (!sections || sections.length === 0) {
    return { score: 0.5, text: "No structure analysed" };
  }
  const first = sections[0];
  switch (first.label) {
    case "Intro":
      return { score: 1, text: `Opens with an ${first.label.toLowerCase()}` };
    case "Instrumental":
    case "Sparse":
      return { score: 0.85, text: `Opens ${first.label.toLowerCase()}` };
    case "Build":
      return { score: 0.6, text: "Opens on a build" };
    case "Drop":
      return { score: 0.25, text: "Opens straight into a drop" };
    default:
      return { score: 0.5, text: `Opens on ${first.label.toLowerCase()}` };
  }
}

export interface RecommendOptions {
  /** Ids played recently; repeats are pushed down. */
  recentIds?: readonly string[];
  /** Penalty applied when the artist matches the source track. */
  artistRepeatPenalty?: number;
  limit?: number;
}

export function recommend(
  source: TrackMetadata,
  candidates: readonly TrackMetadata[],
  options: RecommendOptions = {},
): Recommendation[] {
  const bpm = effectiveBpm(source);
  const key = effectiveKey(source);
  if (!bpm || !key) return [];

  const fromWheel = camelotLabel(key.tonic, key.mode);
  const fromEnergy = source.analysis?.energy?.level ?? 5;
  const fromVocal = source.analysis?.vocalCoverage ?? 0.4;
  const recent = new Set(options.recentIds ?? []);
  const artistPenalty = options.artistRepeatPenalty ?? 0.12;

  const results: Recommendation[] = [];

  for (const track of candidates) {
    if (track.id === source.id) continue;
    const targetBpm = effectiveBpm(track);
    const targetKey = effectiveKey(track);
    if (!track.analysis || !targetBpm || !targetKey) continue;

    const toWheel = camelotLabel(targetKey.tonic, targetKey.mode);
    const tempo = tempoScore(bpm, targetBpm);
    const harmonic = harmonicScore(fromWheel, toWheel);
    const energy = energyScore(fromEnergy, track.analysis.energy?.level ?? 5);
    const section = sectionScore(track);
    const vocal = vocalScore(fromVocal, track.analysis.vocalCoverage ?? 0.4);

    const reasons: Reason[] = [
      { factor: "tempo", score: tempo.score, weight: WEIGHTS.tempo, text: tempo.text },
      { factor: "key", score: harmonic.score, weight: WEIGHTS.harmonic, text: harmonic.text },
      { factor: "energy", score: energy.score, weight: WEIGHTS.energy, text: energy.text },
      { factor: "section", score: section.score, weight: WEIGHTS.section, text: section.text },
      { factor: "vocals", score: vocal.score, weight: WEIGHTS.vocal, text: vocal.text },
    ];

    let total = reasons.reduce((sum, r) => sum + r.score * r.weight, 0);

    const warnings: string[] = [];
    if (tempo.score < 0.3) warnings.push("Tempo needs more than a comfortable pitch shift");
    if (harmonic.score < 0.3) warnings.push("Keys clash");
    if (vocal.score < 0.4) warnings.push("Vocals will overlap");

    // Repetition penalties: correct choices, played too often, stop being good.
    const sameArtist =
      source.tags.artist !== null && track.tags.artist === source.tags.artist;
    if (sameArtist) {
      total -= artistPenalty;
      warnings.push(`Same artist as the current track`);
    }
    if (recent.has(track.id)) {
      total -= 0.25;
      warnings.push("Played recently");
    }

    results.push({
      track,
      score: Math.round(Math.max(0, Math.min(1, total)) * 100),
      reasons: [...reasons].sort((a, b) => b.score * b.weight - a.score * a.weight),
      warnings,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.track.name.localeCompare(b.track.name))
    .slice(0, options.limit ?? 8);
}
