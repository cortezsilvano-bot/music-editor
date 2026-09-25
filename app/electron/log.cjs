/**
 * Append-only renderer log sink with size-capped rotation.
 *
 * File: <userData>/logs/music-editor.log
 * When the active file exceeds maxBytes, it is renamed to music-editor.log.1
 * (replacing any previous backup) and a fresh log is started.
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const LOG_NAME = "music-editor.log";
const BACKUP_NAME = "music-editor.log.1";

/** Optional override so unit tests do not need to mock Electron. */
let userDataOverride = null;

function setUserDataPathForTests(dir) {
  userDataOverride = dir;
}

function userDataPath() {
  if (userDataOverride) return userDataOverride;
  // Lazy-require so tests can inject a path before Electron is touched.
  const { app } = require("electron");
  return app.getPath("userData");
}

function logsDir() {
  return path.join(userDataPath(), "logs");
}

function logPath() {
  return path.join(logsDir(), LOG_NAME);
}

function ensureDir() {
  fs.mkdirSync(logsDir(), { recursive: true });
}

function rotateIfNeeded() {
  ensureDir();
  const file = logPath();
  try {
    const stat = fs.statSync(file);
    if (stat.size < MAX_BYTES) return;
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  const backup = path.join(logsDir(), BACKUP_NAME);
  try { fs.rmSync(backup, { force: true }); } catch { /* ignore */ }
  fs.renameSync(file, backup);
}

function append(line) {
  if (typeof line !== "string" || line.length === 0) {
    return { ok: false, error: "empty log line" };
  }
  // Harden against runaway IPC: cap a single line.
  const text = line.length > 16_384 ? line.slice(0, 16_384) + "…[truncated]" : line;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logPath(), text.endsWith("\n") ? text : text + "\n", "utf8");
    return { ok: true, path: logPath() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function getPath() {
  ensureDir();
  return { ok: true, path: logPath(), dir: logsDir() };
}

async function openFolder() {
  try {
    ensureDir();
    const { shell } = require("electron");
    const result = await shell.openPath(logsDir());
    if (result) return { ok: false, error: result };
    return { ok: true, dir: logsDir() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  append,
  getPath,
  openFolder,
  logsDir,
  logPath,
  setUserDataPathForTests,
  MAX_BYTES,
  LOG_NAME,
};
