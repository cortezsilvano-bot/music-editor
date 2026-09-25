/**
 * File log rotation smoke tests (main-process module).
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const log = require("./log.cjs");

describe("electron/log.cjs", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "me-log-"));
    log.setUserDataPathForTests(dir);
  });

  afterEach(() => {
    log.setUserDataPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends lines under userData/logs", () => {
    const first = log.append('{"level":"info","message":"hi"}');
    expect(first.ok).toBe(true);
    expect(existsSync(log.logPath())).toBe(true);
    expect(readFileSync(log.logPath(), "utf8")).toContain("hi");
    log.append('{"level":"warn","message":"bye"}');
    expect(readFileSync(log.logPath(), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("rotates when the active file exceeds the cap", () => {
    log.getPath(); // ensure logs/ exists
    const file = log.logPath();
    writeFileSync(file, "x".repeat(log.MAX_BYTES));
    expect(statSync(file).size).toBe(log.MAX_BYTES);
    expect(log.append("rotated-line").ok).toBe(true);
    expect(existsSync(path.join(log.logsDir(), "music-editor.log.1"))).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("rotated-line");
  });
});
