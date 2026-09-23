/**
 * Stem separation client (research Phase M).
 *
 * Separation runs in a separate Python process, not in the app. That is
 * deliberate and is what the brief asks for: Demucs needs PyTorch, which is
 * roughly twenty times the size of this whole application, and a model that
 * runs out of memory should take down a sidecar rather than the editor.
 *
 * The consequence is that the service may simply not be running, which is a
 * normal state rather than an error. Everything here reports that plainly so
 * the UI can say "start the service" instead of failing silently.
 *
 * The protocol is deliberately narrow and versioned by its URL, so the Python
 * process can later be replaced by ONNX or a native worker without the app
 * noticing.
 */

const DEFAULT_BASE = "http://localhost:8787";

export type StemType =
  | "lead-vocals"
  | "drums"
  | "bass"
  | "melody"
  | "instruments"
  | "uploaded";

export interface ServiceStatus {
  reachable: boolean;
  /** Which separation engine the service will actually use. */
  backend: "demucs" | "dsp" | null;
  model: string | null;
  /** Populated when the service is not reachable. */
  error: string | null;
}

export interface SeparatedStem {
  name: string;
  type: StemType;
  url: string;
}

export interface SeparationResult {
  job: string;
  backend: string;
  sampleRate: number;
  elapsedSeconds: number;
  stems: SeparatedStem[];
}

export interface SeparateOptions {
  /** "basic" gives four stems; "two" gives vocals plus an instrumental bed. */
  stems?: "basic" | "two";
  /** Demucs only. "high" is slower for a small quality gain. */
  quality?: "balanced" | "high";
  /** Force an engine rather than letting the service choose. */
  backend?: "demucs" | "dsp";
  signal?: AbortSignal;
}

export function stemServiceBase(): string {
  return DEFAULT_BASE;
}

/**
 * Ask whether the service is up.
 *
 * Short timeout: this runs when a panel opens, and a slow answer is
 * indistinguishable from "not running" as far as the user is concerned.
 */
export async function checkService(timeoutMs = 2000): Promise<ServiceStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEFAULT_BASE}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return { reachable: false, backend: null, model: null, error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as {
      backend?: string;
      demucs?: { model?: string };
    };
    return {
      reachable: true,
      backend: body.backend === "demucs" ? "demucs" : "dsp",
      model: body.demucs?.model ?? null,
      error: null,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return {
      reachable: false,
      backend: null,
      model: null,
      error: aborted
        ? "The separation service did not respond."
        : "The separation service is not running.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Separate a track.
 *
 * The service answers only when the whole job is finished, so there is no
 * progress to report - the UI shows elapsed time instead of a fake bar.
 * Cancellation aborts the request; the service finishes its job regardless, but
 * the app stops waiting and discards the result.
 */
export async function separate(
  audio: Blob,
  filename: string,
  options: SeparateOptions = {},
): Promise<SeparationResult> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append(
    "options",
    JSON.stringify({
      stems: options.stems ?? "basic",
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.backend ? { backend: options.backend } : {}),
    }),
  );

  const response = await fetch(`${DEFAULT_BASE}/api/studio/separate`, {
    method: "POST",
    body: form,
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Separation failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as SeparationResult;
}

/**
 * Fetch the rendered stems.
 *
 * They are downloaded immediately rather than left as URLs: the service deletes
 * a job after an hour, so a stored URL would break, and a stored Blob will not.
 */
export async function downloadStems(
  result: SeparationResult,
  signal?: AbortSignal,
): Promise<{ name: string; type: StemType; blob: Blob }[]> {
  const out: { name: string; type: StemType; blob: Blob }[] = [];
  for (const stem of result.stems) {
    const response = await fetch(stem.url, { signal });
    if (!response.ok) throw new Error(`Could not download ${stem.name}.`);
    out.push({ name: stem.name, type: stem.type, blob: await response.blob() });
  }
  return out;
}

/** Colour for a stem type, matching the editor's track palette. */
export function stemColour(type: StemType): string {
  switch (type) {
    case "lead-vocals":
      return "#ef4444";
    case "drums":
      return "#22c55e";
    case "bass":
      return "#14b8a6";
    case "melody":
      return "#06b6d4";
    case "instruments":
      return "#3b82f6";
    default:
      return "#a1a1aa";
  }
}
