/**
 * HPSS and bass-chroma tests. Synthetic tones only; not a stem-quality claim.
 */
import { describe, expect, it } from "vitest";
import { computeChroma, KEY_STFT, PITCH_NAMES, scoreKeyFromChroma } from "./key";
import { medianFilterHpss } from "./hpss";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "./spectral";

const SR = ANALYSIS_SAMPLE_RATE;

function sine(hz: number, seconds: number, amp = 0.6): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  }
  return out;
}

function clicks(seconds: number, everySec = 0.2, amp = 0.9): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const every = Math.round(everySec * SR);
  const len = Math.round(0.004 * SR);
  for (let at = 0; at < out.length; at += every) {
    for (let i = 0; i < len && at + i < out.length; i++) {
      out[at + i] += (i % 2 === 0 ? 1 : -1) * amp * Math.exp(-i / (0.001 * SR));
    }
  }
  return out;
}

describe("medianFilterHpss", () => {
  it("puts a sustained tone mostly in the harmonic residual", () => {
    const spec = computeStft(sine(440, 1.2), SR, KEY_STFT);
    const split = medianFilterHpss(spec, { harmonicWidth: 7, percussiveWidth: 7 });
    expect(split.harmonicEnergy).toBeGreaterThan(split.percussiveEnergy);
    expect(split.percussiveRatio).toBeLessThan(0.45);
  });

  it("puts a click train mostly in the percussive residual", () => {
    const spec = computeStft(clicks(1.2), SR, { fftSize: 1024, hopSize: 256 });
    const split = medianFilterHpss(spec, { harmonicWidth: 7, percussiveWidth: 7 });
    expect(split.percussiveEnergy).toBeGreaterThan(split.harmonicEnergy);
    expect(split.percussiveRatio).toBeGreaterThan(0.5);
  });

  it("splits a tone-plus-transient mix into both residuals", () => {
    const mix = sine(330, 1.2, 0.45);
    const trans = clicks(1.2);
    for (let i = 0; i < mix.length; i++) mix[i] += trans[i];
    const spec = computeStft(mix, SR, KEY_STFT);
    const split = medianFilterHpss(spec, { harmonicWidth: 7, percussiveWidth: 7 });
    expect(split.harmonicEnergy).toBeGreaterThan(0);
    expect(split.percussiveEnergy).toBeGreaterThan(0);
    expect(split.harmonicEnergy + split.percussiveEnergy).toBeGreaterThan(0);
    expect(split.percussiveRatio).toBeGreaterThan(0.05);
    expect(split.percussiveRatio).toBeLessThan(0.95);
  });
});

describe("bass chroma", () => {
  it("peaks on the pitch class of a low-frequency pitched tone", () => {
    // A2 = 110 Hz, pitch class 9.
    const spec = computeStft(sine(110, 2.0, 0.8), SR, KEY_STFT);
    const split = medianFilterHpss(spec, { harmonicWidth: 7, percussiveWidth: 7 });
    const chroma = computeChroma(split.harmonic, 0, { minHz: 40, maxHz: 250 });
    let peak = 0;
    let peakIndex = 0;
    for (let i = 0; i < 12; i++) {
      if (chroma[i] > peak) {
        peak = chroma[i];
        peakIndex = i;
      }
    }
    expect(PITCH_NAMES[peakIndex]).toBe("A");
    expect(peak).toBeGreaterThan(0.15);
    const key = scoreKeyFromChroma(chroma, 0);
    expect(key.tonic).toBe(9);
  });
});
