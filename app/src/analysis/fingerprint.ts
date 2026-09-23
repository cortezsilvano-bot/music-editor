/**
 * Duplicate detection (research Phase N).
 *
 * Three levels, because "the same track" means three different things:
 *
 * 1. **Exact file** - identical bytes. Already covered by `contentHash` at
 *    import; nothing here is needed.
 * 2. **Same audio, different container or tags** - a re-tagged MP3 or a WAV and
 *    FLAC of one master. The bytes differ, the decoded samples do not, so the
 *    hash is taken over quantised PCM rather than over the file.
 * 3. **Same recording, re-encoded** - a 320 kbps and a 128 kbps rip, or a
 *    different transfer. Samples differ everywhere, so this needs a perceptual
 *    fingerprint that survives lossy coding.
 *
 * The fingerprint is Chromaprint-shaped: per-frame chroma, turned into bits by
 * the *sign of a difference* rather than an absolute level, which is what makes
 * it survive gain changes and codec noise. Matching allows an offset, so a copy
 * with a longer silent lead-in still matches.
 */
import { frameAt, type Spectrogram } from "../dsp/spectral";
import { binFrequencies } from "../dsp/spectral";

/** Quantisation step for the PCM hash. Coarse enough to absorb dither. */
const PCM_QUANTISATION = 1 / 512;
/** Frames of chroma summarised into one 32-bit word. */
export const FINGERPRINT_BANDS = 12;

/**
 * Hash of the decoded audio rather than the file.
 *
 * This catches a re-tagged MP3 or the same master in a different container,
 * because those decode to identical samples even though their bytes differ.
 *
 * Quantisation only absorbs perturbations that do not straddle a step
 * boundary; it is not a tolerant comparison, and it cannot be made into one -
 * any exact hash flips on a boundary no matter how coarse the step. Anything
 * that genuinely alters the samples, such as a re-encode at a different
 * bitrate, is level 3's job and will not match here.
 *
 * The signal is downmixed and truncated to a fixed head so the cost does not
 * scale with track length.
 */
export async function computeAudioHash(
  mono: Float32Array,
  seconds = 60,
  sampleRate = 22050,
): Promise<string> {
  const count = Math.min(mono.length, Math.round(seconds * sampleRate));
  const quantised = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    quantised[i] = Math.round(mono[i] / PCM_QUANTISATION);
  }
  const digest = await crypto.subtle.digest("SHA-256", quantised.buffer);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/**
 * Perceptual fingerprint: one 32-bit word per frame.
 *
 * Each bit records whether a chroma band rose or fell relative to both the
 * previous frame and its neighbouring band. Encoding *changes* rather than
 * levels is what makes this robust to volume, EQ and codec artefacts.
 */
export function computeFingerprint(spec: Spectrogram, maxFrames = 2000): Uint32Array {
  const freqs = binFrequencies(spec);
  const step = Math.max(1, Math.floor(spec.frameCount / maxFrames));
  const frames: Float64Array[] = [];

  for (let f = 0; f < spec.frameCount; f += step) {
    const frame = frameAt(spec, f);
    const chroma = new Float64Array(FINGERPRINT_BANDS);
    for (let b = 1; b < spec.binCount; b++) {
      const hz = freqs[b];
      if (hz < 80 || hz > 4000) continue;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pitchClass] += frame[b];
    }
    // Normalise per frame so a loud passage does not dominate the bit pattern.
    let total = 0;
    for (let i = 0; i < FINGERPRINT_BANDS; i++) total += chroma[i];
    if (total > 0) for (let i = 0; i < FINGERPRINT_BANDS; i++) chroma[i] /= total;
    frames.push(chroma);
  }

  const words = new Uint32Array(Math.max(0, frames.length - 1));
  for (let f = 1; f < frames.length; f++) {
    const current = frames[f];
    const previous = frames[f - 1];
    let word = 0;
    for (let b = 0; b < FINGERPRINT_BANDS; b++) {
      const next = (b + 1) % FINGERPRINT_BANDS;
      // Bit A: did this band rise since the last frame?
      if (current[b] - previous[b] > 0) word |= 1 << (b * 2);
      // Bit B: is this band above its neighbour?
      if (current[b] - current[next] > 0) word |= 1 << (b * 2 + 1);
    }
    words[f - 1] = word >>> 0;
  }
  return words;
}

