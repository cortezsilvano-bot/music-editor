/**
 * Tag reading (research Phase B).
 *
 * Reads ID3, Vorbis Comments and MP4 atoms out of the stored Blob so the
 * library shows artist and title rather than filenames, and so exports carry
 * real metadata.
 *
 * Reading only. Writing tags back is not possible from a browser - the page
 * cannot modify the user's file in place - so Phase G's safe-write requirements
 * do not apply here and are not pretended at. Export writes separate files.
 */
import { parseBlob, type IAudioMetadata } from "music-metadata";

export interface TrackTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  trackNumber: number | null;
  /** Tagged BPM, if the file already carries one. */
  taggedBpm: number | null;
  /** Tagged musical key, as written in the file. */
  taggedKey: string | null;
  comment: string | null;
  /** Container/codec details, for the technical panel. */
  codec: string | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
  lossless: boolean | null;
}

export const EMPTY_TAGS: TrackTags = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  genre: null,
  year: null,
  trackNumber: null,
  taggedBpm: null,
  taggedKey: null,
  comment: null,
  codec: null,
  bitrateKbps: null,
  sampleRate: null,
  channels: null,
  lossless: null,
};

/** Trim and collapse a tag value, returning null for anything empty. */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstComment(metadata: IAudioMetadata): string | null {
  const comments = metadata.common.comment;
  if (!comments || comments.length === 0) return null;
  const first = comments[0];
  // music-metadata returns either strings or {text} depending on the format.
  if (typeof first === "string") return clean(first);
  return clean((first as { text?: string }).text);
}

/** Map a parsed result onto our own shape, normalising as we go. */
export function toTrackTags(metadata: IAudioMetadata): TrackTags {
  const { common, format } = metadata;
  const bpm = typeof common.bpm === "number" ? common.bpm : Number(common.bpm);

  return {
    title: clean(common.title),
    artist: clean(common.artist) ?? clean(common.artists?.[0]),
    album: clean(common.album),
    albumArtist: clean(common.albumartist),
    genre: clean(common.genre?.[0]),
    year: typeof common.year === "number" && common.year > 0 ? common.year : null,
    trackNumber: common.track?.no ?? null,
    taggedBpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    taggedKey: clean(common.key),
    comment: firstComment(metadata),
    codec: clean(format.codec) ?? clean(format.container),
    bitrateKbps:
      typeof format.bitrate === "number" && format.bitrate > 0
        ? Math.round(format.bitrate / 1000)
        : null,
    sampleRate: format.sampleRate ?? null,
    channels: format.numberOfChannels ?? null,
    lossless: format.lossless ?? null,
  };
}

/**
 * Read tags from a file.
 *
 * Never throws: a file with broken or absent tags is still a usable track, and
 * the brief is explicit that one bad file must not take down an import.
 */
export async function readTags(file: Blob): Promise<TrackTags> {
  try {
    const metadata = await parseBlob(file, { duration: false });
    return toTrackTags(metadata);
  } catch {
    return { ...EMPTY_TAGS };
  }
}

/** Container duration avoids decoding a long file just to import it. */
export async function readMediaMetadata(file: Blob): Promise<{ tags: TrackTags; durationSec: number | null }> {
  try {
    const metadata = await parseBlob(file, { duration: true, skipCovers: true });
    const duration = metadata.format.duration;
    return { tags: toTrackTags(metadata), durationSec: duration && Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch { return { tags: { ...EMPTY_TAGS }, durationSec: null }; }
}

/**
 * Best available display name.
 *
 * Falls back through tags to the filename with its extension stripped, so the
 * library never shows an empty row.
 */
export function displayName(tags: TrackTags, filename: string): string {
  if (tags.artist && tags.title) return `${tags.artist} — ${tags.title}`;
  if (tags.title) return tags.title;
  return filename.replace(/\.[^.]+$/, "");
}
