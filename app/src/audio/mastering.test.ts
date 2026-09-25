import { describe, expect, it, vi, afterEach } from "vitest";
import {
  clampMasteringSettings,
  dbToGain,
  gainToDb,
  linearToMeterDb,
  makeSoftClipCurve,
  ceilingToThresholdDb,
  DEFAULT_MASTERING,
  loadMasteringSettings,
  saveMasteringSettings,
  MASTERING_SETTING_KEY,
} from "./mastering";

afterEach(() => {
  try {
    localStorage.removeItem(`music-editor.${MASTERING_SETTING_KEY}`);
  } catch {
    /* jsdom may lack storage in some runs */
  }
});

describe("mastering helpers", () => {
  it("converts dB and gain symmetrically around unity", () => {
    expect(dbToGain(0)).toBeCloseTo(1, 6);
    expect(dbToGain(6)).toBeCloseTo(1.995262, 4);
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(gainToDb(0)).toBe(-Infinity);
  });

  it("clamps out-of-range settings and fills defaults", () => {
    const clamped = clampMasteringSettings({
      bypass: false,
      inputGainDb: 99,
      lowShelfDb: -99,
      highShelfDb: 3,
      softClip: 2,
      ceilingDb: 5,
      outputGainDb: -40,
    });
    expect(clamped.bypass).toBe(false);
    expect(clamped.inputGainDb).toBe(12);
    expect(clamped.lowShelfDb).toBe(-12);
    expect(clamped.highShelfDb).toBe(3);
    expect(clamped.softClip).toBe(1);
    expect(clamped.ceilingDb).toBe(0);
    expect(clamped.outputGainDb).toBe(-24);
  });

  it("defaults when raw is null", () => {
    expect(clampMasteringSettings(null)).toEqual(DEFAULT_MASTERING);
  });

  it("builds a soft-clip curve that is odd and bounded", () => {
    const identity = makeSoftClipCurve(0, 9);
    expect(identity[0]).toBeCloseTo(-1, 5);
    expect(identity[identity.length - 1]).toBeCloseTo(1, 5);
    expect(identity[4]).toBeCloseTo(0, 5);

    const driven = makeSoftClipCurve(1, 64);
    for (let i = 0; i < driven.length; i++) {
      expect(Math.abs(driven[i])).toBeLessThanOrEqual(1 + 1e-6);
    }
    // Midpoint stays near 0; ends compress toward Ã‚Â±1.
    expect(Math.abs(driven[driven.length - 1])).toBeLessThanOrEqual(1);
    expect(Math.abs(driven[0])).toBeLessThanOrEqual(1);
  });

  it("maps ceiling to a slightly lower limiter threshold", () => {
    expect(ceilingToThresholdDb(-1)).toBeCloseTo(-1.5, 5);
    expect(ceilingToThresholdDb(0)).toBeCloseTo(-0.5, 5);
  });

  it("floors silent meter readings", () => {
    expect(linearToMeterDb(0)).toBe(-60);
    expect(linearToMeterDb(1)).toBeCloseTo(0, 5);
  });

  it("persists settings through localStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    saveMasteringSettings({
      ...DEFAULT_MASTERING,
      bypass: false,
      inputGainDb: 3,
      ceilingDb: -1.5,
    });
    const loaded = loadMasteringSettings();
    expect(loaded.bypass).toBe(false);
    expect(loaded.inputGainDb).toBe(3);
    expect(loaded.ceilingDb).toBe(-1.5);
    vi.unstubAllGlobals();
  });
});

describe("MasterBus", () => {
  it("applies settings onto Web Audio nodes", async () => {
    const { MasterBus } = await import("./masterBus");
    const gains: Array<{ value: number; setTargetAtTime: ReturnType<typeof vi.fn> }> = [];
    const makeGain = () => {
      const g = { value: 1, setTargetAtTime: vi.fn() };
      gains.push(g);
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: g,
      };
    };
    const makeFilter = () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      type: "lowshelf",
      frequency: { value: 0 },
      gain: { value: 0, setTargetAtTime: vi.fn() },
    });
    const shaper = { connect: vi.fn(), disconnect: vi.fn(), curve: null as Float32Array | null, oversample: "none" };
    const limiter = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      threshold: { value: -3, setTargetAtTime: vi.fn() },
      knee: { value: 0 },
      ratio: { value: 20 },
      attack: { value: 0.003 },
      release: { value: 0.1 },
      reduction: -1.5,
    };
    const analyser = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 2048,
      smoothingTimeConstant: 0.3,
      getFloatTimeDomainData: vi.fn((buf: Float32Array) => {
        buf.fill(0.25);
      }),
    };
    const context = {
      currentTime: 1,
      destination: {},
      createGain: vi.fn(makeGain),
      createBiquadFilter: vi.fn(makeFilter),
      createWaveShaper: vi.fn(() => shaper),
      createDynamicsCompressor: vi.fn(() => limiter),
      createAnalyser: vi.fn(() => analyser),
    };

    const bus = new MasterBus(context as unknown as AudioContext);
    bus.applySettings({
      bypass: false,
      inputGainDb: 6,
      lowShelfDb: 2,
      highShelfDb: -1,
      softClip: 0.5,
      ceilingDb: -1,
      outputGainDb: -3,
    });

    expect(shaper.curve).toBeInstanceOf(Float32Array);
    expect(limiter.threshold.setTargetAtTime).toHaveBeenCalled();
    const reading = bus.readMeter();
    expect(reading.peakDb).toBeGreaterThan(-60);
    expect(reading.reductionDb).toBe(-1.5);
    bus.disconnect();
  });
});
