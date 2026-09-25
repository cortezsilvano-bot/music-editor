import { _electron as electron } from "playwright-core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const dir = await mkdtemp(path.join(tmpdir(), "music-editor-smoke-"));
const rate = 22050, frames = rate * 12;
const wav = Buffer.alloc(44 + frames * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) {
  const beat = (i / rate) % 0.5;
  const signal = 0.5 * Math.sin(2 * Math.PI * 80 * beat) * Math.exp(-beat * 40) + 0.1 * Math.sin(2 * Math.PI * 440 * i / rate);
  wav.writeInt16LE(Math.round(signal * 32767), 44 + i * 2);
}
const fixture = path.join(dir, "smoke.wav"); await writeFile(fixture, wav);
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(dir, "profile") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
const errors = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.testContexts = []; window.testSources = [];
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.testContexts.push(this); }
      createBufferSource() {
        const source = super.createBufferSource();
        const record = { stopped: false }; window.testSources.push(record);
        const stop = source.stop.bind(source);
        source.stop = (...args) => { record.stopped = true; return stop(...args); };
        return source;
      }
    };
  });
  await page.reload();
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await page.getByText("LUFS", { exact: false }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".library .row").count(), 1);
  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("music-editor"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tracks = await new Promise((resolve, reject) => { const r = db.transaction("tracks").objectStore("tracks").getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const bytes = await tracks[0].audio.arrayBuffer(); db.close();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { length: bytes.byteLength, hash: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join(""), version: tracks[0].analysisVersion };
  });
  assert.equal(stored.length, wav.length); assert.equal(stored.hash, createHash("sha256").update(wav).digest("hex"));
  await page.reload(); await page.locator(".library .row").first().click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForTimeout(1500);
  const sourceCount = await page.evaluate(() => window.testSources.length);
  await page.getByPlaceholder("set BPM").fill("100");
  await page.getByPlaceholder("set BPM").press("Enter");
  await page.getByText("100.0 BPM", { exact: false }).first().waitFor();
  assert.ok(await page.getByRole("button", { name: "Pause", exact: true }).isVisible());
  assert.equal(await page.evaluate(() => window.testSources.length), sourceCount);
  assert.equal(await page.evaluate(() => window.testSources.at(-1).stopped), false);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Cue name", { exact: true }).fill("Test & cue");
  await page.getByRole("button", { name: "Add cue at playhead", exact: true }).click();
  await page.getByRole("button", { name: /Test & cue -/ }).waitFor();
  await page.locator('input[type="file"]').first().setInputFiles(fixture);
  await page.getByRole("alert").filter({ hasText: "Skipped exact duplicate" }).waitFor();
  assert.equal(await page.locator(".library .row").count(), 1);
  // Export is gated on review state — clear review before downloading XML.
  const markReviewed = page.getByRole("button", { name: "Mark reviewed", exact: true });
  if (await markReviewed.count()) await markReviewed.click();
  await page.getByLabel("Export audio folder", { exact: true }).fill("F:/Music");
  const exportPath = path.join(dir, "export.xml");
  await app.evaluate(({ session }, exportPath) => {
    globalThis.smokeDownload = "waiting";
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(exportPath);
      item.once("done", (_e, state) => { globalThis.smokeDownload = state; });
    });
  }, exportPath);
  await page.getByRole("button", { name: "Rekordbox XML", exact: true }).click();
  for (let i = 0; i < 100; i++) {
    if (await app.evaluate(() => globalThis.smokeDownload) === "completed") break;
    await page.waitForTimeout(100);
  }
  assert.equal(await app.evaluate(() => globalThis.smokeDownload), "completed");
  const xml = await readFile(exportPath, "utf8");
  assert.match(xml, /Test &amp; cue/); assert.match(xml, /AverageBpm="100.00"/);
  // Restore a historical analysis shape, then confirm it renders and can be repaired.
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open("music-editor"); request.onsuccess = () => resolve(request.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readwrite"); const store = tx.objectStore("tracks");
      const request = store.getAll(); request.onsuccess = () => {
        const track = request.result[0]; delete track.analysis.energy; delete track.analysis.loudness;
        track.analysisVersion = 1; track.analysis.analysisVersion = 1; store.put(track);
      }; tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  });
  await page.reload(); await page.locator(".library .row").first().click();
  await page.getByText("Reanalyse to measure loudness", { exact: true }).waitFor();
  await page.getByText("Reanalyse to measure energy", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reanalyse", exact: true }).click();
  await page.getByText("LUFS", { exact: false }).waitFor({ timeout: 60000 });
  assert.ok(await page.getByRole("button", { name: /Test & cue -/ }).isVisible());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, audioBytes: stored.length, gridEditPreservedPlayback: true, cueExport: true, exactDuplicateSkipped: true, directory: dir }));
} finally { await app.close(); }
