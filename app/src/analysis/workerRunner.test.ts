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
