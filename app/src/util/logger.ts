/**
 * Small structured logger for renderer and shared modules.
 *
 * Emits a single tagged line per event so Electron DevTools and terminal
 * captures stay searchable. Levels default to "info"; debug is silent unless
 * `music-editor.logLevel` is set to "debug" (JSON string, same as useSetting).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

/** localStorage key without the music-editor. prefix used by useSetting. */
export const LOG_LEVEL_SETTING_KEY = "logLevel";

/** Full localStorage key the logger reads (matches useSetting("logLevel", ...)). */
export const LOG_LEVEL_STORAGE_KEY = `music-editor.${LOG_LEVEL_SETTING_KEY}`;

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** localStorage key for file logging toggle (JSON boolean via useSetting). */
export const FILE_LOG_SETTING_KEY = "fileLogEnabled";

/** Full localStorage key for the file-log toggle. */
export const FILE_LOG_STORAGE_KEY = `music-editor.${FILE_LOG_SETTING_KEY}`;

/** Default ON in Electron, OFF in the browser. */
export function defaultFileLogEnabled(): boolean {
  return typeof window !== "undefined" && typeof window.desktop?.appendLog === "function";
}

/** Read whether file logging is enabled. */
export function getFileLogEnabled(): boolean {
  try {
    const raw = localStorage.getItem(FILE_LOG_STORAGE_KEY);
    if (raw === null) return defaultFileLogEnabled();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed;
  } catch {
    /* Storage may be unavailable. */
  }
  return defaultFileLogEnabled();
}

/** Persist file-log toggle (JSON boolean, same shape as useSetting). */
export function setFileLogEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(FILE_LOG_STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    /* Storage may be unavailable. */
  }
}


const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

/** Read the persisted log level; defaults to info. */
export function getLogLevel(): LogLevel {
  try {
    const raw = localStorage.getItem(LOG_LEVEL_STORAGE_KEY);
    if (!raw) return "info";
    const parsed: unknown = JSON.parse(raw);
    if (isLogLevel(parsed)) return parsed;
  } catch {
    /* localStorage may be unavailable in workers/tests. */
  }
  return "info";
}

/** Persist log level (JSON string, same shape as useSetting). */
export function setLogLevel(level: LogLevel): void {
  try {
    localStorage.setItem(LOG_LEVEL_STORAGE_KEY, JSON.stringify(level));
  } catch {
    /* Storage may be unavailable. */
  }
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[getLogLevel()]) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...fields,
  };
  const line = `[music-editor] ${JSON.stringify(payload)}`;
  if (level === "error") console.error(line);
  else console.warn(line);
  if (getFileLogEnabled()) {
    const append = typeof window !== "undefined" ? window.desktop?.appendLog : undefined;
    if (typeof append === "function") {
      void append(line).catch(() => {
        /* File sink must never break console logging. */
      });
    }
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: LogFields) => emit("debug", scope, message, fields),
    info: (message: string, fields?: LogFields) => emit("info", scope, message, fields),
    warn: (message: string, fields?: LogFields) => emit("warn", scope, message, fields),
    error: (message: string, fields?: LogFields) => emit("error", scope, message, fields),
  };
}
