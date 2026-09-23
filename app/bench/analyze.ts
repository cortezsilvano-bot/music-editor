/**
 * Offline analysis bench (research section 10).
 *
 * Runs the real analysis chain over decoded fixtures and prints the results,
 * optionally scoring them against ground truth. Fixtures are raw mono float32
 * at the analysis sample rate, produced by `bench/prepare.py`.
 *
 *   npx vite-node bench/analyze.ts
 *   npx vite-node bench/analyze.ts --truth bench/fixtures/truth.json
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyze } from "../src/analysis/pipeline";
import { ANALYSIS_SAMPLE_RATE } from "../src/dsp/spectral";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");

interface FixtureMeta {
  name: string;
  file: string;
  sampleRate: number;
  samples: number;
  seconds: number;
}

interface Truth {
  [name: string]: { bpm?: number };
}

function loadFixture(meta: FixtureMeta): Float32Array {
  const buf = readFileSync(join(fixtureDir, meta.file));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Accuracy1: within 4% of the reference tempo. */
function accuracy1(estimate: number, truth: number): boolean {
  return Math.abs(estimate - truth) / truth <= 0.04;
}

/** Accuracy2: Accuracy1 allowing octave and triplet relationships. */
function accuracy2(estimate: number, truth: number): boolean {
  return [1, 2, 0.5, 3, 1 / 3, 2 / 3, 1.5].some((r) => accuracy1(estimate, truth * r));
}

function main(): void {
  const index: FixtureMeta[] = JSON.parse(readFileSync(join(fixtureDir, "index.json"), "utf8"));

  const truthArg = process.argv.indexOf("--truth");
  const truth: Truth =
    truthArg !== -1 && existsSync(process.argv[truthArg + 1])
      ? JSON.parse(readFileSync(process.argv[truthArg + 1], "utf8"))
      : {};

  console.log(
    "track".padEnd(32),
    "bpm".padStart(7),
    "raw".padStart(7),
    "conf".padStart(6),
    "oct".padStart(6),
    "ms".padStart(7),
    "key".padStart(10),
    "cam".padStart(4),
    "grid".padStart(6),
    "  alternates",
  );
  console.log("-".repeat(122));

  let acc1 = 0;
  let acc2 = 0;
  let scored = 0;

  for (const meta of index) {
    const signal = loadFixture(meta);
    const started = performance.now();
    const analysis = analyze({ channels: [signal], sampleRate: ANALYSIS_SAMPLE_RATE });
    const tempo = analysis.tempo;
    const elapsed = performance.now() - started;

    const alts = tempo.alternates
      .slice(0, 3)
      .map((a) => `${a.bpm.toFixed(1)}(${a.strength.toFixed(2)})`)
      .join(" ");

    let mark = "";
    const reference = truth[meta.name]?.bpm;
    if (reference !== undefined) {
      scored++;
      const a1 = accuracy1(tempo.bpm, reference);
      const a2 = accuracy2(tempo.bpm, reference);
      if (a1) acc1++;
      if (a2) acc2++;
      mark = a1 ? "  OK" : a2 ? `  OCTAVE (truth ${reference})` : `  MISS (truth ${reference})`;
    }

    console.log(
      meta.name.padEnd(32),
      tempo.bpm.toFixed(2).padStart(7),
      tempo.rawBpm.toFixed(2).padStart(7),
      tempo.confidence.toFixed(3).padStart(6),
      tempo.octaveConfidence.toFixed(3).padStart(6),
      elapsed.toFixed(0).padStart(7),
      analysis.key.name.padStart(10),
      analysis.key.camelot.padStart(4),
      (analysis.grid.isFixed ? "fixed" : "dyn").padStart(6),
      " ",
      alts,
      mark,
    );

    const realtime = meta.seconds / (elapsed / 1000);
    if (realtime < 1) {
      console.warn(`  ! ${meta.name} analysed at ${realtime.toFixed(1)}x realtime`);
    }
  }

  if (scored > 0) {
    console.log("-".repeat(122));
    console.log(
      `Accuracy1 ${acc1}/${scored} (${((100 * acc1) / scored).toFixed(0)}%)   ` +
        `Accuracy2 ${acc2}/${scored} (${((100 * acc2) / scored).toFixed(0)}%)`,
    );
  } else {
    console.log("\nNo ground truth supplied - figures above are measurements, not accuracy.");
  }
}

main();
