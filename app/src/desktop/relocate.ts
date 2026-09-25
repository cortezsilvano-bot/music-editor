/**
 * Relocate a desktop library row to a new on-disk path.
 *
 * If the new file's SHA-256 matches the stored contentHash, only the path is
 * updated and analysis is kept. If it differs, the caller must not overwrite
 * the row - import/skip patterns already cover exact duplicates.
 */
import { setTrackFilePath, type StoredTrack } from "../db/library";
import { createLogger } from "../util/logger";

const log = createLogger("relocate");

export type RelocateOutcome =
  | { ok: true; filePath: string }
  | { ok: false; reason: "hash_mismatch" | "read_failed" | "update_failed"; error: string };

export async function hashArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function relocateTrackFile(
  track: StoredTrack,
  filePath: string,
  read: (path: string) => Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>,
): Promise<RelocateOutcome> {
  const loaded = await read(filePath);
  if (!loaded.ok) {
    log.warn("relocate read failed", { trackId: track.id, error: loaded.error });
    return { ok: false, reason: "read_failed", error: loaded.error };
  }
  const hash = await hashArrayBuffer(loaded.data);
  if (track.contentHash && track.contentHash !== hash) {
    log.info("relocate rejected hash mismatch", { trackId: track.id });
    return {
      ok: false,
      reason: "hash_mismatch",
      error: "That file does not match this track's content hash. Import it as a new track instead.",
    };
  }
  try {
    await setTrackFilePath(track.id, filePath);
    log.info("relocated track file", { trackId: track.id });
    return { ok: true, filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("relocate update failed", { trackId: track.id, error: message });
    return { ok: false, reason: "update_failed", error: message };
  }
}
