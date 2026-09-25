import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(path.join(tmpdir(), "music-editor-catalog-smoke-"));
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const bundle = await build({ stdin: { contents: `
  import { db } from './src/db/library';
  import { EMPTY_TAGS } from './src/metadata/tags';
  import { analyze } from './src/analysis/pipeline';
  globalThis.seedCatalogSmoke = async () => {
    const analysis = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
    const wav = new ArrayBuffer(44 + 22050 * 2), view = new DataView(wav);
    const text = (at, str) => [...str].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 22050, true); view.setUint32(28, 44100, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, wav.byteLength - 44, true);
    await db.tracks.bulkAdd(Array.from({ length: 205 }, (_, n) => ({
      id: 'catalog-' + n, name: 'Catalog song ' + n, audio: new Blob([wav], { type: 'audio/wav' }),
      peaks: new Float32Array(2000).buffer, mimeType: 'audio/wav', sizeBytes: wav.byteLength, durationSec: 1, addedAt: n,
      tags: { ...EMPTY_TAGS }, analysis, analysisVersion: analysis.analysisVersion, analysisError: null,
      manualBpm: null, manualGrid: null, manualKeyTonic: null, manualKeyMode: null, reviewedAt: Date.now()
    })));
  };`, resolveDir: process.cwd() }, bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
try {
  const page = await app.firstWindow(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => globalThis.seedCatalogSmoke());
  await page.getByText("1-100 of 205 matches", { exact: true }).waitFor();
  assert.equal(await page.locator(".library .row").count(), 100);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText("101-200 of 205 matches", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText("201-205 of 205 matches", { exact: true }).waitFor();
  assert.equal(await page.locator(".library .row").count(), 5);
  await page.getByLabel("Search library", { exact: true }).fill("Catalog song 204");
  await page.getByText("1-1 of 1 matches", { exact: true }).waitFor();
  await page.locator(".library .row").first().click();
  await page.getByRole("heading", { name: "Catalog song 204", exact: true }).waitFor();
  await page.getByPlaceholder("set BPM").fill("123"); await page.getByPlaceholder("set BPM").press("Enter");
  await page.locator(".library .row").filter({ hasText: "123.0 BPM" }).waitFor();
  await page.getByLabel("Search library", { exact: true }).fill("Catalog song");
  await page.getByText("1-100 of 205 matches", { exact: true }).waitFor();
  const markReviewed = page.getByRole("button", { name: "Mark reviewed", exact: true });
  if (await markReviewed.count()) await markReviewed.click();
  await page.getByLabel("Export audio folder", { exact: true }).fill("F:/Music");
  const exportPath = path.join(directory, "all-matching.xml");
  await app.evaluate(({ session }, exportPath) => {
    globalThis.catalogDownload = "waiting";
    session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(exportPath); item.once("done", (_e, state) => { globalThis.catalogDownload = state; });
    });
  }, exportPath);
  await page.getByRole("button", { name: "Rekordbox XML", exact: true }).click();
  for (let i = 0; i < 100 && await app.evaluate(() => globalThis.catalogDownload) !== "completed"; i++) await page.waitForTimeout(100);
  assert.equal(await app.evaluate(() => globalThis.catalogDownload), "completed");
  const xml = await readFile(exportPath, "utf8");
  assert.match(xml, /COLLECTION Entries="205"/);
  await page.getByRole("button", { name: "Mix", exact: true }).click();
  await page.getByLabel("Search deck A tracks", { exact: true }).fill("Catalog song 204");
  await page.getByLabel("Load deck A", { exact: true }).selectOption("catalog-204");
  await page.locator(".deck").first().locator("span.value").filter({ hasText: /^Catalog song 204$/ }).waitFor();
  await page.locator(".deck").first().getByText("123.00 BPM", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, paginatedTracks: 205, globalSearch: true, editUpdatesCatalog: true, exportedMatches: 205, lazyDeckLoad: true, directory }));
} catch (error) {
  const page = await app.firstWindow();
  console.error((await page.locator("body").innerText()).slice(0, 2500));
  throw error;
} finally { await app.close(); }
