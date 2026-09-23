/**
 * Iterative radix-2 Cooley-Tukey FFT.
 *
 * Written rather than pulled from a package so the analysis chain has no
 * runtime dependency and so the numerics are covered by our own tests.
 * Instances cache twiddle factors and the bit-reversal table, so reuse one
 * per transform size rather than constructing per frame.
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;

    this.cosTable = new Float64Array(size / 2);
    this.sinTable = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      // Forward transform: exp(-2*pi*i*k/N)
      this.cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    const bits = Math.log2(size) | 0;
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | ((i >>> b) & 1);
      }
      this.reverse[i] = r;
    }
  }

  /** In-place complex FFT. `re` and `im` must both be `size` long. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error(`FFT buffers must be length ${n}`);
    }

    for (let i = 0; i < n; i++) {
      const j = this.reverse[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let base = 0; base < n; base += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const wr = this.cosTable[tw];
          const wi = this.sinTable[tw];
          const a = base + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /**
   * Magnitude spectrum of a real signal, bins 0..size/2 inclusive.
   * `out` must be `size / 2 + 1` long; it is returned for chaining.
   */
  magnitudes(input: Float32Array | Float64Array, out: Float64Array): Float64Array {
    const n = this.size;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const count = Math.min(n, input.length);
    for (let i = 0; i < count; i++) re[i] = input[i];
    this.transform(re, im);
    for (let i = 0; i <= n / 2; i++) {
      out[i] = Math.hypot(re[i], im[i]);
    }
    return out;
  }
}

/** Naive O(n^2) DFT magnitude, used only to verify {@link FFT} in tests. */
export function referenceDftMagnitudes(input: Float64Array): Float64Array {
  const n = input.length;
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re += input[t] * Math.cos(angle);
      im += input[t] * Math.sin(angle);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}
