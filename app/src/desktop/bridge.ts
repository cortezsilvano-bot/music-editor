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

interface DesktopApi {
  version: string;
  pickFolder(): Promise<string | null>;
  scanFolder(
    folderPath: string,
  ): Promise<{ ok: true; root: string; files: ScannedFile[] } | { ok: false; error: string }>;
  readFile(filePath: string): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }>;
  writeTags(filePath: string, payload: TagWritePayload): Promise<TagWriteResult>;
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

export async function scanFolder(folderPath: string) {
  if (!isDesktop()) return unavailable();
  return window.desktop!.scanFolder(folderPath);
}

export async function readFile(filePath: string) {
  if (!isDesktop()) return unavailable();
  return window.desktop!.readFile(filePath);
}

export async function writeTags(
  filePath: string,
  payload: TagWritePayload,
): Promise<TagWriteResult> {
  if (!isDesktop()) return unavailable();
  return window.desktop!.writeTags(filePath, payload);
}
