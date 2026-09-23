/**
 * Tag write planning (research Phase G).
 *
 * Deciding *what* to write is separated from actually writing it, so the rules
 * that matter - never write analysis without permission, never write a value
 * the analysis does not believe - are pure functions with tests rather than
 * conditions buried in an IPC handler.
 *
 * The brief's threshold policy is applied here:
 *   below ~0.70 confidence  -> flagged, needs verification, off by default
 *   below ~0.50 confidence  -> blocked unless explicitly overridden
 * A manual override has no confidence and is never blocked: the user asserted
 * it, so it is the most trustworthy value there is.
 */
import type { StoredTrack } from "../db/library";
import { camelotLabel, keyName, type Mode } from "../dsp/key";
import { effectiveBpm, effectiveKey } from "../db/library";

/** Confidence at or above this is written without comment. */
export const VERIFY_THRESHOLD = 0.7;
/** Below this, writing is refused unless the user overrides. */
export const BLOCK_THRESHOLD = 0.5;

export type TagField = "bpm" | "key" | "camelot" | "comment";

export interface TagChange {
  field: TagField;
  label: string;
  /** What the file says now, or null if the frame is absent. */
  current: string | null;
  /** What we would write. */
  proposed: string;
  /** Underlying analysis confidence, or null when the value is a manual override. */
  confidence: number | null;
  source: "automatic" | "manual";
  /** Set when policy refuses this change; the UI must not offer it unticked. */
  blocked: string | null;
  /** Set when the change is allowed but questionable. */
  warning: string | null;
  /** Default tick state. Low-confidence values default to off. */
  selected: boolean;
}

export interface WritePlan {
  trackId: string;
  filename: string;
  /** False when the container has no writer; nothing is attempted. */
  supported: boolean;
  unsupportedReason: string | null;
  changes: TagChange[];
}

export interface WritePlanOptions {
  /** Write the key as a Camelot code in addition to the classic notation. */
  includeCamelot?: boolean;
  /** Append an analysis summary to the comment frame. */
  includeComment?: boolean;
  /** Write values below BLOCK_THRESHOLD anyway. The user must ask for this. */
  overrideLowConfidence?: boolean;
}

/** MP3 (ID3v2) and FLAC (Vorbis comments) have writers; nothing else does. */
export function writerFor(filename: string): { supported: boolean; reason: string | null } {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (extension === "mp3" || extension === "flac") return { supported: true, reason: null };
  return {
    supported: false,
    reason: `No tag writer for .${extension} files. MP3 (ID3v2) and FLAC (Vorbis comments) are supported; other containers would need their own writer.`,
  };
}

function classify(
  confidence: number | null,
  source: "automatic" | "manual",
  override: boolean,
): { blocked: string | null; warning: string | null; selected: boolean } {
  // A manual value carries the user's own judgement; policy does not second-guess it.
  if (source === "manual" || confidence === null) {
    return { blocked: null, warning: null, selected: true };
  }
  if (confidence < BLOCK_THRESHOLD && !override) {
    return {
      blocked: `Confidence ${(confidence * 100).toFixed(0)}% is below the ${(BLOCK_THRESHOLD * 100).toFixed(0)}% floor for writing tags`,
      warning: null,
      selected: false,
    };
  }
  if (confidence < VERIFY_THRESHOLD) {
    return {
      blocked: null,
      warning: `Confidence ${(confidence * 100).toFixed(0)}% - verify before writing`,
      selected: false,
    };
  }
  return { blocked: null, warning: null, selected: true };
}

function formatBpm(bpm: number): string {
  // ID3 TBPM is conventionally an integer; DJ software rounds anyway.
  return Math.round(bpm).toString();
}

