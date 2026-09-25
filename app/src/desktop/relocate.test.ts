import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TAGS } from "../metadata/tags";

vi.mock("../db/library", () => ({
  setTrackFilePath: vi.fn(async () => undefined),
}));

import { setTrackFilePath, type StoredTrack } from "../db/library";
import { hashArrayBuffer, relocateTrackFile } from "./relocate";

function track(partial: Partial<StoredTrack> & { id: string; contentHash?: string }): StoredTrack {
  return {
    name: "t.wav",
    audio: new Blob(),
    mimeType: "audio/wav",
    sizeBytes: 1,
    durationSec: 1,
    addedAt: 0,
    peaks: null,
    tags: { ...EMPTY_TAGS },
    analysis: null,
    analysisVersion: null,
    analysisError: null,
    manualBpm: null,
    manualGrid: null,
    manualKeyTonic: null,
    manualKeyMode: null,
    reviewedAt: null,
    ...partial,
  };
}

describe("relocateTrackFile", () => {
  beforeEach(() => {
    vi.mocked(setTrackFilePath).mockClear();
  });

  it("updates the path when the content hash matches", async () => {
    const bytes = new TextEncoder().encode("same-bytes").buffer;
    const hash = await hashArrayBuffer(bytes);
    const result = await relocateTrackFile(
      track({ id: "a", contentHash: hash }),
      "F:/Music/a.wav",
      async () => ({ ok: true, data: bytes }),
    );
    expect(result).toEqual({ ok: true, filePath: "F:/Music/a.wav" });
    expect(setTrackFilePath).toHaveBeenCalledWith("a", "F:/Music/a.wav");
  });

  it("rejects when the content hash differs", async () => {
    const bytes = new TextEncoder().encode("other").buffer;
    const result = await relocateTrackFile(
      track({ id: "a", contentHash: "deadbeef" }),
      "F:/Music/a.wav",
      async () => ({ ok: true, data: bytes }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hash_mismatch");
    expect(setTrackFilePath).not.toHaveBeenCalled();
  });

  it("allows relocate when the track has no content hash yet", async () => {
    const bytes = new TextEncoder().encode("legacy").buffer;
    const result = await relocateTrackFile(
      track({ id: "legacy" }),
      "F:/Music/legacy.wav",
      async () => ({ ok: true, data: bytes }),
    );
    expect(result.ok).toBe(true);
    expect(setTrackFilePath).toHaveBeenCalled();
  });
});
