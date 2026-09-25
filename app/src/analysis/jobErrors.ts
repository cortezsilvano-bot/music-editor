export type JobErrorCode = "cancelled" | "lease_lost" | "worker_crash" | "worker_message" | "timeout" | "decode" | "analysis" | "storage" | "service_unavailable" | "separation";
export class JobError extends Error {
  constructor(public readonly code: JobErrorCode, message: string) { super(message); this.name = "JobError"; }
}
export function classifyJobError(error: unknown): { code: JobErrorCode; message: string; retryable: boolean } {
  const code = error instanceof JobError ? error.code : "analysis";
  return { code, message: error instanceof Error ? error.message : String(error),
    retryable: code === "worker_crash" || code === "worker_message" || code === "timeout" || code === "service_unavailable" };
}
