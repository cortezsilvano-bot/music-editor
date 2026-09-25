import { JobError } from "../analysis/jobErrors";
import type { StemRunner } from "../analysis/scheduler";
import type { AnalysisJob } from "../db/library";
import { checkStemsPlausible, type StemCacheEntry } from "../db/stems";
import { downloadStems, stemServiceBase, type SeparationResult } from "./service";
import { createLogger } from "../util/logger";

const log = createLogger("stems");

interface RemoteJob { status: "queued" | "running" | "done" | "failed" | "cancelled"; error?: string; result?: SeparationResult }
const endpoint = (job: AnalysisJob) => `${stemServiceBase()}/api/studio/jobs/${encodeURIComponent(job.runId!)}`;
async function request(url: string, options: RequestInit, missingOkay = false): Promise<RemoteJob | null> {
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(5000);
    const response = await fetch(url, { ...options, signal });
    if (missingOkay && response.status === 404) return null;
    if (!response.ok) throw new JobError(response.status >= 500 ? "service_unavailable" : "separation", `Stem service ${response.status}: ${await response.text()}`);
    return await response.json() as RemoteJob;
  } catch (error) {
    if (error instanceof JobError) throw error;
    if (options.signal?.aborted) throw new JobError("cancelled", "Stem job detached");
    throw new JobError("service_unavailable", `Stem service unavailable: ${String(error)}`);
  }
}
function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new JobError("cancelled", "Stem job detached")); return; }
    const abort = () => { clearTimeout(timer); reject(new JobError("cancelled", "Stem job detached")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function cancelRemoteStemJob(job: AnalysisJob): Promise<void> {
  if (job.runId) await request(endpoint(job), { method: "DELETE" });
}

/** The same run ID reconnects after renderer failure; only explicit cancellation deletes server work. */
export const stemRunner: StemRunner = (track, progress, job) => {
  const controller = new AbortController();
  const result = (async (): Promise<StemCacheEntry> => {
    if (!track.audioHash || !job.stemOptions || !job.runId) throw new JobError("separation", "Track hash or stem options are missing");
    progress("connecting to stem service", 0);
    log.info("stem request", { trackId: track.id, runId: job.runId, backend: job.stemOptions.backend });
    let remote = await request(endpoint(job), { signal: controller.signal }, true);
    if (!remote) {
      const form = new FormData(); form.append("file", track.audio, track.name);
      form.append("options", JSON.stringify(job.stemOptions));
      remote = await request(endpoint(job), { method: "PUT", body: form, signal: controller.signal });
    }
    while (remote?.status === "queued" || remote?.status === "running") {
      progress(remote.status === "queued" ? "stem service queued" : "separating stems", 0);
      await wait(controller.signal);
      remote = await request(endpoint(job), { signal: controller.signal });
    }
    if (remote?.status !== "done" || !remote.result) throw new JobError("separation", remote?.error || `Stem job ${remote?.status ?? "missing"}`);
    const completed = remote.result;
    if (track.contentHash && completed.sourceHash !== track.contentHash) throw new JobError("separation", "Stem source hash does not match this track");
    if (completed.stems.some(stem => new URL(stem.url).origin !== new URL(stemServiceBase()).origin)) throw new JobError("separation", "Unexpected stem download origin");
    progress("downloading stems", 0);
    const stems = await downloadStems(completed, controller.signal).catch(error => {
      throw new JobError("service_unavailable", `Stem download interrupted: ${String(error)}`);
    });
    const plausible = checkStemsPlausible(stems, track.sizeBytes);
    if (!plausible.ok) throw new JobError("separation", plausible.reason!);
    const model = completed.backend === "demucs" ? `demucs/${completed.modelId}` : "dsp";
    const now = Date.now();
    return { id: `${track.audioHash}:${completed.sourceHash}:${model}:${completed.modelVersion}:${completed.checkpointHash ?? "no-weights"}:${completed.algorithmHash}:${job.stemOptions.quality}:${job.stemOptions.stems}`,
      audioHash: track.audioHash, sourceHash: completed.sourceHash, model, modelVersion: completed.modelVersion,
      checkpointHash: completed.checkpointHash, algorithmHash: completed.algorithmHash, quality: job.stemOptions.quality,
      device: completed.device, fallbackReason: completed.fallbackReason, serverJobId: job.runId,
      trackId: track.id, trackName: track.name, stems, sizeBytes: stems.reduce((total, stem) => total + stem.blob.size, 0),
      createdAt: now, lastUsedAt: now, pinned: false };
  })();
  return { result, cancel: () => controller.abort() };
};
