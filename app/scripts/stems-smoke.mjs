import { _electron as electron } from "playwright-core";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const directory = await mkdtemp(path.join(tmpdir(), "music-editor-stems-smoke-"));
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const service = spawn("python", ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: path.resolve("../server"), windowsHide: true,
  env: { ...process.env, JOBS_DIR: path.join(directory, "server-jobs"), STEM_BACKEND: "dsp" }, stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(service, "exit");
let logs = ""; service.stdout.on("data", chunk => { logs = (logs + chunk).slice(-4000); }); service.stderr.on("data", chunk => { logs = (logs + chunk).slice(-4000); });
let app;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch { /* Wait for startup. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs);
  const rate = 22050, frames = rate * 4, wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
  for (let n = 0; n < frames; n++) wav.writeInt16LE(Math.round(8000 * Math.sin(n * 2 * Math.PI * 220 / rate)), 44 + n * 2);
  const fixture = path.join(directory, "stems.wav"); await writeFile(fixture, wav);
  const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
  // Route the fixed localhost endpoint to this test's isolated service/port.
  await app.context().route("http://localhost:8787/**", async route => {
    try {
      const response = await route.fetch({ url: route.request().url().replace("http://localhost:8787", base) });
      const body = (response.headers()["content-type"] ?? "").includes("json") ?
        (await response.text()).replaceAll(base, "http://localhost:8787") : await response.body();
      await route.fulfill({ response, body });
    } catch { await route.fulfill({ status: 503, body: "Isolated service is offline", headers: { "access-control-allow-origin": "*" } }); }
  });
  const page = await app.firstWindow(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await page.getByText("LUFS", { exact: false }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Separate", exact: true }).click();
  await page.getByText(/^Cached /).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("audio").count(), 4);
  const cached = await page.evaluate(async () => {
    const database = await new Promise(resolve => { const request = indexedDB.open("music-editor"); request.onsuccess = () => resolve(request.result); });
    const rows = await new Promise(resolve => { const request = database.transaction("stemCache").objectStore("stemCache").getAll(); request.onsuccess = () => resolve(request.result); });
    database.close(); return { count: rows.length, sourceHash: rows[0].sourceHash, modelVersion: rows[0].modelVersion, serverJobId: rows[0].serverJobId };
  });
  assert.equal(cached.count, 1); assert.equal(cached.sourceHash, createHash("sha256").update(wav).digest("hex"));
  assert.equal(cached.modelVersion, "1"); assert.ok(cached.serverJobId);
  await page.getByRole("button", { name: "Solo lead-vocals", exact: true }).click();
  assert.equal(await page.locator("audio").evaluateAll(elements => elements.filter(element => element.muted).length), 3);
  service.kill(); await exited;
  await page.reload(); await page.locator(".library .row").first().click();
  await page.getByText(/^Cached /).waitFor();
  assert.equal(await page.locator("audio").count(), 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, realDspSeparation: true, sharedQueueCommit: true, sourceHashVerified: true,
    cachedStemsReopenWithServiceOffline: true, soloControls: true, directory }));
} finally {
  if (app) await app.close();
  if (service.exitCode === null && service.signalCode === null) { service.kill(); await exited; }
}
