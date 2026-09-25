import { describe, expect, it } from "vitest";
import { analyze, AnalysisCancelledError, ANALYSIS_VERSION } from "./pipeline";

function kickTrack(bpm: number, seconds: number, rate = 44100): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const period = (60 / bpm) * rate;
  for (let beat = 0; beat * period < out.length; beat++) {
    const at = Math.round(beat * period);
    const len = Math.round(0.09 * rate);
    for (let i = 0; i < len; i++) {
      const idx = at + i;
      if (idx >= out.length) break;
      const decay = Math.exp(-i / (0.025 * rate));
      const freq = 120 * Math.exp(-i / (0.02 * rate)) + 45;
      out[idx] += Math.sin((2 * Math.PI * freq * i) / rate) * decay * 0.9;
    }
  }
  return out;
}

describe("analyze", () => {
  it("returns tempo, grid and key for a stereo input", () => {
    const mono = kickTrack(126, 20);
    const result = analyze({ channels: [mono, mono], sampleRate: 44100 });

    expect(result.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(result.durationSec).toBeCloseTo(20, 1);
    expect(result.tempo.bpm).toBeGreaterThan(125);
    expect(result.tempo.bpm).toBeLessThan(127);
    expect(result.grid.anchors.length).toBeGreaterThan(0);
    expect(result.key.camelot).toMatch(/^([1-9]|1[0-2])[AB]$/);
    expect(result.phrases?.phrases.length).toBeGreaterThan(0);
    expect(result.hpss).toBeDefined();
    expect(result.keySupport?.method).toBe("median-hpss-bass-chroma");
    expect(Number.isFinite(result.energy.rawScore)).toBe(true);
  });

  it("does not modify the caller's audio", () => {
    const mono = kickTrack(120, 6);
    const copy = Float32Array.from(mono);
    analyze({ channels: [mono], sampleRate: 44100 });
    expect([...mono]).toEqual([...copy]);
  });

  it("reports monotonically advancing progress", () => {
    const seen: number[] = [];
    analyze(
      { channels: [kickTrack(120, 6)], sampleRate: 44100 },
      { onProgress: (p) => seen.push(p.progress) },
    );
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("stops at the next stage boundary when cancelled", () => {
    const signal = { aborted: false };
    expect(() =>
      analyze(
        { channels: [kickTrack(120, 8)], sampleRate: 44100 },
        {
          signal,
          onProgress: (p) => {
            if (p.stage === "onsets") signal.aborted = true;
          },
        },
      ),
    ).toThrow(AnalysisCancelledError);
  });

  it("records a timing for every stage it ran", () => {
    const result = analyze({ channels: [kickTrack(120, 6)], sampleRate: 44100 });
    for (const stage of ["resample", "onset", "tempo", "beats", "grid", "key"]) {
      expect(result.timings[stage]).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles silence without throwing", () => {
    const result = analyze({ channels: [new Float32Array(44100 * 3)], sampleRate: 44100 });
    expect(Number.isFinite(result.tempo.bpm)).toBe(true);
    expect(result.tempo.confidence).toBe(0);
  });

  it("handles a track shorter than one analysis window", () => {
    const result = analyze({ channels: [new Float32Array(512)], sampleRate: 44100 });
    expect(Number.isFinite(result.tempo.bpm)).toBe(true);
  });
});
