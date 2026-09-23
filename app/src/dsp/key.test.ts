import { describe, expect, it } from "vitest";
import {
  camelotLabel,
  detectKey,
  estimateTuningCents,
  KEY_STFT,
  keyName,
  openKeyLabel,
  relativeKey,
} from "./key";
import { ANALYSIS_SAMPLE_RATE, computeStft } from "./spectral";

/** Render a chord progression as summed sine partials. */
function renderNotes(
  chords: number[][],
  secondsPerChord: number,
  tuningCents = 0,
): Float32Array {
  const rate = ANALYSIS_SAMPLE_RATE;
  const total = Math.round(chords.length * secondsPerChord * rate);
  const out = new Float32Array(total);
  const reference = 440 * 2 ** (tuningCents / 1200);
  const chordSamples = Math.round(secondsPerChord * rate);

  chords.forEach((chord, index) => {
    const start = index * chordSamples;
    for (const midi of chord) {
      const freq = reference * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < chordSamples; i++) {
        const idx = start + i;
        if (idx >= total) break;
        const envelope = Math.min(1, i / (0.01 * rate)) * Math.exp(-i / (1.2 * rate));
        // A couple of harmonics so the chroma stage sees realistic content.
        out[idx] +=
          (Math.sin((2 * Math.PI * freq * i) / rate) +
            0.4 * Math.sin((4 * Math.PI * freq * i) / rate) +
            0.2 * Math.sin((6 * Math.PI * freq * i) / rate)) *
          envelope *
          0.2;
      }
    }
  });
  return out;
}

function analyse(signal: Float32Array) {
  return detectKey(computeStft(signal, ANALYSIS_SAMPLE_RATE, KEY_STFT));
}

// MIDI numbers: C4 = 60.
const C = 60;
const notes = (root: number, intervals: number[]) => intervals.map((i) => root + i);
const MAJOR_TRIAD = [0, 4, 7];
const MINOR_TRIAD = [0, 3, 7];

describe("notation", () => {
  it("maps C major to 8B and 1d", () => {
    expect(camelotLabel(0, "major")).toBe("8B");
    expect(openKeyLabel(0, "major")).toBe("1d");
  });

  it("maps A minor to 8A and 1m", () => {
    expect(camelotLabel(9, "minor")).toBe("8A");
    expect(openKeyLabel(9, "minor")).toBe("1m");
  });

  it("maps G major to 9B and C minor to 5A", () => {
    expect(camelotLabel(7, "major")).toBe("9B");
    expect(camelotLabel(0, "minor")).toBe("5A");
  });

  it("keeps relatives on the same Camelot number", () => {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rel = relativeKey(tonic, "major");
      expect(camelotLabel(tonic, "major").slice(0, -1)).toBe(
        camelotLabel(rel.tonic, rel.mode).slice(0, -1),
      );
    }
  });

  it("produces all 12 Camelot numbers exactly once per mode", () => {
    const codes = new Set<string>();
    for (let tonic = 0; tonic < 12; tonic++) codes.add(camelotLabel(tonic, "major"));
    expect(codes.size).toBe(12);
  });

  it("round-trips relative keys", () => {
    const rel = relativeKey(0, "major");
    expect(keyName(rel.tonic, rel.mode)).toBe("A minor");
    expect(relativeKey(rel.tonic, rel.mode)).toEqual({ tonic: 0, mode: "major" });
  });
});

describe("estimateTuningCents", () => {
  it("reports about zero for standard tuning", () => {
    const signal = renderNotes([notes(C, MAJOR_TRIAD)], 2, 0);
    expect(Math.abs(estimateTuningCents(computeStft(signal, ANALYSIS_SAMPLE_RATE, KEY_STFT)))).toBeLessThan(12);
  });

  it("detects a sharp recording", () => {
    const signal = renderNotes([notes(C, MAJOR_TRIAD)], 2, 30);
    const cents = estimateTuningCents(computeStft(signal, ANALYSIS_SAMPLE_RATE, KEY_STFT));
    expect(cents).toBeGreaterThan(15);
    expect(cents).toBeLessThan(45);
  });
});

describe("detectKey", () => {
  it("identifies C major from a I-IV-V-I progression", () => {
    // C - F - G - C
    const signal = renderNotes(
      [
        notes(C, MAJOR_TRIAD),
        notes(C + 5, MAJOR_TRIAD),
        notes(C + 7, MAJOR_TRIAD),
        notes(C, MAJOR_TRIAD),
      ],
      1.5,
    );
    const result = analyse(signal);
    expect(result.tonic).toBe(0);
    expect(result.mode).toBe("major");
    expect(result.camelot).toBe("8B");
  });

  it("identifies A minor from a i-iv-v-i progression", () => {
    // Am - Dm - Em - Am, voiced below C4
    const A = 57;
    const signal = renderNotes(
      [
        notes(A, MINOR_TRIAD),
        notes(A + 5, MINOR_TRIAD),
        notes(A + 7, MINOR_TRIAD),
        notes(A, MINOR_TRIAD),
      ],
      1.5,
    );
    const result = analyse(signal);
    expect(result.mode).toBe("minor");
    expect(result.tonic).toBe(9);
    expect(result.camelot).toBe("8A");
  });

  it("transposes with the music", () => {
    // Same progression a fifth up should read as G major.
    const signal = renderNotes(
      [
        notes(C + 7, MAJOR_TRIAD),
        notes(C + 12, MAJOR_TRIAD),
        notes(C + 14, MAJOR_TRIAD),
        notes(C + 7, MAJOR_TRIAD),
      ],
      1.5,
    );
    expect(analyse(signal).tonic).toBe(7);
  });

  it("reports low confidence for noise", () => {
    let seed = 5;
    const noise = new Float32Array(ANALYSIS_SAMPLE_RATE * 4);
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = seed / 0xffffffff - 0.5;
    }
    expect(analyse(noise).confidence).toBeLessThan(0.5);
  });

  it("always returns a valid Camelot code", () => {
    const result = analyse(renderNotes([notes(C, MAJOR_TRIAD)], 1));
    expect(result.camelot).toMatch(/^([1-9]|1[0-2])[AB]$/);
    expect(result.openKey).toMatch(/^([1-9]|1[0-2])[dm]$/);
  });

  it("returns a normalised chroma", () => {
    const result = analyse(renderNotes([notes(C, MAJOR_TRIAD)], 1));
    const total = [...result.chroma].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});
