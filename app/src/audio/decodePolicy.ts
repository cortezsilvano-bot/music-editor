/** The browser media pipeline handles longer files without a full renderer PCM buffer. */
export const PCM_DECODE_LIMIT = 128 * 1024 * 1024;
export const ENCODED_DECODE_LIMIT = 64 * 1024 * 1024;
/** Duration above which inspector playback prefers MediaElement streaming. */
export const STREAM_DURATION_SEC = 15 * 60;

export type StreamTrackInfo = {
  durationSec: number;
  sizeBytes: number;
  tags?: { channels: number | null };
};

export function estimatedPcmBytes(track: StreamTrackInfo, sampleRate = 48000): number {
  const channels = Math.max(2, track.tags?.channels ?? 2);
  return track.durationSec * sampleRate * channels * 4;
}

/**
 * Prefer HTMLAudioElement streaming when full PCM would be large.
 * Thresholds: >15 min, or estimated PCM >128MB, or encoded file >64MB.
 */
export function shouldStream(track: StreamTrackInfo, sampleRate = 48000): boolean {
  return (
    track.durationSec > STREAM_DURATION_SEC ||
    estimatedPcmBytes(track, sampleRate) > PCM_DECODE_LIMIT ||
    track.sizeBytes > ENCODED_DECODE_LIMIT
  );
}

/**
 * Mix Mode uses MediaElement streaming for oversized tracks (no full PCM).
 * Kept for older call sites; always null now that streaming decks exist.
 * Prefer mixModeUsesStream() to choose the transport.
 */
export const MIX_MODE_STREAM_REFUSAL =
  "Track too long for Mix Mode PCM; use inspector streaming play";

/** Shown when a Mix deck loads on the streaming path. */
export const MIX_MODE_STREAM_LIMITS =
  "Streaming Mix deck: play/pause/seek/EQ/crossfade/gain work. WSOLA key-lock, beat loops, slip, and rolls need full PCM and stay disabled. Tempo sync uses playbackRate (pitch follows); phase sync seeks the media clock — not sample-accurate WSOLA.";

export const ANALYSIS_STREAM_REFUSAL =
  "Track too long for full-pipeline analysis PCM; use inspector streaming play (or shorten the file)";

/** Mix Mode should use MediaElement streaming instead of decoding full PCM. */
export function mixModeUsesStream(track: StreamTrackInfo, sampleRate = 48000): boolean {
  return shouldStream(track, sampleRate);
}

/**
 * Formerly refused Mix Mode for oversized tracks. Streaming decks replaced that
 * refusal; always returns null. Callers must use mixModeUsesStream() and loadStream.
 */
export function mixModeDecodeRefusal(_track: StreamTrackInfo, _sampleRate = 48000): string | null {
  return null;
}

/** Full analysis decodes all channels into the worker; refuse oversized tracks by default. */
export function analysisDecodeRefusal(track: StreamTrackInfo, sampleRate = 48000): string | null {
  return shouldStream(track, sampleRate) ? ANALYSIS_STREAM_REFUSAL : null;
}