export function buildWritePlan(
  track: StoredTrack,
  options: WritePlanOptions = {},
): WritePlan {
  const { supported, reason } = writerFor(track.name);
  const changes: TagChange[] = [];

  if (!supported) {
    return {
      trackId: track.id,
      filename: track.name,
      supported: false,
      unsupportedReason: reason,
      changes,
    };
  }

  const bpm = effectiveBpm(track);
  const key = effectiveKey(track);
  const analysis = track.analysis;

  if (bpm !== null) {
    const isManual = track.manualBpm !== null;
    const confidence = isManual ? null : (analysis?.tempo.confidence ?? null);
    const source = isManual ? "manual" : "automatic";
    const proposed = formatBpm(bpm);
    const state = classify(confidence, source, options.overrideLowConfidence ?? false);
    // Nothing to do if the file already says this.
    if (track.tags.taggedBpm === null || formatBpm(track.tags.taggedBpm) !== proposed) {
      changes.push({
        field: "bpm",
        label: "BPM",
        current: track.tags.taggedBpm !== null ? formatBpm(track.tags.taggedBpm) : null,
        proposed,
        confidence,
        source,
        ...state,
      });
    }
  }

  if (key) {
    const confidence = key.manual ? null : (analysis?.key.confidence ?? null);
    const source: "automatic" | "manual" = key.manual ? "manual" : "automatic";
    const state = classify(confidence, source, options.overrideLowConfidence ?? false);
    const classic = shortKeyLabel(key.tonic, key.mode);

    if (track.tags.taggedKey !== classic) {
      changes.push({
        field: "key",
        label: "Key",
        current: track.tags.taggedKey,
        proposed: classic,
        confidence,
        source,
        ...state,
      });
    }

    if (options.includeCamelot) {
      changes.push({
        field: "camelot",
        label: "Camelot (comment)",
        current: null,
        proposed: camelotLabel(key.tonic, key.mode),
        confidence,
        source,
        ...state,
      });
    }
  }

  if (options.includeComment && analysis) {
    const parts = [
      bpm !== null ? `${bpm.toFixed(1)} BPM` : null,
      key ? `${keyName(key.tonic, key.mode)} (${camelotLabel(key.tonic, key.mode)})` : null,
      `Energy ${analysis.energy.level}/10`,
      Number.isFinite(analysis.loudness.integratedLufs)
        ? `${analysis.loudness.integratedLufs.toFixed(1)} LUFS`
        : null,
    ].filter(Boolean);
    changes.push({
      field: "comment",
      label: "Comment",
      current: track.tags.comment,
      proposed: parts.join(" | "),
      confidence: null,
      source: "automatic",
      blocked: null,
      warning: null,
      selected: false,
    });
  }

  return {
    trackId: track.id,
    filename: track.name,
    supported: true,
    unsupportedReason: null,
    changes,
  };
}

/** "Am", "F#", the notation DJ software expects in the key frame. */
export function shortKeyLabel(tonic: number, mode: Mode): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[tonic]}${mode === "minor" ? "m" : ""}`;
}

/** The frames actually sent to the writer, after the user's ticks. */
export interface TagWritePayload {
  bpm?: string;
  initialKey?: string;
  comment?: string;
}

/**
 * Collapse selected changes into frames.
 *
 * Blocked changes are dropped here as well as in the UI: a plan that reaches
 * this function with a blocked change ticked is a bug, and silently honouring
 * it would be the wrong way to find out.
 */
export function toWritePayload(plan: WritePlan, selectedFields: Set<TagField>): TagWritePayload {
  const payload: TagWritePayload = {};
  const commentParts: string[] = [];

  for (const change of plan.changes) {
    if (change.blocked !== null) continue;
    if (!selectedFields.has(change.field)) continue;

    switch (change.field) {
      case "bpm":
        payload.bpm = change.proposed;
        break;
      case "key":
        payload.initialKey = change.proposed;
        break;
      case "camelot":
        commentParts.push(change.proposed);
        break;
      case "comment":
        commentParts.push(change.proposed);
        break;
    }
  }

  if (commentParts.length > 0) payload.comment = commentParts.join(" | ");
  return payload;
}
