import { _electron as electron } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "music-editor-ui-"));
const env = { ...process.env, MUSIC_EDITOR_TEST_DATA: path.join(directory, "profile") }; delete env.ELECTRON_RUN_AS_NODE;
const bundle = await build({ entryPoints: ["bench/library-ui.tsx"], bundle: true, write: false,
  platform: "browser", format: "iife", target: "es2022", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
const app = await electron.launch({ args: ["scripts/desktop-harness.cjs"], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await page.getByRole("heading", { name: "Music Editor", exact: true }).waitFor();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(() => globalThis.runLibraryUiBenchmark());
  await mkdir("../docs/benchmarks", { recursive: true });
  await writeFile("../docs/benchmarks/library-ui.json", JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + "\n");
  console.log(JSON.stringify(results));
} finally { await app.close(); }
