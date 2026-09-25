/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addTrack, db } from "../db/library";
import { AnalysisScheduler, type AnalysisRunner, type SchedulerOptions } from "./scheduler";
import { JobError } from "./jobErrors";
import { analyze, type AnalysisResult } from "./pipeline";
const schedulers: AnalysisScheduler[] = [];
const base = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
function result(bpm: number) { return { ...base, tempo: { ...base.tempo, bpm } }; }
function pending() {
  let resolve: (result: AnalysisResult) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<AnalysisResult>((yes, no) => { resolve = yes; reject = no; });
  const cancel = vi.fn(() => reject(new JobError("cancelled", "cancelled")));
  return { resolve, reject, cancel, runner: vi.fn<AnalysisRunner>(() => ({ result: promise, cancel })) };
}
function scheduler(runner: AnalysisRunner, options: SchedulerOptions = {}) {
  const s = new AnalysisScheduler(runner, () => {}, () => {}, db, 30_000, { pollMs: 100_000, ...options });
  schedulers.push(s); return s;
}
async function track() { return addTrack(new File(["audio"], "test.wav"), 10, new Float32Array([1])); }
beforeEach(async () => { await db.jobs.clear(); await db.jobEvents.clear(); await db.analysisHistory.clear(); await db.tracks.clear(); });
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.dispose())); });
it("atomically claims once when two windows start together", async () => {
  const t = await track(); const a = pending(), b = pending(); const sa = scheduler(a.runner), sb = scheduler(b.runner);
  await sa.enqueue(t.id);
  await Promise.all([sa.start(), sb.start()]);
  await vi.waitFor(() => expect(a.runner.mock.calls.length + b.runner.mock.calls.length).toBe(1));
  const job = (await db.jobs.get(t.id))!;
  expect([sa.ownerId, sb.ownerId]).toContain(job.owner);
  expect(job.attempts).toBe(1); expect(job.attemptId).toBeTruthy();
  await sa.enqueue(t.id); await sb.enqueue(t.id);
  expect((await db.jobs.get(t.id))?.attemptId).toBe(job.attemptId);
});
it("does not steal a live lease on startup", async () => {
  const t = await track(); const a = pending(), b = pending(); const sa = scheduler(a.runner), sb = scheduler(b.runner);
  await sa.enqueue(t.id); await sa.start();
  await vi.waitFor(() => expect(a.runner).toHaveBeenCalledOnce());
  await sb.start(); await sb.tick();
  expect(b.runner).not.toHaveBeenCalled(); expect((await db.jobs.get(t.id))?.owner).toBe(sa.ownerId);
});
it("recovers expiry and rejects a late result from the previous attempt", async () => {
  let now = 1000; const opts = { now: () => now, leaseMs: 1000, heartbeatMs: 900 };
  const t = await track(); const a = pending(), b = pending(); const sa = scheduler(a.runner, opts), sb = scheduler(b.runner, opts);
  await sa.enqueue(t.id); await sa.start(); await vi.waitFor(() => expect(a.runner).toHaveBeenCalledOnce());
  const oldToken = (await db.jobs.get(t.id))!.attemptId;
  now = 2001; await sb.start(); await vi.waitFor(() => expect(b.runner).toHaveBeenCalledOnce());
  expect((await db.jobs.get(t.id))?.attemptId).not.toBe(oldToken);
  a.resolve(result(80)); await sa.tick();
  expect((await db.tracks.get(t.id))?.analysis).toBeNull();
  b.resolve(result(140)); await sb.tick();
  expect((await db.tracks.get(t.id))?.analysis?.tempo.bpm).toBe(140);
  expect(await db.analysisHistory.where("trackId").equals(t.id).count()).toBe(1);
});
it("heartbeats extend the lease and publish progress", async () => {
  const t = await track(); const a = pending(); const sa = scheduler(a.runner, { heartbeatMs: 20, leaseMs: 1000 });
  await sa.enqueue(t.id); await sa.start(); await vi.waitFor(() => expect(a.runner).toHaveBeenCalledOnce());
  const first = (await db.jobs.get(t.id))!.lastHeartbeatAt!;
  a.runner.mock.calls[0][1]("key", 0.7);
  await vi.waitFor(async () => { const j = (await db.jobs.get(t.id))!; expect(j.lastHeartbeatAt).toBeGreaterThan(first); expect(j.stage).toBe("key"); expect(j.progress).toBe(0.7); });
});
it("cancels from another window and prevents a queued retry", async () => {
  const t = await track(); const a = pending(); const sa = scheduler(a.runner, { heartbeatMs: 20, leaseMs: 1000 }); const sb = scheduler(pending().runner);
  await sa.enqueue(t.id); await sa.start(); await vi.waitFor(() => expect(a.runner).toHaveBeenCalledOnce());
  await sb.cancel(t.id); await vi.waitFor(() => expect(a.cancel).toHaveBeenCalled());
  expect((await db.jobs.get(t.id))?.status).toBe("cancelled"); expect(await db.analysisHistory.count()).toBe(0);
});
it("retries only transient failures with bounded exponential backoff", async () => {
  let now = 1000; const t = await track();
  const runner = vi.fn<AnalysisRunner>(() => ({ result: Promise.reject(new JobError("worker_crash", "crash")), cancel: vi.fn() }));
  const s = scheduler(runner, { now: () => now, retryBaseMs: 100, maxAttempts: 2 });
  await s.enqueue(t.id); await s.start(); await s.tick();
  expect((await db.jobs.get(t.id))?.status).toBe("queued"); expect((await db.jobs.get(t.id))?.nextAttemptAt).toBe(1100);
  await s.tick(); expect(runner).toHaveBeenCalledTimes(1);
  now = 1100; await s.tick(); expect(runner).toHaveBeenCalledTimes(2);
  expect((await db.jobs.get(t.id))?.status).toBe("failed"); expect((await db.jobs.get(t.id))?.errorCode).toBe("worker_crash");
  await s.tick(); expect(runner).toHaveBeenCalledTimes(2);
});
it("fails invalid media once and retains error diagnostics", async () => {
  const t = await track(); const runner = vi.fn<AnalysisRunner>(() => ({ result: Promise.reject(new JobError("decode", "invalid audio")), cancel: vi.fn() }));
  const s = scheduler(runner); await s.enqueue(t.id); await s.start(); await s.tick();
  expect((await db.jobs.get(t.id))?.status).toBe("failed"); expect(runner).toHaveBeenCalledOnce();
  expect((await db.jobEvents.where("jobId").equals(t.id).toArray()).at(-1)?.errorCode).toBe("decode");
});
it("does not revive cancellation after a restart", async () => {
  const t = await track(); const a = pending(); const s = scheduler(a.runner);
  await s.enqueue(t.id); await s.cancel(t.id); await s.start(); await s.tick();
  expect(a.runner).not.toHaveBeenCalled(); expect((await db.jobs.get(t.id))?.status).toBe("cancelled");
});
