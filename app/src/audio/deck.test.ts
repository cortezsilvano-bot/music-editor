import { describe, expect, it, vi } from "vitest";
import { crossfadeGains, syncRatio } from "./deck";

describe("crossfadeGains", () => {
  it("is equal-power at the centre, not linear", () => {
    const { a, b } = crossfadeGains(0.5);
    // A linear fade would give 0.5 each and dip ~3 dB in the middle.
    expect(a).toBeCloseTo(Math.SQRT1_2, 6);
    expect(b).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("holds constant power across the whole sweep", () => {
    for (let x = 0; x <= 1.0001; x += 0.1) {
      const { a, b } = crossfadeGains(x);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it("fully isolates each deck at the ends", () => {
    expect(crossfadeGains(0)).toMatchObject({ a: 1 });
    expect(crossfadeGains(0).b).toBeCloseTo(0, 9);
    expect(crossfadeGains(1).a).toBeCloseTo(0, 9);
    expect(crossfadeGains(1).b).toBeCloseTo(1, 9);
  });

  it("clamps out-of-range positions", () => {
    expect(crossfadeGains(-3)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(9)).toEqual(crossfadeGains(1));
  });
});

describe("syncRatio", () => {
  it("matches two close tempi directly", () => {
    expect(syncRatio(126, 128)).toBeCloseTo(128 / 126, 9);
  });

  it("is 1 when the tempi already agree", () => {
    expect(syncRatio(128, 128)).toBeCloseTo(1, 9);
  });

  it("folds a double-time match into a playable range", () => {
    // 174 against 128 would be 0.736 - within range, so kept.
    const ratio = syncRatio(174, 128);
    expect(ratio).toBeGreaterThan(0.71);
    expect(ratio).toBeLessThan(1.42);
  });

  it("halves an extreme ratio rather than returning an unplayable one", () => {
    // 70 -> 140 is 2.0, which no pitch fader reaches; 1.0 is the octave match.
    const ratio = syncRatio(70, 140);
    expect(ratio).toBeCloseTo(1, 6);
  });

  it("doubles an extreme low ratio", () => {
    expect(syncRatio(140, 70)).toBeCloseTo(1, 6);
  });

  it("always lands inside the pitch fader's range", () => {
    for (const from of [60, 85, 100, 128, 140, 174, 200]) {
      for (const to of [60, 90, 128, 150, 175]) {
        const ratio = syncRatio(from, to);
        expect(ratio).toBeGreaterThanOrEqual(0.71);
        expect(ratio).toBeLessThanOrEqual(1.42);
      }
    }
  });

  it("returns 1 for nonsense input rather than NaN or Infinity", () => {
    expect(syncRatio(0, 128)).toBe(1);
    expect(syncRatio(128, 0)).toBe(1);
    expect(syncRatio(Number.NaN, 128)).toBe(1);
  });
});

describe("Deck.loadStream", () => {
  function mockMediaElementSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  function biquad() {
    return {
      type: "",
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0, setTargetAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }

  function gainNode() {
    return {
      gain: { value: 1, setTargetAtTime: vi.fn() },
      connect: vi.fn(),
    };
  }

  it("loads via MediaElement without posting PCM to the worklet", async () => {
    const mediaListeners: Record<string, Array<() => void>> = {};
    const media = {
      preload: "",
      paused: true,
      currentTime: 0,
      duration: 3600,
      readyState: 1,
      playbackRate: 1,
      error: null as { message: string } | null,
      src: "",
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      addEventListener: (type: string, fn: () => void) => {
        (mediaListeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        mediaListeners[type] = (mediaListeners[type] ?? []).filter((item) => item !== fn);
      },
      load: vi.fn(() => {
        queueMicrotask(() => {
          for (const fn of mediaListeners.loadedmetadata ?? []) fn();
        });
      }),
      play: vi.fn(async () => {
        media.paused = false;
      }),
      pause: vi.fn(() => {
        media.paused = true;
      }),
      removeAttribute: vi.fn(),
    };
    vi.stubGlobal("Audio", vi.fn(() => media));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mix-stream"),
      revokeObjectURL: vi.fn(),
    });

    const context = {
      currentTime: 0,
      state: "running",
      sampleRate: 48000,
      destination: {},
      baseLatency: 0,
      outputLatency: 0,
      createBiquadFilter: vi.fn(biquad),
      createGain: vi.fn(gainNode),
      createDynamicsCompressor: vi.fn(() => ({
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        reduction: 0,
        connect: vi.fn(),
      })),
      createMediaElementSource: vi.fn(mockMediaElementSource),
      resume: vi.fn(async () => {}),
      close: vi.fn(),
    } as unknown as AudioContext;

    const { Deck } = await import("./deck");
    const deck = new Deck("A", context);
    await deck.loadStream(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }), 3600, null);

    expect(deck.streaming).toBe(true);
    expect(deck.state.loaded).toBe(true);
    expect(deck.state.streaming).toBe(true);
    expect(deck.state.durationSec).toBe(3600);

    deck.seekSeconds(120);
    expect(media.currentTime).toBe(120);
    expect(deck.state.positionSec).toBe(120);

    deck.setRate(1.05);
    expect(media.playbackRate).toBe(1.05);

    // PCM-only features must no-op rather than pretend to loop.
    deck.setBeatLoop(4);
    expect(deck.state.loop).toBeNull();
    deck.startRoll(1);
    expect(deck.state.loop).toBeNull();

    await deck.play();
    expect(deck.state.playing).toBe(true);
    deck.pause();
    expect(deck.state.playing).toBe(false);
    expect(media.pause).toHaveBeenCalled();

    deck.eject();
    expect(deck.streaming).toBe(false);
    expect(deck.state.loaded).toBe(false);

    vi.unstubAllGlobals();
  });
});
