/** One job per worker. The scheduler terminates this worker to cancel CPU work. */
import { analyze, type AnalysisResult } from "../analysis/pipeline";
export interface AnalyzeRequest {
  type: "analyze";
  id: string;
  channels: Float32Array[];
  sampleRate: number;
}
export type WorkerRequest = AnalyzeRequest;
export type WorkerResponse =
  | { type: "progress"; id: string; stage: string; progress: number }
  | { type: "result"; id: string; result: AnalysisResult }
  | { type: "error"; id: string; message: string; category: string };
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, channels, sampleRate } = data;
  try {
    let lastPost = -Infinity;
    const result = analyze({ channels, sampleRate }, { onProgress: ({ stage, progress }) => {
      const now = performance.now();
      if (now - lastPost < 100 && progress < 1) return;
      lastPost = now;
      post({ type: "progress", id, stage, progress });
    } });
    post({ type: "result", id, result });
  } catch (error) {
    post({ type: "error", id, message: error instanceof Error ? error.message : String(error), category: "analysis" });
  }
};
function post(message: WorkerResponse): void { (self as unknown as Worker).postMessage(message); }
