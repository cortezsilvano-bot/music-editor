/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  defaultFileLogEnabled,
  FILE_LOG_STORAGE_KEY,
  getFileLogEnabled,
  getLogLevel,
  isLogLevel,
  LOG_LEVEL_STORAGE_KEY,
  setFileLogEnabled,
  setLogLevel,
} from "./logger";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("emits tagged JSON through console.warn for info", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger("test").info("hello", { jobId: "j1" });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0][0]);
    expect(line.startsWith("[music-editor] ")).toBe(true);
    const payload = JSON.parse(line.slice("[music-editor] ".length)) as {
      level: string; scope: string; message: string; jobId: string;
    };
    expect(payload).toMatchObject({ level: "info", scope: "test", message: "hello", jobId: "j1" });
  });

  it("suppresses debug unless logLevel is debug", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger("test").debug("hidden");
    expect(spy).not.toHaveBeenCalled();
    localStorage.setItem(LOG_LEVEL_STORAGE_KEY, JSON.stringify("debug"));
    createLogger("test").debug("shown");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("routes errors through console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("sched").error("failed", { code: "timeout" });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('"level":"error"');
  });
});

describe("getLogLevel / setLogLevel", () => {
  it("defaults to info and round-trips", () => {
    expect(getLogLevel()).toBe("info");
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    expect(localStorage.getItem(LOG_LEVEL_STORAGE_KEY)).toBe(JSON.stringify("warn"));
  });

  it("isLogLevel accepts only known levels", () => {
    expect(isLogLevel("debug")).toBe(true);
    expect(isLogLevel("trace")).toBe(false);
  });
});

describe("file log sink", () => {
  it("defaults off in jsdom and appends when enabled with a desktop bridge", async () => {
    expect(defaultFileLogEnabled()).toBe(false);
    expect(getFileLogEnabled()).toBe(false);
    const appendLog = vi.fn<(line: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    (window as unknown as { desktop: { appendLog: typeof appendLog } }).desktop = { appendLog };
    setFileLogEnabled(true);
    expect(localStorage.getItem(FILE_LOG_STORAGE_KEY)).toBe(JSON.stringify(true));
    createLogger("sink").info("to-file", { n: 1 });
    expect(appendLog).toHaveBeenCalledOnce();
    const logged = appendLog.mock.calls[0]?.[0];
    expect(logged).toBeDefined();
    expect(String(logged)).toContain('"message":"to-file"');
    delete (window as unknown as { desktop?: unknown }).desktop;
  });
});
