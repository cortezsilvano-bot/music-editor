/** The browser media pipeline handles longer files without a full renderer PCM buffer. */
import { expect, it } from "vitest";
import {
  ANALYSIS_STREAM_REFUSAL,
  ENCODED_DECODE_LIMIT,
  MIX_MODE_STREAM_LIMITS,
  PCM_DECODE_LIMIT,
  STREAM_DURATION_SEC,
  analysisDecodeRefusal,
  estimatedPcmBytes,
  mixModeDecodeRefusal,
  mixModeUsesStream,
  shouldStream,
} from "./decodePolicy";

it("keeps short small files on the decode path", () => {
  const track = { durationSec: 180, sizeBytes: 5 * 1024 * 1024, tags: { channels: 2 } };
  expect(shouldStream(track)).toBe(false);
  expect(mixModeUsesStream(track)).toBe(false);
  expect(mixModeDecodeRefusal(track)).toBeNull();
  expect(analysisDecodeRefusal(track)).toBeNull();
});

it("uses Mix streaming (not refuse) when duration exceeds 15 minutes", () => {
  const track = { durationSec: STREAM_DURATION_SEC + 1, sizeBytes: 1024, tags: { channels: 2 } };
  expect(shouldStream(track)).toBe(true);
  expect(mixModeUsesStream(track)).toBe(true);
  // Streaming decks replaced the hard refuse; analysis still refuses full PCM.
  expect(mixModeDecodeRefusal(track)).toBeNull();
  expect(analysisDecodeRefusal(track)).toBe(ANALYSIS_STREAM_REFUSAL);
  expect(MIX_MODE_STREAM_LIMITS).toMatch(/WSOLA/i);
});

it("streams when estimated PCM exceeds the decode limit", () => {
  const durationSec = Math.ceil(PCM_DECODE_LIMIT / (48000 * 2 * 4)) + 1;
  const track = { durationSec, sizeBytes: 1024, tags: { channels: 2 } };
  expect(estimatedPcmBytes(track)).toBeGreaterThan(PCM_DECODE_LIMIT);
  expect(shouldStream(track)).toBe(true);
  expect(mixModeUsesStream(track)).toBe(true);
});

it("streams when encoded size exceeds the decode limit", () => {
  const track = { durationSec: 60, sizeBytes: ENCODED_DECODE_LIMIT + 1, tags: { channels: 2 } };
  expect(shouldStream(track)).toBe(true);
  expect(mixModeUsesStream(track)).toBe(true);
});

it("treats missing channel tags as stereo for PCM estimates", () => {
  const stereo = estimatedPcmBytes({ durationSec: 100, sizeBytes: 1, tags: { channels: 2 } });
  const missing = estimatedPcmBytes({ durationSec: 100, sizeBytes: 1 });
  const monoTagged = estimatedPcmBytes({ durationSec: 100, sizeBytes: 1, tags: { channels: 1 } });
  expect(missing).toBe(stereo);
  expect(monoTagged).toBe(stereo);
});
