/** Cross-check measureLoudness against pyloudnorm's reference values. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measureLoudness } from "../src/dsp/loudness";

const dir = String.raw`C:/Users/ONES4E~1/AppData/Local/Temp/claude/f--Dev-apps-Music-editor/a0d4df52-e3ef-4788-a059-8781e85076dd/scratchpad/lt`;
const ref = JSON.parse(readFileSync(join(dir, "ref.json"), "utf8")) as Record<
  string,
  { integrated: number; frames: number; channels: number; sampleRate: number }
>;

console.log("case".padEnd(18), "ours".padStart(9), "pyloudnorm".padStart(11), "delta".padStart(8));
console.log("-".repeat(50));
let worst = 0;
for (const [name, meta] of Object.entries(ref)) {
  const raw = readFileSync(join(dir, name + ".f32"));
  const interleaved = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const channels: Float32Array[] = [];
  for (let c = 0; c < meta.channels; c++) {
    const ch = new Float32Array(meta.frames);
    for (let i = 0; i < meta.frames; i++) ch[i] = interleaved[i * meta.channels + c];
    channels.push(ch);
  }
  const ours = measureLoudness(channels, meta.sampleRate, { skipTruePeak: true });
  const delta = ours.integratedLufs - meta.integrated;
  worst = Math.max(worst, Math.abs(delta));
  console.log(
    name.padEnd(18),
    ours.integratedLufs.toFixed(3).padStart(9),
    meta.integrated.toFixed(3).padStart(11),
    delta.toFixed(3).padStart(8),
  );
}
console.log("-".repeat(50));
console.log("worst absolute deviation:", worst.toFixed(4), "LU");
