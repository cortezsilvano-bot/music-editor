import { JobError } from "./jobErrors";
import type { AnalysisRunner } from "./scheduler";
import type { AnalysisResult } from "./pipeline";
import type { WorkerResponse } from "../workers/analysis.worker";
import { analysisDecodeRefusal } from "../audio/decodePolicy";

/** Terminating the dedicated worker interrupts synchronous DSP immediately. */
export function workerRunner(context: BaseAudioContext, decoded?: Map<string, AudioBuffer>): AnalysisRunner {
  return (track, progress) => {
    let worker: Worker | null = null;
    let cancelled = false;
    let rejectResult: (error: Error) => void = () => {};
    const result = new Promise<AnalysisResult>((resolve, reject) => {
      rejectResult = reject;
      void (async () => {
        progress("decoding", 0);
        const refusal = analysisDecodeRefusal(track);
        if (refusal) throw new JobError("decode", refusal);
        const audio = decoded?.get(track.id) ?? await context.decodeAudioData(await track.audio.arrayBuffer()).catch(error => {
          throw new JobError("decode", error instanceof Error ? error.message : "Could not decode audio");
        });
        if (cancelled) return;
        worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (cancelled || data.id !== track.id) return;
          if (data.type === "result") resolve(data.result);
          else if (data.type === "error") reject(new JobError("analysis", data.message));
          else progress(data.stage, data.progress);
        };
        worker.onerror = (event) => { event.preventDefault(); reject(new JobError("worker_crash", event.message || "Analysis worker crashed")); };
        worker.onmessageerror = () => reject(new JobError("worker_message", "Could not read analysis worker response"));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).slice());
        worker.postMessage({ type: "analyze", id: track.id, channels, sampleRate: audio.sampleRate }, channels.map(c => c.buffer));
      })().catch(reject);
    });
    return { result, cancel: () => {
      cancelled = true;
      worker?.terminate();
      rejectResult(new JobError("cancelled", "Analysis cancelled"));
    } };
  };
}
