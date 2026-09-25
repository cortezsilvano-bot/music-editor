/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addTrack, db, removeTrack } from "../db/library";
import { AnalysisScheduler, type StemRunner } from "./scheduler";
import type { StemCacheEntry } from "../db/stems";
const schedulers: AnalysisScheduler[] = [];
const options = { backend: "dsp", quality: "balanced", stems: "basic" } as const;
function scheduler(stemRunner: StemRunner, cancelRemote = vi.fn(async () => {})) {
  const s = new AnalysisScheduler(() => { throw new Error("Analysis runner must not receive stem work"); }, () => {}, () => {}, db,
    60_000, { stemRunner, cancelRemote, pollMs: 100_000 });
  schedulers.push(s); return s;
}
beforeEach(async () => { await db.jobs.clear(); await db.jobEvents.clear(); await db.stemCache.clear(); await db.analysisHistory.clear(); await db.tracks.clear(); });
afterEach(async () => { await Promise.all(schedulers.splice(0).map(s => s.dispose())); });
async function track() { return addTrack(new File(["audio"], "source.wav"), 10, new Float32Array([1])); }
function entry(trackId: string): StemCacheEntry {
  return { id: "hash:dsp:v1", audioHash: "hash", model: "dsp", trackId, trackName: "source.wav", stems: [],
    sizeBytes: 100, createdAt: 1, lastUsedAt: 1, pinned: false };
}
it("commits stems through the common queue without changing automatic analysis or manual edits", async () => {
  const t = await track(); await db.tracks.update(t.id, { manualBpm: 123, analysisError: "Existing analysis failure" });
  const runner = vi.fn<StemRunner>(() => ({ result: Promise.resolve(entry(t.id)), cancel: vi.fn() }));
  const s = scheduler(runner); await s.enqueueStems(t.id, options); await s.start(); await s.tick();
  expect((await db.jobs.get(`stems:${t.id}`))?.status).toBe("done");
  expect((await db.stemCache.get("hash:dsp:v1"))?.trackId).toBe(t.id);
  expect((await db.tracks.get(t.id))?.manualBpm).toBe(123);
  expect((await db.tracks.get(t.id))?.analysisError).toBe("Existing analysis failure");
  expect(await db.analysisHistory.count()).toBe(0);
  expect(runner.mock.calls[0][2].runId).toBeTruthy();
});
it("retains remote cancellation while offline and sends it after scheduler restart", async () => {
  const t = await track(); const runner: StemRunner = () => ({ result: new Promise(() => {}), cancel: vi.fn() });
  const s = scheduler(runner);
  await s.enqueueStems(t.id, options); await s.cancel(`stems:${t.id}`);
  expect((await db.jobs.get(`stems:${t.id}`))?.remoteCancelPending).toBe(true);
  await expect(removeTrack(t.id)).rejects.toThrow(/cancellation/);
  await expect(s.enqueueStems(t.id, options)).rejects.toThrow(/acknowledge/);
  await s.dispose(); const cancelRemote = vi.fn(async () => {}); const replacement = scheduler(runner, cancelRemote);
  await replacement.start(); await replacement.tick();
  expect(cancelRemote).toHaveBeenCalledOnce();
  expect((await db.jobs.get(`stems:${t.id}`))?.remoteCancelPending).toBe(false);
  await removeTrack(t.id); expect(await db.jobs.count()).toBe(0);
});
it("refuses late stem results from a cancelled attempt", async () => {
  const t = await track(); let resolve: (value: StemCacheEntry) => void = () => {};
  const runner = vi.fn<StemRunner>(() => ({ result: new Promise(yes => { resolve = yes; }), cancel: vi.fn() }));
  const s = scheduler(runner); await s.enqueueStems(t.id, options); await s.start();
  await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
  await s.cancel(`stems:${t.id}`); resolve(entry(t.id)); await s.tick();
  expect(await db.stemCache.count()).toBe(0);
  expect((await db.jobs.get(`stems:${t.id}`))?.status).toBe("cancelled");
});
it("preserves pinned cache entries and atomically refuses a result that will not fit", async () => {
  const t = await track(); const saved = { ...entry(t.id), pinned: true, sizeBytes: 2 * 1024 ** 3 };
  await db.stemCache.put(saved);
  const runner: StemRunner = () => ({ result: Promise.resolve({ ...entry(t.id), id: "new-result" }), cancel: vi.fn() });
  const s = scheduler(runner); await s.enqueueStems(t.id, options); await s.start(); await s.tick();
  expect((await db.jobs.get(`stems:${t.id}`))?.status).toBe("failed");
  expect(await db.stemCache.toArray()).toEqual([saved]);
});
