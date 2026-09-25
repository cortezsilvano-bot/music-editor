import { afterEach, expect, it, vi } from "vitest";
import { stemRunner, cancelRemoteStemJob } from "./jobs";
import type { AnalysisJob, StoredTrack } from "../db/library";
const track = { id: "track", audioHash: "pcm", contentHash: "sha", name: "source.wav", sizeBytes: 1024, audio: new Blob(["audio"]) } as StoredTrack;
const job = { id: "stems:track", runId: "stable-run", stemOptions: { backend: "dsp", quality: "balanced", stems: "basic" } } as AnalysisJob;
const completed = { status: "done", result: { job: "stable-run", backend: "dsp", sourceHash: "sha", modelVersion: "1", algorithmHash: "algorithm",
  stems: [{ name: "vocals.wav", type: "lead-vocals", url: "http://localhost:8787/api/studio/jobs/stable-run/stems/vocals.wav" }] } };
afterEach(() => vi.unstubAllGlobals());
it("reconnects to a completed job without uploading or recomputing audio", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(completed))).mockResolvedValueOnce(new Response(new Uint8Array(2048)));
  vi.stubGlobal("fetch", fetch);
  const task = stemRunner(track, vi.fn(), job); const result = await task.result; task.cancel();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1].method).toBeUndefined();
  expect(result.serverJobId).toBe("stable-run"); expect(result.sourceHash).toBe("sha");
  expect(result.id).toContain("algorithm:balanced:basic");
});
it("refuses a completed result from different source audio", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...completed, result: { ...completed.result, sourceHash: "wrong" } }))));
  await expect(stemRunner(track, vi.fn(), job).result).rejects.toThrow(/hash/);
});
it("uploads once under the persisted run identifier when no remote job exists", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(completed))).mockResolvedValueOnce(new Response(new Uint8Array(2048)));
  vi.stubGlobal("fetch", fetch); await stemRunner(track, vi.fn(), job).result;
  expect(fetch.mock.calls[1][0]).toContain("stable-run"); expect(fetch.mock.calls[1][1].method).toBe("PUT");
});
it("sends server cancellation and classifies offline errors for retry", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ status: "cancelled" }))).mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch); await cancelRemoteStemJob(job);
  expect(fetch.mock.calls[0][1].method).toBe("DELETE");
  await expect(stemRunner(track, vi.fn(), job).result).rejects.toMatchObject({ code: "service_unavailable" });
});
