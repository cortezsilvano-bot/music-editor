import { describe, expect, it } from "vitest";
import { FFT, referenceDftMagnitudes } from "./fft";

describe("FFT", () => {
  it("rejects non-power-of-two sizes", () => {
    expect(() => new FFT(100)).toThrow(/power of two/);
  });

  it("puts a pure sine in exactly one bin", () => {
    const n = 1024;
    const fft = new FFT(n);
    const binIndex = 64;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      signal[i] = Math.sin((2 * Math.PI * binIndex * i) / n);
    }
    const mags = fft.magnitudes(signal, new Float64Array(n / 2 + 1));

    let peak = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peak]) peak = i;
    expect(peak).toBe(binIndex);

    // Every other bin should be numerically negligible.
    const others = [...mags].filter((_, i) => i !== binIndex);
    expect(Math.max(...others)).toBeLessThan(mags[binIndex] * 1e-9);
  });

  it("matches a naive DFT on random input", () => {
    const n = 256;
    const fft = new FFT(n);
    const signal = new Float64Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      signal[i] = seed / 0x3fffffff - 1;
    }
    const fast = fft.magnitudes(signal, new Float64Array(n / 2 + 1));
    const slow = referenceDftMagnitudes(signal);
    for (let i = 0; i < slow.length; i++) {
      expect(fast[i]).toBeCloseTo(slow[i], 8);
    }
  });

  it("gives DC energy for a constant signal", () => {
    const n = 64;
    const fft = new FFT(n);
    const signal = new Float64Array(n).fill(2);
    const mags = fft.magnitudes(signal, new Float64Array(n / 2 + 1));
    expect(mags[0]).toBeCloseTo(2 * n, 9);
    for (let i = 1; i < mags.length; i++) expect(mags[i]).toBeLessThan(1e-9);
  });
});