function popcount(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Fraction of bits that agree at a fixed offset. */
function agreementAt(a: Uint32Array, b: Uint32Array, offset: number): number {
  const start = Math.max(0, offset);
  const end = Math.min(a.length, b.length + offset);
  const overlap = end - start;
  // Too little overlap to be evidence of anything.
  if (overlap < 40) return 0;

  let differing = 0;
  for (let i = start; i < end; i++) {
    differing += popcount((a[i] ^ b[i - offset]) >>> 0);
  }
  const bits = overlap * 24; // 12 bands x 2 bits
  return 1 - differing / bits;
}

/**
 * Best agreement between two fingerprints, allowing one to start later.
 *
 * Returns 0..1. Independent tracks land near 0.5, because half the bits agree
 * by chance; a genuine match sits far above that.
 */
export function fingerprintSimilarity(
  a: Uint32Array,
  b: Uint32Array,
  maxOffsetFrames = 200,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  for (let offset = -maxOffsetFrames; offset <= maxOffsetFrames; offset += 2) {
    const score = agreementAt(a, b, offset);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Similarity above which two tracks are proposed as the same recording.
 *
 * Chance agreement is 0.5, so this is a long way above noise. It is a proposal
 * threshold, not a verdict: nothing is ever deleted automatically.
 */
export const DUPLICATE_THRESHOLD = 0.75;

export type DuplicateLevel = "exact-file" | "same-audio" | "similar-audio";

export interface DuplicateCandidate {
  id: string;
  level: DuplicateLevel;
  /** 0..1. Exact and same-audio matches are certain, so 1. */
  confidence: number;
}

export interface DuplicateGroup {
  level: DuplicateLevel;
  members: DuplicateCandidate[];
}

export interface DuplicateInput {
  id: string;
  contentHash?: string;
  audioHash?: string;
  fingerprint?: Uint32Array;
}

/**
 * Group tracks that appear to be the same recording.
 *
 * Each track lands in at most one group, and the strongest level wins, so a
 * byte-identical pair is never also reported as merely "similar".
 */
export function findDuplicateGroups(
  tracks: readonly DuplicateInput[],
  threshold = DUPLICATE_THRESHOLD,
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const claimed = new Set<string>();

  const byKey = (key: keyof DuplicateInput, level: DuplicateLevel) => {
    const buckets = new Map<string, DuplicateInput[]>();
    for (const track of tracks) {
      if (claimed.has(track.id)) continue;
      const value = track[key];
      if (typeof value !== "string" || value.length === 0) continue;
      const list = buckets.get(value) ?? [];
      list.push(track);
      buckets.set(value, list);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      for (const track of list) claimed.add(track.id);
      groups.push({
        level,
        members: list.map((t) => ({ id: t.id, level, confidence: 1 })),
      });
    }
  };

  byKey("contentHash", "exact-file");
  byKey("audioHash", "same-audio");

  // Remaining tracks: pairwise fingerprint comparison.
  const remaining = tracks.filter((t) => !claimed.has(t.id) && t.fingerprint?.length);
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i];
    if (claimed.has(a.id)) continue;
    const members: DuplicateCandidate[] = [];
    for (let j = i + 1; j < remaining.length; j++) {
      const b = remaining[j];
      if (claimed.has(b.id)) continue;
      const score = fingerprintSimilarity(a.fingerprint!, b.fingerprint!);
      if (score >= threshold) {
        members.push({ id: b.id, level: "similar-audio", confidence: score });
      }
    }
    if (members.length > 0) {
      claimed.add(a.id);
      for (const m of members) claimed.add(m.id);
      groups.push({
        level: "similar-audio",
        members: [{ id: a.id, level: "similar-audio", confidence: 1 }, ...members],
      });
    }
  }

  return groups;
}

export interface QualityFacts {
  id: string;
  bitrateKbps: number | null;
  sampleRate: number | null;
  sizeBytes: number;
  lossless: boolean | null;
  hasAnalysis: boolean;
  manualEdits: number;
}

/**
 * Rank copies so the review UI can suggest which to keep.
 *
 * Lossless beats lossy, then bitrate, then sample rate, then file size. Manual
 * edits break ties last but decisively: re-doing someone's grid corrections is
 * more expensive than a few kbps.
 */
export function rankCopies(facts: readonly QualityFacts[]): QualityFacts[] {
  return [...facts].sort((a, b) => {
    if (a.manualEdits !== b.manualEdits) return b.manualEdits - a.manualEdits;
    if (a.lossless !== b.lossless) return (b.lossless ? 1 : 0) - (a.lossless ? 1 : 0);
    const bitrate = (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    if (bitrate !== 0) return bitrate;
    const rate = (b.sampleRate ?? 0) - (a.sampleRate ?? 0);
    if (rate !== 0) return rate;
    return b.sizeBytes - a.sizeBytes;
  });
}

/** The hand-made work on a track, which is what a merge is trying to save. */
export interface MergeableEdits {
  manualBpm: number | null;
  manualKeyTonic: number | null;
  manualKeyMode: "major" | "minor" | null;
  manualGrid: unknown | null;
  cues: { id: string; name: string; timeSec: number }[];
  reviewedAt: number | null;
}

export interface MergePlan {
  /** Fields the keeper does not have that the donor does. */
  fields: string[];
  /** Cues present on the donor and not already on the keeper. */
  cues: { id: string; name: string; timeSec: number }[];
  result: MergeableEdits;
}

/**
 * Work out what the keeper would gain from the donor.
 *
 * The keeper always wins a conflict: a merge is meant to rescue work that would
 * otherwise be lost, not to silently overwrite a decision already made on the
 * copy being kept. Cues are matched by time rather than id, because the same
 * cue set imported twice has different ids.
 */
export function planMerge(
  keeper: MergeableEdits,
  donor: MergeableEdits,
  cueToleranceSec = 0.05,
): MergePlan {
  const fields: string[] = [];
  const result: MergeableEdits = { ...keeper, cues: [...keeper.cues] };

  if (keeper.manualBpm === null && donor.manualBpm !== null) {
    result.manualBpm = donor.manualBpm;
    fields.push("manual BPM");
  }
  if (keeper.manualKeyTonic === null && donor.manualKeyTonic !== null) {
    result.manualKeyTonic = donor.manualKeyTonic;
    result.manualKeyMode = donor.manualKeyMode;
    fields.push("manual key");
  }
  if (!keeper.manualGrid && donor.manualGrid) {
    result.manualGrid = donor.manualGrid;
    fields.push("manual grid");
  }
  if (keeper.reviewedAt === null && donor.reviewedAt !== null) {
    result.reviewedAt = donor.reviewedAt;
    fields.push("reviewed mark");
  }

  const added: MergePlan["cues"] = [];
  for (const cue of donor.cues) {
    const clash = result.cues.some((c) => Math.abs(c.timeSec - cue.timeSec) <= cueToleranceSec);
    if (!clash) added.push(cue);
  }
  if (added.length > 0) {
    result.cues = [...result.cues, ...added].sort((a, b) => a.timeSec - b.timeSec);
  }

  return { fields, cues: added, result };
}
