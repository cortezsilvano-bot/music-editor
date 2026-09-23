import { describe, expect, it } from "vitest";
import { analyseStructure, type StructureInput } from "./structure";

const grid = {
  anchors: [{ timeSec: 0, beatIndex: 0, bpm: 120 }],
  beatsPerBar: 4,
  firstDownbeatSec: 0,
  isFixed: true,
  gridConfidence: 1,
  downbeatConfidence: 1,
};

const input = (curve: Float32Array, durationSec: number, vocalCurve?: Float32Array): StructureInput =>
  ({ curve, grid, durationSec, vocalCurve });

/** Energy curve that rises in steps: quiet intro, build, loud, quiet outro. */
function arc(): Float32Array {
  const c = new Float32Array(200);
  c.fill(0.15, 0, 40);
  c.fill(0.5, 40, 80);
  c.fill(1.0, 80, 140);
  c.fill(0.2, 140, 200);
  return c;
}

describe("bars", () => {
  it("integrates energy over actual bar durations", () => {
    const result = analyseStructure(input(new Float32Array([0, 1, 1, 1]), 4));
    expect(result.bars).toEqual([
      { startSec: 0, endSec: 2, energy: 0.5 },
      { startSec: 2, endSec: 4, energy: 1 },
    ]);
  });

  it("does not invent changes in silence", () => {
    const result = analyseStructure(input(new Float32Array(80), 80));
    expect(result.sections).toHaveLength(1);
    expect(result.bars.every((b) => b.energy === 0)).toBe(true);
  });
});

describe("section labels", () => {
  it("names a quiet opening Intro", () => {
    expect(analyseStructure(input(arc(), 200)).sections[0].label).toBe("Intro");
  });

  it("names a quiet ending Outro", () => {
    const sections = analyseStructure(input(arc(), 200)).sections;
    expect(sections[sections.length - 1].label).toBe("Outro");
  });

  it("finds the loudest stretch and calls it a Drop", () => {
    const sections = analyseStructure(input(arc(), 200)).sections;
    expect(sections.some((s) => s.label === "Drop")).toBe(true);
    const drop = sections.find((s) => s.label === "Drop")!;
    expect(drop.features.energy).toBeGreaterThan(0.75);
  });

  it("calls a section that rises into a louder one a Build", () => {
    const sections = analyseStructure(input(arc(), 200)).sections;
    const build = sections.find((s) => s.label === "Build");
    expect(build).toBeDefined();
    expect(build!.features.energyDelta).toBeGreaterThan(0.2);
  });

  it("distinguishes sung from instrumental at the same energy", () => {
    // The middle of a falling three-section arc: not an end, and not rising, so
    // no structural rule claims it and the vocal cue is what decides.
    const curve = new Float32Array(210);
    curve.fill(1.0, 0, 70);
    curve.fill(0.6, 70, 140);
    curve.fill(0.2, 140, 210);
    const sung = new Float32Array(210).fill(0.9);
    const quiet = new Float32Array(210).fill(0.05);

    const withVoice = analyseStructure(input(curve, 210, sung)).sections;
    const without = analyseStructure(input(curve, 210, quiet)).sections;
    expect(withVoice.length).toBeGreaterThanOrEqual(3);
    expect(withVoice[1].label).toBe("Verse");
    expect(without[1].label).toBe("Instrumental");
  });

  it("does not call a track with no detected changes a Drop", () => {
    // Relative normalisation would otherwise make the only section maximal.
    const flat = new Float32Array(200).fill(0.6);
    const sections = analyseStructure(input(flat, 200, new Float32Array(200).fill(0.1))).sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Instrumental");
  });

  it("explains each label with the features behind it", () => {
    for (const section of analyseStructure(input(arc(), 200)).sections) {
      expect(section.features.energy).toBeGreaterThanOrEqual(0);
      expect(section.features.energy).toBeLessThanOrEqual(1);
      expect(section.features.position).toBeGreaterThanOrEqual(0);
      expect(section.features.durationSec).toBeGreaterThan(0);
    }
  });

  it("keeps confidence in range and sections in order", () => {
    const sections = analyseStructure(input(arc(), 200)).sections;
    for (let i = 0; i < sections.length; i++) {
      expect(sections[i].confidence).toBeGreaterThan(0);
      expect(sections[i].confidence).toBeLessThanOrEqual(1);
      expect(sections[i].startSec).toBeLessThan(sections[i].endSec);
      if (i > 0) expect(sections[i].startSec).toBeGreaterThanOrEqual(sections[i - 1].endSec - 1e-9);
    }
  });

  it("covers the whole track with no gaps", () => {
    const sections = analyseStructure(input(arc(), 200)).sections;
    expect(sections[0].startSec).toBe(0);
    expect(sections[sections.length - 1].endSec).toBeCloseTo(200, 6);
  });
});
