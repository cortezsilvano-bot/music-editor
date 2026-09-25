import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, totalmem, cpus } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "music-editor-benchmark-"));
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const bundle = await build({ entryPoints: ["bench/library-scale.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  page.on("console", event => { if (event.text().startsWith("LIBRARY_BENCHMARK")) console.log(event.text()); });
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(() => globalThis.runLibraryBenchmark());
  const report = { date: new Date().toISOString(), runtime: await app.evaluate(() => process.versions), totalMemoryBytes: totalmem(), cpu: cpus()[0]?.model, results };
  await mkdir("../docs/benchmarks", { recursive: true });
  await writeFile("../docs/benchmarks/library-scale-optimized.json", JSON.stringify(report, null, 2) + "\n");
  console.log("Saved docs/benchmarks/library-scale-optimized.json");
} finally { await app.close(); }
