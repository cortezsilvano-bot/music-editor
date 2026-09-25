import { afterEach, expect, it, vi } from "vitest";
import { workerRunner } from "./workerRunner";
import type { StoredTrack } from "../db/library";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void; message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
const track = { id: "track", audio: { arrayBuffer: async () => new ArrayBuffer(4) } } as StoredTrack;
const decoded = { numberOfChannels: 1, sampleRate: 22050, getChannelData: () => new Float32Array(4) };
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });
it("terminates a busy worker and rejects the outstanding result", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const run = workerRunner({ decodeAudioData: async () => decoded } as unknown as BaseAudioContext)(track, vi.fn());
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const worker = FakeWorker.instances[0];
  const rejection = expect(run.result).rejects.toThrow("cancelled");
  run.cancel();
  worker.onmessage?.({ data: { id: "track", type: "result", result: {} } });
  await rejection;
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("does not start a worker after cancellation during decode", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  let finish: (value: typeof decoded) => void = () => {};
  const decode = new Promise<typeof decoded>(resolve => { finish = resolve; });
  const run = workerRunner({ decodeAudioData: () => decode } as unknown as BaseAudioContext)(track, vi.fn());
  const rejection = expect(run.result).rejects.toThrow("cancelled");
  run.cancel(); finish(decoded); await rejection;
  await Promise.resolve();
  expect(FakeWorker.instances).toHaveLength(0);
});
it("reports a worker crash instead of leaving the job unresolved", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const run = workerRunner({ decodeAudioData: async () => decoded } as unknown as BaseAudioContext)(track, vi.fn());
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  const rejection = expect(run.result).rejects.toThrow("crashed");
  FakeWorker.instances[0].onerror?.({ preventDefault: vi.fn(), message: "worker crashed" });
  await rejection; run.cancel();
});
it("reuses cached PCM without transferring or modifying the playback buffer", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const pcm = new Float32Array([0.25, -0.5]);
  const buffer = { ...decoded, getChannelData: () => pcm } as unknown as AudioBuffer;
  const decodeAudioData = vi.fn();
  const run = workerRunner({ decodeAudioData } as unknown as BaseAudioContext, new Map([[track.id, buffer]]))(track, vi.fn());
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(1));
  expect(decodeAudioData).not.toHaveBeenCalled();
  const [message, transfers] = FakeWorker.instances[0].postMessage.mock.calls[0];
  expect(message.channels[0]).toEqual(pcm);
  expect(transfers[0]).not.toBe(pcm.buffer);
  message.channels[0][0] = 1;
  expect(pcm[0]).toBe(0.25);
  const rejection = expect(run.result).rejects.toThrow("cancelled");
  run.cancel(); await rejection;
});

it("refuses oversized tracks before decoding for analysis", async () => {
  vi.stubGlobal("Worker", FakeWorker);
  const longTrack = {
    id: "long",
    durationSec: 16 * 60,
    sizeBytes: 1024,
    tags: { channels: 2 },
    audio: { arrayBuffer: async () => new ArrayBuffer(4) },
  } as StoredTrack;
  const decodeAudioData = vi.fn();
  const run = workerRunner({ decodeAudioData } as unknown as BaseAudioContext)(longTrack, vi.fn());
  await expect(run.result).rejects.toThrow(/too long for full-pipeline analysis PCM/);
  expect(decodeAudioData).not.toHaveBeenCalled();
  expect(FakeWorker.instances).toHaveLength(0);
  run.cancel();
});
