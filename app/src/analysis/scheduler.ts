import { db, type AnalysisJob, type LibraryDatabase, type StoredTrack } from "../db/library";
import type { AnalysisResult } from "./pipeline";

export interface RunningAnalysis {
  result: Promise<AnalysisResult>;
  cancel: () => void;
}
export type AnalysisRunner = (track: StoredTrack, progress: (stage: string, value: number) => void) => RunningAnalysis;

/** One active job per scheduler. Audio stays in storage until a job starts. */
export class AnalysisScheduler {
  private stopped = true;
  private busy = false;
  private active: { id: string; task: RunningAnalysis } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private runner: AnalysisRunner,
    private changed: () => void,
    private progress: (id: string, stage: string, value: number) => void,
    private database: LibraryDatabase = db,
    private timeoutMs = 120_000,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.database.jobs.where("status").equals("running").modify({ status: "queued" });
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 500);
    this.changed();
    void this.tick();
  }

  async enqueue(id: string, priority = 0): Promise<void> {
    await this.database.transaction("rw", this.database.tracks, this.database.jobs, async () => {
      if (!(await this.database.tracks.get(id))) throw new Error("Track no longer exists");
      const prior = await this.database.jobs.get(id);
      if (prior?.status === "running" || prior?.status === "queued") return;
      await this.database.jobs.put({ id, status: "queued", priority, queuedAt: Date.now(), attempts: 0, error: null });
      await this.database.tracks.update(id, { analysisError: null });
    });
    this.changed();
    void this.tick();
  }

  async cancel(id: string): Promise<void> {
    await this.database.transaction("rw", this.database.jobs, async () => {
      const job = await this.database.jobs.get(id);
      if (job?.status === "queued" || job?.status === "running") {
        await this.database.jobs.update(id, { status: "cancelled", error: null });
      }
    });
    if (this.active?.id === id) this.active.task.cancel();
    this.changed();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.active?.task.cancel();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    let job: AnalysisJob | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      job = await this.database.transaction("rw", this.database.jobs, async () => {
        const queued = await this.database.jobs.where("status").equals("queued").toArray();
        queued.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
        const next = queued[0];
        if (next && !this.stopped) {
          await this.database.jobs.update(next.id, { status: "running", attempts: next.attempts + 1 });
          return next;
        }
      });
      if (!job || this.stopped) return;
      const track = await this.database.tracks.get(job.id);
      if (!track) { await this.database.jobs.delete(job.id); return; }
      const id = job.id;
      // Cancellation may have arrived while the track was being read.
      if ((await this.database.jobs.get(id))?.status !== "running" || this.stopped) return;
      const task = this.runner(track, (stage, value) => {
        if (!this.stopped) this.progress(id, stage, value);
      });
      this.active = { id, task };
      this.changed();
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { reject(new Error("Analysis timed out; retry this track")); task.cancel(); }, this.timeoutMs);
      });
      const result = await Promise.race([task.result, deadline]);
      if (this.stopped) return;
      await this.database.transaction("rw", this.database.tracks, this.database.jobs, async () => {
        if ((await this.database.jobs.get(id))?.status !== "running") return;
        await this.database.tracks.update(id, { analysis: result, analysisVersion: result.analysisVersion, analysisError: null, reviewedAt: null });
        await this.database.jobs.update(id, { status: "done", error: null });
      });
    } catch (error) {
      if (job && !this.stopped) {
        const id = job.id;
        const message = error instanceof Error ? error.message : String(error);
        await this.database.transaction("rw", this.database.tracks, this.database.jobs, async () => {
          if ((await this.database.jobs.get(id))?.status !== "running") return;
          await this.database.jobs.update(id, { status: "failed", error: message });
          await this.database.tracks.update(id, { analysisError: message });
        });
      }
    } finally {
      clearTimeout(timeout);
      this.active?.task.cancel();
      this.active = null;
      this.busy = false;
      if (!this.stopped) this.changed();
    }
  }
}
