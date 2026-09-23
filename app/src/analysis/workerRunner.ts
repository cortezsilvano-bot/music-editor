import type { AnalysisRunner } from "./scheduler";
import type { AnalysisResult } from "./pipeline";
import type { WorkerResponse } from "../workers/analysis.worker";

/** Terminating the dedicated worker interrupts synchronous DSP immediately. */
export function workerRunner(context: BaseAudioContext): AnalysisRunner {
  return (track, progress) => {
    let worker: Worker | null = null;
    let cancelled = false;
    let rejectResult: (error: Error) => void = () => {};
    const result = new Promise<AnalysisResult>((resolve, reject) => {
      rejectResult = reject;
      void (async () => {
        progress("decoding", 0);
        const audio = await context.decodeAudioData(await track.audio.arrayBuffer());
        if (cancelled) return;
        worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
          if (cancelled || data.id !== track.id) return;
          if (data.type === "result") resolve(data.result);
          else if (data.type === "error") reject(new Error(data.message));
          else progress(data.stage, data.progress);
        };
        worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || "Analysis worker crashed")); };
        worker.onmessageerror = () => reject(new Error("Could not read analysis worker response"));
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i).slice());
        worker.postMessage({ type: "analyze", id: track.id, channels, sampleRate: audio.sampleRate }, channels.map(c => c.buffer));
      })().catch(reject);
    });
    return { result, cancel: () => {
      cancelled = true;
      worker?.terminate();
      rejectResult(new Error("Analysis cancelled"));
    } };
  };
}
