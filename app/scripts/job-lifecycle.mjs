import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(path.join(tmpdir(), "music-editor-jobs-"));
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const bundle = await build({ entryPoints: ["bench/job-lifecycle.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
const name = `job-lifecycle-${Date.now()}`;
async function init(page) {
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page.evaluate(name => globalThis.jobLifecycle.init(name), name);
}
async function until(page, id, predicate) {
  const deadline = Date.now() + 15000;
  let state;
  while (Date.now() < deadline) {
    state = await page.evaluate(id => globalThis.jobLifecycle.state(id), id);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Job state did not settle: ${JSON.stringify(state)}`);
}
try {
  const first = await app.firstWindow(); await init(first);
  await first.evaluate(() => globalThis.jobLifecycle.enqueue("recover"));
  await until(first, "recover", state => state.calls === 1);
  await app.evaluate(async ({ BrowserWindow }) => {
    const second = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    await second.loadURL("app://local/index.html");
  });
  const second = (await app.windows()).find(page => page !== first);
  const secondOwner = await init(second);
  await second.waitForTimeout(750);
  assert.equal((await second.evaluate(() => globalThis.jobLifecycle.state("recover"))).calls, 0, "live lease must not be stolen");
  // Crash the renderer that owns the lease, leaving no opportunity for clean shutdown.
  const firstWindow = await app.browserWindow(first);
  await firstWindow.evaluate(window => window.webContents.forcefullyCrashRenderer());
  await until(second, "recover", ({ job, calls }) => job.owner === secondOwner && job.attempts === 2 && calls === 1);
  await second.evaluate(() => globalThis.jobLifecycle.resolve("recover"));
  await until(second, "recover", state => state.job.status === "done");
  const recovered = await second.evaluate(() => globalThis.jobLifecycle.state("recover"));
  assert.equal(recovered.historyCount, 1);
  assert.equal(recovered.track.manualBpm, 123);
  assert.equal(recovered.track.cues[0].name, "Preserved");
  await second.evaluate(() => globalThis.jobLifecycle.enqueue("cancel"));
  await until(second, "cancel", state => state.job.status === "running");
  const existing = await app.windows();
  await app.evaluate(async ({ BrowserWindow }) => {
    const peer = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } });
    await peer.loadURL("app://local/index.html");
  });
  const peer = (await app.windows()).find(page => !existing.includes(page));
  await init(peer);
  await peer.evaluate(() => globalThis.jobLifecycle.cancel("cancel"));
  await until(second, "cancel", state => state.cancellations >= 2);
  await peer.reload(); await init(peer);
  const cancelled = await peer.evaluate(() => globalThis.jobLifecycle.state("cancel"));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.historyCount, 0);
  assert.equal(cancelled.calls, 0);
  await Promise.all([peer, second].map(page => page.evaluate(() => globalThis.jobLifecycle.dispose())));
  console.log(JSON.stringify({ passed: true, liveLeasePreserved: true, rendererCrashRecovered: true,
    singleResultCommitted: true, crossWindowCancellation: true, cancellationSurvivesReload: true, directory }));
} finally { await app.close(); }
