/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addTrack, db } from "../db/library";
import { AnalysisScheduler, type AnalysisRunner } from "./scheduler";
import type { AnalysisResult } from "./pipeline";
let scheduler: AnalysisScheduler;
beforeEach(async () => { await db.jobs.clear(); await db.tracks.clear(); });
afterEach(() => { scheduler?.dispose(); });
async function track() { return addTrack(new File(["audio"], "track.wav"), 10, new Float32Array([1])); }
function blockedRunner() {
  const cancel = vi.fn();
  const runner: AnalysisRunner = () => {
    let fail: (error: Error) => void = () => {};
    const result = new Promise<AnalysisResult>((_, reject) => { fail = reject; });
    cancel.mockImplementation(() => fail(new Error("cancelled")));
    return { result, cancel };
  };
  return { runner: vi.fn(runner), cancel };
}
it("cancels the active computation and does not record a failure", async () => {
  const t = await track();
  const { runner, cancel } = blockedRunner();
  scheduler = new AnalysisScheduler(runner, () => {}, () => {});
  await scheduler.start(); await scheduler.enqueue(t.id);
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  await scheduler.cancel(t.id);
  expect(cancel).toHaveBeenCalled();
  await vi.waitFor(async () => expect((await db.jobs.get(t.id))?.status).toBe("cancelled"));
  expect((await db.tracks.get(t.id))?.analysisError).toBeNull();
});
it("recovers an interrupted job on startup", async () => {
  const t = await track();
  await db.jobs.put({ id: t.id, status: "running", priority: 0, queuedAt: 0, attempts: 1, error: null });
  const { runner } = blockedRunner();
  scheduler = new AnalysisScheduler(runner, () => {}, () => {});
  await scheduler.start();
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  expect((await db.jobs.get(t.id))?.attempts).toBe(2);
});
it("records a worker failure and allows a retry", async () => {
  const t = await track();
  const runner = vi.fn(() => ({ result: Promise.reject(new Error("worker crash")), cancel: vi.fn() }));
  scheduler = new AnalysisScheduler(runner, () => {}, () => {});
  await scheduler.start(); await scheduler.enqueue(t.id);
  await vi.waitFor(async () => expect((await db.jobs.get(t.id))?.status).toBe("failed"));
  expect((await db.tracks.get(t.id))?.analysisError).toBe("worker crash");
  await scheduler.enqueue(t.id);
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
});
it("times out a hung computation and terminates it", async () => {
  const t = await track(); const { runner, cancel } = blockedRunner();
  scheduler = new AnalysisScheduler(runner, () => {}, () => {}, db, 20);
  await scheduler.start(); await scheduler.enqueue(t.id);
  await vi.waitFor(async () => expect((await db.jobs.get(t.id))?.status).toBe("failed"));
  expect((await db.tracks.get(t.id))?.analysisError).toMatch(/timed out/);
  expect(cancel).toHaveBeenCalled();
});
it("processes higher-priority queued work first", async () => {
  const a = await track(); const b = await track();
  const { runner } = blockedRunner();
  scheduler = new AnalysisScheduler(runner, () => {}, () => {});
  await scheduler.enqueue(a.id, 0); await scheduler.enqueue(b.id, 10);
  await scheduler.start();
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  expect(runner.mock.calls[0][0].id).toBe(b.id);
});
