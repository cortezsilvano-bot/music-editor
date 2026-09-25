import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, totalmem, cpus } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "music-editor-catalog-benchmark-"));
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const sizes = process.env.CATALOG_BENCH_SIZES
  ? process.env.CATALOG_BENCH_SIZES.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
  : undefined;
const bundle = await build({ entryPoints: ["bench/library-catalog.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022" });
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  page.on("console", event => { if (event.text().startsWith("CATALOG_")) console.log(event.text()); });
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate((benchSizes) => globalThis.runCatalogBenchmark(benchSizes), sizes);
  const report = { date: new Date().toISOString(), runtime: await app.evaluate(() => process.versions), totalMemoryBytes: totalmem(), cpu: cpus()[0]?.model, results };
  await mkdir("../docs/benchmarks", { recursive: true });
  await writeFile("../docs/benchmarks/library-catalog.json", JSON.stringify(report, null, 2) + "\n");
  console.log("Saved docs/benchmarks/library-catalog.json");
} finally { await app.close(); }
