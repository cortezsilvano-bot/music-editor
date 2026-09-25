import { db, persistAnalysis, type AnalysisJob, type LibraryDatabase, type StoredTrack } from "../db/library";
import { planEviction, DEFAULT_CACHE_LIMIT_BYTES, type StemCacheEntry } from "../db/stems";
import { createLogger } from "../util/logger";

const log = createLogger("scheduler");
import type { AnalysisResult } from "./pipeline";
import { classifyJobError, JobError } from "./jobErrors";

export interface RunningAnalysis { result: Promise<AnalysisResult>; cancel: () => void }
export type AnalysisRunner = (track: StoredTrack, progress: (stage: string, value: number) => void) => RunningAnalysis;
export interface RunningStemJob { result: Promise<StemCacheEntry>; cancel: () => void }
export type StemRunner = (track: StoredTrack, progress: (stage: string, value: number) => void, job: AnalysisJob) => RunningStemJob;
export interface SchedulerOptions {
  stemRunner?: StemRunner;
  cancelRemote?: (job: AnalysisJob) => Promise<void>;
  stemTimeoutMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

/** Claims and result commits are fenced by a unique token for each attempt. */
export class AnalysisScheduler {
  readonly ownerId = crypto.randomUUID();
  private stopped = true;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private active: { job: AnalysisJob; task: RunningAnalysis | RunningStemJob; abort: (error: Error) => void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextCancellationCheck = 0;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly now: () => number;

  constructor(
    private runner: AnalysisRunner,
    private changed: () => void,
    private progress: (id: string, stage: string, value: number) => void,
    private database: LibraryDatabase = db,
    private timeoutMs = 120_000,
    private options: SchedulerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 3_000;
    this.pollMs = options.pollMs ?? 500;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.now = options.now ?? Date.now;
    if (![this.leaseMs, this.heartbeatMs, this.pollMs, timeoutMs].every(n => Number.isFinite(n) && n > 0) ||
      this.heartbeatMs >= this.leaseMs || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 ||
      !Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0 ||
      (options.stemTimeoutMs !== undefined && (!Number.isFinite(options.stemTimeoutMs) || options.stemTimeoutMs <= 0))) throw new Error("Invalid scheduler configuration");
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Scheduler has been disposed");
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.notify(); this.kick();
  }

  private notify(): void {
    try { this.changed(); } catch (error) { this.report(error); }
  }
  private report(error: unknown): void { this.options.onError?.(String(error)); }
  private kick(): void { void this.tick().catch(error => this.report(error)); }
  private matches(current: AnalysisJob | undefined, claim: AnalysisJob): boolean {
    return current?.status === "running" && current.owner === this.ownerId && current.attemptId === claim.attemptId && current.runId === claim.runId;
  }
  private owns(current: AnalysisJob | undefined, claim: AnalysisJob): boolean {
    return this.matches(current, claim) && (current?.leaseUntil ?? 0) > this.now();
  }
  private async event(job: AnalysisJob): Promise<void> {
    await this.database.jobEvents.add({ jobId: job.id, runId: job.runId ?? `legacy:${job.id}`,
      at: this.now(), status: job.status, errorCode: job.errorCode ?? null, message: job.error });
  }

  async enqueue(id: string, priority = 0): Promise<void> {
    const prior = await this.database.jobs.get(id);
    return this.enqueueJob(id, prior?.trackId ?? id, prior?.phase ?? "analysis", prior?.stemOptions, priority);
  }

  async enqueueStems(trackId: string, options: NonNullable<AnalysisJob["stemOptions"]>): Promise<void> {
    return this.enqueueJob(`stems:${trackId}`, trackId, "stems", options, 0);
  }

  private async enqueueJob(id: string, trackId: string, phase: "analysis" | "stems", stemOptions: AnalysisJob["stemOptions"], priority: number): Promise<void> {
    if (!Number.isFinite(priority)) throw new Error("Invalid job priority");
    await this.database.transaction("rw", this.database.tracks, this.database.jobs, this.database.jobEvents, async () => {
      if (!(await this.database.tracks.get(trackId))) throw new Error("Track no longer exists");
      const prior = await this.database.jobs.get(id);
      if (prior?.status === "running" || prior?.status === "queued") return;
      if (prior?.remoteCancelPending) throw new Error("Waiting for the stem service to acknowledge cancellation");
      const now = this.now();
      const job: AnalysisJob = { id, trackId, phase, stemOptions, runId: crypto.randomUUID(), status: "queued", priority,
        queuedAt: now, updatedAt: now, attempts: 0, maxAttempts: this.maxAttempts, nextAttemptAt: now,
        owner: null, attemptId: null, leaseUntil: null, lastHeartbeatAt: null, startedAt: null, completedAt: null,
        error: null, errorCode: null, stage: "queued", progress: 0 };
      await this.database.jobs.put(job); await this.event(job);
      if (phase === "analysis") await this.database.tracks.update(trackId, { analysisError: null });
    });
    this.notify(); this.kick();
  }

  async cancel(id: string): Promise<void> {
    const runId = await this.database.transaction("rw", this.database.jobs, this.database.jobEvents, async () => {
      const job = await this.database.jobs.get(id);
      if (!job || (job.status !== "queued" && job.status !== "running")) return null;
      Object.assign(job, { remoteCancelPending: job.phase === "stems", status: "cancelled", stage: "cancelled", error: null, errorCode: "cancelled",
        owner: null, attemptId: null, leaseUntil: null, updatedAt: this.now(), completedAt: this.now() });
      await this.database.jobs.put(job); await this.event(job);
      return job.runId;
    });
    if (this.active?.job.id === id && this.active.job.runId === runId) {
      this.active.abort(new JobError("cancelled", "Analysis cancelled")); this.active.task.cancel();
    }
    this.notify();
  }

  async dispose(): Promise<void> {
    this.stopped = true; this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.active) { this.active.abort(new JobError("cancelled", "Scheduler closed")); this.active.task.cancel(); }
    await this.inFlight;
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processNext().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async flushCancellations(): Promise<void> {
    if (!this.options.cancelRemote || this.now() < this.nextCancellationCheck) return;
    this.nextCancellationCheck = this.now() + 5000;
    const pending = (await this.database.jobs.where("status").equals("cancelled").toArray()).filter(job => job.remoteCancelPending);
    for (const job of pending) {
      try {
        await this.options.cancelRemote(job);
        await this.database.transaction("rw", this.database.jobs, async () => {
          const current = await this.database.jobs.get(job.id);
          if (current?.runId === job.runId) await this.database.jobs.update(job.id, { remoteCancelPending: false });
        });
      } catch { /* Keep the durable tombstone and retry when the service returns. */ }
    }
  }

  private async claim(): Promise<AnalysisJob | undefined> {
    return this.database.transaction("rw", this.database.jobs, this.database.jobEvents, this.database.tracks, async () => {
      const now = this.now();
      // Live leases are never reclaimed, including when another window starts.
      const running = await this.database.jobs.where("status").equals("running").toArray();
      for (const job of running) {
        if (job.phase === "stems" && !this.options.stemRunner) continue;
        if ((job.leaseUntil ?? 0) > now) continue;
        const exhausted = job.attempts >= (job.maxAttempts ?? this.maxAttempts);
        Object.assign(job, { status: exhausted ? "failed" : "queued", stage: exhausted ? "failed" : "recovered",
          owner: null, attemptId: null, leaseUntil: null, nextAttemptAt: now, updatedAt: now,
          errorCode: "lease_expired", error: exhausted ? "Interrupted analysis exhausted its retry limit" : "Recovered interrupted analysis" });
        await this.database.jobs.put(job); await this.event(job);
        if (exhausted && job.phase !== "stems") await this.database.tracks.update(job.trackId ?? job.id, { analysisError: job.error });
      }
      const queued = (await this.database.jobs.where("status").equals("queued").toArray())
        .filter(job => (job.nextAttemptAt ?? 0) <= now && (job.phase !== "stems" || this.options.stemRunner));
      queued.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
      if (this.stopped) return;
      for (const job of queued) {
        if (job.attempts >= (job.maxAttempts ?? this.maxAttempts)) {
          Object.assign(job, { status: "failed", stage: "failed", error: "Analysis retry limit reached", errorCode: "retry_limit", updatedAt: now });
          job.completedAt = now;
          await this.database.jobs.put(job); await this.event(job);
          if (job.phase !== "stems") await this.database.tracks.update(job.trackId ?? job.id, { analysisError: job.error }); continue;
        }
        Object.assign(job, { status: "running", stage: "starting", progress: 0, owner: this.ownerId,
          attemptId: crypto.randomUUID(), runId: job.runId ?? crypto.randomUUID(), maxAttempts: job.maxAttempts ?? this.maxAttempts,
          attempts: job.attempts + 1, leaseUntil: now + this.leaseMs, lastHeartbeatAt: now, startedAt: now,
          updatedAt: now, completedAt: null, error: null, errorCode: null });
        await this.database.jobs.put(job); await this.event(job); return job;
      }
    });
  }

  private async release(job: AnalysisJob): Promise<void> {
    await this.database.transaction("rw", this.database.jobs, this.database.jobEvents, async () => {
      const current = await this.database.jobs.get(job.id);
      if (!this.matches(current, job)) return;
      Object.assign(current!, { status: "queued", stage: "interrupted", owner: null, attemptId: null, leaseUntil: null,
        nextAttemptAt: this.now(), updatedAt: this.now(), errorCode: "interrupted", error: "Application closed during analysis" });
      await this.database.jobs.put(current!); await this.event(current!);
    });
  }

  private async processNext(): Promise<void> {
    let job: AnalysisJob | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatBusy = false;
    try {
      await this.flushCancellations();
      job = await this.claim();
      if (!job) return;
      if (this.stopped) return;
      const claim = job;
      const track = await this.database.tracks.get(job.trackId ?? job.id);
      if (!track) { await this.database.jobs.delete(job.id); return; }
      if (!this.owns(await this.database.jobs.get(job.id), claim) || this.stopped) return;
      let latest = { stage: "decoding", progress: 0 };
      let abort: (error: Error) => void = () => {};
      const interrupted = new Promise<never>((_, reject) => { abort = reject; });
      const onProgress = (stage: string, value: number) => {
        if (this.stopped || this.active?.job.attemptId !== claim.attemptId) return;
        latest = { stage, progress: Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) };
        this.progress(claim.id, stage, latest.progress);
      };
      const task = job.phase === "stems" ? this.options.stemRunner!(track, onProgress, job) : this.runner(track, onProgress);
      this.active = { job: claim, task, abort }; this.notify();
      log.info("job started", { jobId: claim.id, phase: claim.phase ?? "analysis", attempt: claim.attempts });
      const renew = async () => {
        if (heartbeatBusy || this.stopped) return;
        heartbeatBusy = true;
        try {
          const renewed = await this.database.transaction("rw", this.database.jobs, async () => {
            const current = await this.database.jobs.get(claim.id);
            if (!this.owns(current, claim)) return false;
            await this.database.jobs.update(claim.id, { leaseUntil: this.now() + this.leaseMs,
              lastHeartbeatAt: this.now(), updatedAt: this.now(), ...latest });
            return true;
          });
          if (!renewed) { abort(new JobError("lease_lost", "Job cancelled or lease lost")); task.cancel(); }
        } catch (error) { abort(new JobError("storage", String(error))); task.cancel(); }
        finally { heartbeatBusy = false; }
      };
      heartbeat = setInterval(() => { void renew(); }, this.heartbeatMs);
      deadline = setTimeout(() => { abort(new JobError("timeout", "Analysis timed out")); task.cancel(); }, job.phase === "stems" ? (this.options.stemTimeoutMs ?? 3_600_000) : this.timeoutMs);
      const result = await Promise.race([task.result, interrupted]);
      if (this.stopped) return;
      await this.database.transaction("rw", this.database.jobs, this.database.jobEvents, this.database.tracks, this.database.analysisHistory, this.database.stemCache, async () => {
        const current = await this.database.jobs.get(claim.id);
        if (!this.owns(current, claim)) return;
        if (claim.phase === "stems") {
          const entry = result as StemCacheEntry;
          const previous = await this.database.stemCache.get(entry.id);
          const entries = (await this.database.stemCache.toArray()).filter(cached => cached.id !== entry.id);
          const eviction = planEviction([...entries, { ...entry, pinned: true }], DEFAULT_CACHE_LIMIT_BYTES);
          if (eviction.blockedByPins) throw new JobError("storage", "Stem cache is full; remove old results or unpin entries, then retry");
          await this.database.stemCache.bulkDelete(eviction.remove.map(cached => cached.id));
          await this.database.stemCache.put({ ...entry, pinned: previous?.pinned ?? false });
        } else await persistAnalysis(this.database, claim.trackId ?? claim.id, result as AnalysisResult, claim.attemptId!);
        Object.assign(current!, { status: "done", stage: "done", progress: 1, error: null, errorCode: null,
          owner: null, attemptId: null, leaseUntil: null, updatedAt: this.now(), completedAt: this.now() });
        await this.database.jobs.put(current!); await this.event(current!);
      });
    } catch (error) {
      if (!job) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof JobError ? error.code : undefined;
      if (code === "cancelled") log.info("job cancelled", { jobId: job.id, phase: job.phase ?? "analysis" });
      else log.error("job failed", { jobId: job.id, phase: job.phase ?? "analysis", error: message, code: code ?? null });
      if (!this.stopped) {
        const claim = job; const failure = classifyJobError(error);
        await this.database.transaction("rw", this.database.jobs, this.database.jobEvents, this.database.tracks, async () => {
          const current = await this.database.jobs.get(claim.id);
          if (!this.owns(current, claim)) return;
          const retry = failure.retryable && current!.attempts < (current!.maxAttempts ?? this.maxAttempts);
          const delay = Math.min(30_000, this.retryBaseMs * 2 ** Math.max(0, current!.attempts - 1));
          Object.assign(current!, { status: retry ? "queued" : "failed", stage: retry ? "retry waiting" : "failed",
            error: failure.message, errorCode: failure.code, owner: null, attemptId: null, leaseUntil: null,
            updatedAt: this.now(), nextAttemptAt: this.now() + delay, completedAt: retry ? null : this.now() });
          await this.database.jobs.put(current!); await this.event(current!);
          if (claim.phase !== "stems") await this.database.tracks.update(claim.trackId ?? claim.id, { analysisError: retry ? null : failure.message });
        });
      }
    } finally {
      clearTimeout(deadline); clearInterval(heartbeat);
      this.active?.task.cancel(); this.active = null;
      if (job && this.stopped) await this.release(job);
      if (job && !this.stopped) this.notify();
    }
  }
}
