/**
 * Optional supervised stem separation service.
 *
 * Spawns the uvicorn process from a resolved `server/` root. Demucs weights are
 * never bundled; the service falls back to DSP when torch/demucs are absent.
 * The app does not auto-start this on launch - Start is an explicit user action.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_PORT = 8787;
const DEFAULT_BASE = `http://127.0.0.1:${DEFAULT_PORT}`;
const OVERRIDE_FILE = "stem-server-root.txt";

/** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
let child = null;
let startedByUs = false;
let lastError = null;

/** Optional override so unit tests do not need to mock Electron. */
let userDataOverride = null;
/** In-memory override (also persisted under userData when available). */
let serverRootOverride = null;

function setUserDataPathForTests(dir) {
  userDataOverride = dir;
}

function userDataPath() {
  if (userDataOverride) return userDataOverride;
  try {
    const { app } = require("electron");
    return app.getPath("userData");
  } catch {
    return null;
  }
}

function overrideFilePath() {
  const base = userDataPath();
  return base ? path.join(base, OVERRIDE_FILE) : null;
}

function readPersistedOverride() {
  if (serverRootOverride) return serverRootOverride;
  const file = overrideFilePath();
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text || null;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    return null;
  }
}

/**
 * Resolve the stem server root.
 *
 * Order: (a) explicit override / MUSIC_EDITOR_SERVER_ROOT,
 * (b) process.resourcesPath/server when packaged,
 * (c) repo ../server relative to app/electron.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   isPackaged?: boolean,
 *   resourcesPath?: string,
 *   electronDir?: string,
 *   override?: string | null,
 * }} [opts]
 */
function resolveServerRoot(opts = {}) {
  const env = opts.env ?? process.env;
  const override =
    opts.override !== undefined ? opts.override : readPersistedOverride();
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  const fromEnv = env.MUSIC_EDITOR_SERVER_ROOT;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }

  let isPackaged = opts.isPackaged;
  if (isPackaged === undefined) {
    try {
      isPackaged = require("electron").app.isPackaged;
    } catch {
      isPackaged = false;
    }
  }
  const resourcesPath = opts.resourcesPath ?? process.resourcesPath;
  if (isPackaged && resourcesPath) {
    return path.join(resourcesPath, "server");
  }

  const electronDir = opts.electronDir ?? __dirname;
  return path.resolve(electronDir, "..", "..", "server");
}

function serverDir() {
  return resolveServerRoot();
}

function serverPresent(root = serverDir()) {
  return fs.existsSync(path.join(root, "app.py"));
}

/**
 * Remember a user-chosen server folder (must contain app.py).
 * Pass null/empty to clear the override.
 */
function setServerRoot(folder) {
  if (folder === null || folder === undefined || String(folder).trim() === "") {
    serverRootOverride = null;
    const file = overrideFilePath();
    if (file) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
    return { ok: true, serverRoot: resolveServerRoot(), cleared: true };
  }
  const resolved = path.resolve(String(folder).trim());
  if (!fs.existsSync(path.join(resolved, "app.py"))) {
    return {
      ok: false,
      error: `No app.py in ${resolved}. Choose the Music Editor server/ folder.`,
      serverRoot: resolveServerRoot(),
    };
  }
  serverRootOverride = resolved;
  const file = overrideFilePath();
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, resolved + "\n", "utf8");
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        serverRoot: resolved,
      };
    }
  }
  return { ok: true, serverRoot: resolved, cleared: false };
}

function pythonCommand() {
  return process.env.MUSIC_EDITOR_PYTHON || process.env.PYTHON || "python";
}

function isRunning() {
  return !!(child && child.exitCode === null && !child.killed);
}

function describeLayout(root) {
  const resolved = root ?? serverDir();
  return {
    serverRoot: resolved,
    serverPresent: serverPresent(resolved),
    python: pythonCommand(),
  };
}

