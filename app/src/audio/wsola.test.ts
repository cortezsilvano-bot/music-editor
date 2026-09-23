import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS module, shared with the AudioWorklet.
import { Wsola } from "./wsola.js";

const SR = 44100;

function sine(freq: number, seconds: number, rate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Run a stretcher to exhaustion and return everything it produced. */
function render(w: InstanceType<typeof Wsola>, rate: number, keyLock: boolean, frames = 512) {
  const chunks: number[] = [];
  const block = [new Float32Array(frames)];
  for (let guard = 0; guard < 20000; guard++) {
    const written = w.process(block, rate, keyLock);
    if (written === 0) break;
    for (let i = 0; i < written; i++) chunks.push(block[0][i]);
  }
  return Float32Array.from(chunks);
}

/** Dominant frequency via a coarse DFT over the middle of the signal. */
function dominantFrequency(x: Float32Array, rate = SR): number {
  const start = Math.floor(x.length / 3);
  const n = Math.min(8192, x.length - start);
  let bestFreq = 0;
  let bestPower = -1;
  for (let f = 100; f <= 2000; f += 2) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = (-2 * Math.PI * f * i) / rate;
      re += x[start + i] * Math.cos(angle);
      im += x[start + i] * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (power > bestPower) {
      bestPower = power;
      bestFreq = f;
    }
  }
  return bestFreq;
}

function rms(x: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, x.length));
}

describe("Wsola vinyl mode", () => {
  it("returns the source unchanged at rate 1", () => {
    const source = sine(440, 0.5);
    const out = render(new Wsola([source]), 1, false);
    expect(out.length).toBeCloseTo(source.length, -2);
    expect(dominantFrequency(out)).toBeCloseTo(440, -1);
  });

  it("raises pitch when sped up, as a turntable does", () => {
    const out = render(new Wsola([sine(440, 1)]), 2, false);
    expect(dominantFrequency(out)).toBeGreaterThan(800);
  });

  it("shortens the output when sped up", () => {
    const source = sine(440, 1);
    const out = render(new Wsola([source]), 2, false);
    expect(out.length).toBeLessThan(source.length * 0.6);
  });

  it("lowers pitch when slowed down", () => {
    const out = render(new Wsola([sine(880, 1)]), 0.5, false);
    expect(dominantFrequency(out)).toBeLessThan(500);
  });
});

describe("Wsola key lock", () => {
  it("keeps pitch when sped up", () => {
    const out = render(new Wsola([sine(440, 2)]), 1.25, true);
    // The whole point: tempo changed, pitch did not.
    expect(dominantFrequency(out)).toBeGreaterThan(420);
    expect(dominantFrequency(out)).toBeLessThan(460);
  });

  it("keeps pitch when slowed down", () => {
    const out = render(new Wsola([sine(440, 2)]), 0.8, true);
    expect(dominantFrequency(out)).toBeGreaterThan(420);
    expect(dominantFrequency(out)).toBeLessThan(460);
  });

  it("shortens the output when sped up", () => {
    const source = sine(440, 2);
    const out = render(new Wsola([source]), 1.5, true);
    expect(out.length).toBeLessThan(source.length * 0.8);
    expect(out.length).toBeGreaterThan(source.length * 0.5);
  });

  it("lengthens the output when slowed down", () => {
    const source = sine(440, 2);
    const out = render(new Wsola([source]), 0.75, true);
    expect(out.length).toBeGreaterThan(source.length * 1.1);
  });

  it("keeps a steady level rather than warbling", () => {
    // Naive overlap-add without phase alignment produces deep periodic dropouts;
    // measuring the level of successive windows catches that.
    const out = render(new Wsola([sine(440, 3)]), 1.2, true);
    const windowSize = 4096;
    const levels: number[] = [];
    for (let at = SR; at + windowSize < out.length - SR; at += windowSize) {
      levels.push(rms(out.subarray(at, at + windowSize)));
    }
    expect(levels.length).toBeGreaterThan(3);
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    expect(min / max).toBeGreaterThan(0.7);
  });

  it("passes audio through unchanged at rate 1", () => {
    const out = render(new Wsola([sine(440, 1)]), 1, true);
    expect(rms(out)).toBeGreaterThan(0.5);
    expect(dominantFrequency(out)).toBeCloseTo(440, -1);
  });
});

describe("Wsola transport", () => {
  it("reports position in seconds", () => {
    const w = new Wsola([sine(440, 2)]);
    w.seekSeconds(1, SR);
    expect(w.positionSeconds(SR)).toBeCloseTo(1, 3);
  });

  it("clamps a seek past the end", () => {
    const w = new Wsola([sine(440, 1)]);
    w.seekSeconds(99, SR);
    expect(w.finished).toBe(true);
  });

  it("clamps a negative seek to the start", () => {
    const w = new Wsola([sine(440, 1)]);
    w.seekSeconds(-5, SR);
    expect(w.positionSeconds(SR)).toBe(0);
  });

  it("stops producing audio at the end of the track", () => {
    const w = new Wsola([sine(440, 0.2)]);
    render(w, 1, true);
    expect(w.process([new Float32Array(128)], 1, true)).toBe(0);
  });

  it("handles stereo", () => {
    const left = sine(440, 0.5);
    const right = sine(880, 0.5);
    const w = new Wsola([left, right]);
    const block = [new Float32Array(256), new Float32Array(256)];
    expect(w.process(block, 1, true)).toBe(256);
    expect(rms(block[0])).toBeGreaterThan(0);
    expect(rms(block[1])).toBeGreaterThan(0);
  });

  it("allocates nothing during process", () => {
    // A guard against future edits: process must reuse preallocated buffers.
    const w = new Wsola([sine(440, 1)]);
    const block = [new Float32Array(128)];
    const before = w.accumulator[0];
    w.process(block, 1.1, true);
    expect(w.accumulator[0]).toBe(before);
  });
});
