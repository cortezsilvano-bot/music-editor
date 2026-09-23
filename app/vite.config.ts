import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Bundle AudioWorklet entry points.
 *
 * Vite's `?url` copies a file verbatim, so an AudioWorklet that imports
 * anything ships with a bare specifier pointing at a chunk that was never
 * emitted. The module then fails to load at runtime with a network error, and
 * the only symptom is a deck that never starts.
 *
 * This bundles the worklet and its imports into one self-contained asset, which
 * keeps the DSP in a single tested module instead of duplicating it inline.
 *
 * Usage: `import url from "./deck-processor.js?audio-worklet"`.
 */
function audioWorklet(): Plugin {
  const SUFFIX = "?audio-worklet";
  let isBuild = false;

  return {
    name: "audio-worklet",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null;
      const target = source.slice(0, -SUFFIX.length);
      const resolved = resolve(importer ? dirname(importer) : process.cwd(), target);
      return resolved + SUFFIX;
    },
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null;
      const file = id.slice(0, -SUFFIX.length);

      if (!isBuild) {
        // The dev server resolves the worklet's own imports, so the plain file
        // works as-is and stays debuggable.
        return `export default ${JSON.stringify("/@fs" + file.replace(/\\/g, "/"))};`;
      }

      const result = await build({
        entryPoints: [file],
        bundle: true,
        format: "esm",
        target: "es2022",
        write: false,
        // The worklet runs on the audio thread; nothing here should be shimmed.
        platform: "neutral",
      });
      const code = result.outputFiles[0].text;
      const handle = this.emitFile({
        type: "asset",
        name: "deck-processor.js",
        source: code,
      });
      return `export default import.meta.ROLLUP_FILE_URL_${handle};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), audioWorklet()],
  build: { target: "es2022", outDir: "dist", sourcemap: true },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "electron/**/*.test.mjs"],
  },
} as Parameters<typeof defineConfig>[0]);