async function probeHealth(base = DEFAULT_BASE) {
  const layout = describeLayout();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${base}/api/health`, { signal: controller.signal });
    if (!response.ok) {
      return {
        reachable: false,
        managed: isRunning(),
        error: `HTTP ${response.status}`,
        backend: null,
        model: null,
        jobProtocol: null,
        ...layout,
      };
    }
    const body = await response.json();
    return {
      reachable: true,
      managed: isRunning() || startedByUs,
      error: null,
      backend: body.backend ?? null,
      model: body.model ?? body.demucs_model ?? null,
      jobProtocol: body.jobProtocol ?? null,
      pid: child?.pid ?? null,
      ...layout,
    };
  } catch (error) {
    let message = lastError || (error instanceof Error ? error.message : "not running");
    if (!layout.serverPresent) {
      message =
        `Stem server not found at ${layout.serverRoot}. ` +
        "Set MUSIC_EDITOR_SERVER_ROOT, choose a server folder, or install from a package that includes resources/server.";
    }
    return {
      reachable: false,
      managed: isRunning(),
      error: message,
      backend: null,
      model: null,
      jobProtocol: null,
      pid: child?.pid ?? null,
      ...layout,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  const existing = await probeHealth();
  if (existing.reachable) {
    return { ok: true, alreadyRunning: true, ...existing };
  }
  if (isRunning()) {
    return { ok: true, alreadyRunning: true, ...(await probeHealth()) };
  }

  const cwd = serverDir();
  if (!serverPresent(cwd)) {
    return {
      ok: false,
      error:
        `Stem server not found at ${cwd}. ` +
        "Packaged builds ship server/ under resources (source + requirements only). " +
        "Install a system Python, run `pip install -r requirements.txt` in that folder, " +
        "or set MUSIC_EDITOR_SERVER_ROOT / Choose server folder.",
      serverRoot: cwd,
      serverPresent: false,
      python: pythonCommand(),
    };
  }

  lastError = null;
  const port = process.env.PORT || String(DEFAULT_PORT);
  const command = pythonCommand();
  try {
    child = spawn(command, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", port], {
      cwd,
      env: { ...process.env, PORT: port, STEM_BACKEND: process.env.STEM_BACKEND || "auto" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    child = null;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      serverRoot: cwd,
      serverPresent: true,
      python: command,
    };
  }

  startedByUs = true;
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (text.trim()) lastError = text.trim().slice(-500);
  });
  child.on("error", (error) => {
    lastError =
      lastError ||
      (error instanceof Error ? error.message : String(error)) ||
      `Failed to spawn ${command}. Install Python and pip install -r requirements.txt in ${cwd}.`;
  });
  child.on("exit", (code, signal) => {
    lastError = lastError || `Stem service exited (code=${code}, signal=${signal})`;
    if (code === 9009 || code === 127) {
      lastError =
        `Python not found (${command}). Install Python 3, then ` +
        `pip install -r "${path.join(cwd, "requirements.txt")}".`;
    }
    child = null;
    startedByUs = false;
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const health = await probeHealth();
    if (health.reachable) return { ok: true, alreadyRunning: false, ...health };
    if (!isRunning()) {
      return {
        ok: false,
        error:
          lastError ||
          `Stem service failed to start. Ensure Python can import uvicorn and dependencies from ${cwd}.`,
        serverRoot: cwd,
        serverPresent: true,
        python: command,
      };
    }
  }
  return {
    ok: false,
    error: lastError || "Stem service started but health check timed out.",
    serverRoot: cwd,
    serverPresent: true,
    python: command,
  };
}

async function stop() {
  if (!isRunning()) {
    startedByUs = false;
    child = null;
    return { ok: true, stopped: false, ...describeLayout() };
  }
  const current = child;
  child = null;
  startedByUs = false;
  try {
    current.kill();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ...describeLayout() };
  }
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, stopped: true, ...describeLayout() };
}

function stopSync() {
  if (child && !child.killed) {
    try { child.kill(); } catch { /* best-effort on quit */ }
  }
  child = null;
  startedByUs = false;
}

module.exports = {
  start,
  stop,
  stopSync,
  status: probeHealth,
  serverDir,
  resolveServerRoot,
  setServerRoot,
  serverPresent,
  setUserDataPathForTests,
  DEFAULT_BASE,
};
