/**
 * Typed access to the desktop bridge.
 *
 * `window.desktop` exists only in the Electron build. Everything here returns a
 * clear "not available" result in a browser rather than throwing, so the same
 * components run in both and simply offer less on the web.
 */

export interface ScannedFile {
  path: string;
  /** Path relative to the chosen folder, POSIX separators. */
  relativePath: string;
  name: string;
  sizeBytes: number;
}

export interface TagWritePayload {
  bpm?: string;
  initialKey?: string;
  comment?: string;
}

export interface TagWriteResult {
  ok: boolean;
  error?: string;
  backupPath?: string;
  backupCreated?: boolean;
  written?: string[];
}

export interface PathStatusResult {
  ok: boolean;
  exists?: boolean;
  sizeBytes?: number;
  error?: string;
}

export interface StemsServiceStatus {
  ok?: boolean;
  reachable: boolean;
  managed?: boolean;
  alreadyRunning?: boolean;
  stopped?: boolean;
  error?: string | null;
  backend?: string | null;
  model?: string | null;
  jobProtocol?: number | null;
  pid?: number | null;
  serverRoot?: string | null;
  serverPresent?: boolean;
  python?: string | null;
  cancelled?: boolean;
  cleared?: boolean;
}

interface DesktopApi {
  version: string;
  pickFolder(): Promise<string | null>;
  pickAudioFile(): Promise<string | null>;
  scanFolder(
    folderPath: string,
  ): Promise<{ ok: true; root: string; files: ScannedFile[] } | { ok: false; error: string }>;
  readFile(filePath: string): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>;
  pathStatus(filePath: string): Promise<PathStatusResult>;
  writeTags(filePath: string, payload: TagWritePayload): Promise<TagWriteResult>;
  startStemsService(): Promise<StemsServiceStatus>;
  stopStemsService(): Promise<StemsServiceStatus>;
  stemsServiceStatus(): Promise<StemsServiceStatus>;
  pickStemsServerRoot(): Promise<StemsServiceStatus>;
  setStemsServerRoot(folderPath: string | null): Promise<StemsServiceStatus>;
  appendLog(line: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  logPath(): Promise<{ ok: boolean; path?: string; dir?: string; error?: string }>;
  openLogFolder(): Promise<{ ok: boolean; dir?: string; error?: string }>;
}

export interface LogPathResult {
  ok: boolean;
  path?: string;
  dir?: string;
  error?: string;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

/** True in the Electron build, false in a browser tab. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.desktop?.pickFolder === "function";
}

function unavailable(): { ok: false; error: string } {
  return {
    ok: false,
    error: "This needs the desktop app - a browser cannot reach your filesystem.",
  };
}

export async function pickFolder(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.desktop!.pickFolder();
}

export async function pickAudioFile(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.desktop!.pickAudioFile();
}

export async function scanFolder(folderPath: string) {
  if (!isDesktop()) return unavailable();
  return window.desktop!.scanFolder(folderPath);
}

export async function readFile(filePath: string) {
  if (!isDesktop()) return unavailable();
  return window.desktop!.readFile(filePath);
}

export async function pathStatus(filePath: string): Promise<PathStatusResult> {
  if (!isDesktop()) return unavailable();
  return window.desktop!.pathStatus(filePath);
}

export async function writeTags(
  filePath: string,
  payload: TagWritePayload,
): Promise<TagWriteResult> {
  if (!isDesktop()) return unavailable();
  return window.desktop!.writeTags(filePath, payload);
}

export async function startStemsService(): Promise<StemsServiceStatus> {
  if (!isDesktop() || typeof window.desktop?.startStemsService !== "function") {
    return { reachable: false, error: unavailable().error };
  }
  return window.desktop.startStemsService();
}

export async function stopStemsService(): Promise<StemsServiceStatus> {
  if (!isDesktop() || typeof window.desktop?.stopStemsService !== "function") {
    return { reachable: false, error: unavailable().error };
  }
  return window.desktop.stopStemsService();
}

export async function stemsServiceStatus(): Promise<StemsServiceStatus> {
  if (!isDesktop() || typeof window.desktop?.stemsServiceStatus !== "function") {
    return { reachable: false, error: unavailable().error };
  }
  return window.desktop.stemsServiceStatus();
}

export async function pickStemsServerRoot(): Promise<StemsServiceStatus> {
  if (!isDesktop() || typeof window.desktop?.pickStemsServerRoot !== "function") {
    return { ok: false, reachable: false, error: unavailable().error };
  }
  return window.desktop.pickStemsServerRoot();
}

export async function setStemsServerRoot(folderPath: string | null): Promise<StemsServiceStatus> {
  if (!isDesktop() || typeof window.desktop?.setStemsServerRoot !== "function") {
    return { ok: false, reachable: false, error: unavailable().error };
  }
  return window.desktop.setStemsServerRoot(folderPath);
}

export async function appendLog(line: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!isDesktop() || typeof window.desktop?.appendLog !== "function") {
    return { ok: false, error: unavailable().error };
  }
  return window.desktop.appendLog(line);
}

export async function logPath(): Promise<LogPathResult> {
  if (!isDesktop() || typeof window.desktop?.logPath !== "function") {
    return { ok: false, error: unavailable().error };
  }
  // A missing handler (older main process, test harness) must degrade to "not
  // available", not surface as an uncaught rejection in the renderer.
  try {
    return await window.desktop.logPath();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openLogFolder(): Promise<LogPathResult> {
  if (!isDesktop() || typeof window.desktop?.openLogFolder !== "function") {
    return { ok: false, error: unavailable().error };
  }
  return window.desktop.openLogFolder();
}
