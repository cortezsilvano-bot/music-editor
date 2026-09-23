/**
 * WSOLA time-stretching and resampling for the decks.
 *
 * Plain JavaScript, not TypeScript, because this module is imported by an
 * AudioWorklet as well as by the tests, and a worklet loads real JS.
 *
 * Two playback modes:
 *
 * - **Vinyl** (`keyLock` off): the buffer is simply read at a different rate,
 *   so pitch rises and falls with tempo. This is what a turntable does and what
 *   DJs expect when key lock is disabled.
 * - **Key lock** (`keyLock` on): WSOLA. The output is assembled from
 *   overlapping grains taken from the source at the *original* pitch, spaced to
 *   produce the requested tempo. Each grain's position is nudged within a search
 *   window to the offset that best matches the tail of what has already been
 *   written, which is what keeps successive grains phase-aligned and avoids the
 *   metallic warble a naive overlap-add produces.
 *
 * Everything is preallocated in the constructor. `process()` runs on the audio
 * thread, where an allocation risks a dropout, so it must not create anything.
 */

/** Grain length in samples at 44.1 kHz. Long enough to hold a bass period. */
const DEFAULT_GRAIN = 2048;
/** How far the grain start may be nudged to find the best phase match. */
const DEFAULT_SEARCH = 512;

export class Wsola {
  /**
   * @param {Float32Array[]} channels source audio, one array per channel
   * @param {{ grainSize?: number, searchRadius?: number }} [options]
   */
  constructor(channels, options = {}) {
    this.channels = channels;
    this.channelCount = channels.length;
    this.length = channels[0] ? channels[0].length : 0;

    this.grainSize = options.grainSize ?? DEFAULT_GRAIN;
    this.searchRadius = options.searchRadius ?? DEFAULT_SEARCH;
    this.hop = this.grainSize >> 1;

    /** Read position in the source, in samples. Fractional. */
    this.position = 0;
    /** Samples of the current grain already emitted. */
    this.grainOffset = this.hop;
    /** Where the current grain was taken from. */
    this.grainStart = 0;

    // Hann window for the overlap-add, precomputed.
    this.window = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.grainSize);
    }

    // Output accumulator, one grain long, per channel.
    this.accumulator = [];
    for (let c = 0; c < this.channelCount; c++) {
      this.accumulator.push(new Float32Array(this.grainSize));
    }
    // Mono mix of the accumulator tail, used for the similarity search.
    this.tail = new Float32Array(this.hop);
  }

  /** True once playback has run past the end of the source. */
  get finished() {
    return this.position >= this.length;
  }

  /** Current playback position in seconds, given a sample rate. */
  positionSeconds(sampleRate) {
    return this.position / sampleRate;
  }

  seekSeconds(seconds, sampleRate) {
    this.seek(Math.max(0, Math.round(seconds * sampleRate)));
  }

  seek(sample) {
    this.position = Math.max(0, Math.min(sample, this.length));
    // Force a fresh grain rather than continuing to read the old one.
    this.grainOffset = this.hop;
    this.grainStart = Math.floor(this.position);
    for (let c = 0; c < this.channelCount; c++) this.accumulator[c].fill(0);
    this.tail.fill(0);
  }

  /**
   * Find the offset within the search window whose audio best continues what
   * has already been written.
   *
   * Cross-correlation against the accumulator tail. Returns an offset in
   * samples relative to `ideal`.
   */
  bestOffset(ideal) {
    if (this.searchRadius === 0) return 0;
    let bestScore = -Infinity;
    let bestOffset = 0;
    const source = this.channels[0];

    for (let offset = -this.searchRadius; offset <= this.searchRadius; offset += 8) {
      const start = ideal + offset;
      if (start < 0 || start + this.hop >= this.length) continue;
      let score = 0;
      // Step by 4: a quarter of the resolution is ample for picking a phase and
      // keeps this affordable on the audio thread.
      for (let i = 0; i < this.hop; i += 4) {
        score += source[start + i] * this.tail[i];
      }
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    return bestOffset;
  }

  /** Lay the next grain into the accumulator, overlapping the previous tail. */
  nextGrain(rate) {
    const ideal = Math.floor(this.position);
    const offset = this.bestOffset(ideal);
    const start = Math.max(0, Math.min(ideal + offset, Math.max(0, this.length - this.grainSize)));
    this.grainStart = start;

    for (let c = 0; c < this.channelCount; c++) {
      const source = this.channels[c];
      const target = this.accumulator[c];
      // Shift the second half down to the first: it is the overlap tail.
      for (let i = 0; i < this.hop; i++) target[i] = target[i + this.hop];
      for (let i = this.hop; i < this.grainSize; i++) target[i] = 0;
      // Overlap-add the new grain.
      for (let i = 0; i < this.grainSize; i++) {
        const index = start + i;
        const sample = index < this.length ? source[index] : 0;
        target[i] += sample * this.window[i];
      }
    }

    // Refresh the tail used for the next similarity search.
    const first = this.accumulator[0];
    for (let i = 0; i < this.hop; i++) this.tail[i] = first[i + this.hop];

    // Advance the read head by one hop of *source* time, scaled by tempo.
    this.position += this.hop * rate;
    this.grainOffset = 0;
  }

  /**
   * Fill `output` with the next block.
   *
   * @param {Float32Array[]} output one array per channel
   * @param {number} rate playback rate, 1 = original tempo
   * @param {boolean} keyLock preserve pitch while changing tempo
   * @returns {number} frames written; less than output length at end of track
   */
  process(output, rate, keyLock) {
    const frames = output[0].length;

    if (!keyLock) {
      // Vinyl mode: read the source directly at `rate`, pitch follows tempo.
      let written = 0;
      for (let i = 0; i < frames; i++) {
        const read = this.position;
        if (read >= this.length) break;
        const index = Math.floor(read);
        const fraction = read - index;
        for (let c = 0; c < this.channelCount; c++) {
          const source = this.channels[c];
          const a = source[index];
          const b = index + 1 < this.length ? source[index + 1] : a;
          output[c][i] = a + (b - a) * fraction;
        }
        this.position += rate;
        written++;
      }
      return written;
    }

    let written = 0;
    while (written < frames) {
      if (this.grainOffset >= this.hop) {
        if (this.position >= this.length) break;
        this.nextGrain(rate);
      }
      const available = Math.min(this.hop - this.grainOffset, frames - written);
      for (let c = 0; c < this.channelCount; c++) {
        const target = output[c];
        const source = this.accumulator[c];
        for (let i = 0; i < available; i++) {
          target[written + i] = source[this.grainOffset + i];
        }
      }
      this.grainOffset += available;
      written += available;
    }
    return written;
  }
}
