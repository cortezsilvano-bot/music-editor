import { afterEach, expect, it, vi } from "vitest";
import { Player } from "./player";
function node() { return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
  frequency: { value: 0 }, onended: null }; }
function filterNode() {
  return { connect: vi.fn(), disconnect: vi.fn(), type: "lowshelf",
    frequency: { value: 0 }, gain: { value: 0, setTargetAtTime: vi.fn() }, Q: { value: 1 } };
}
function masterContextExtras() {
  return {
    createBiquadFilter: vi.fn(filterNode),
    createWaveShaper: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), curve: null, oversample: "none" })),
    createDynamicsCompressor: vi.fn(() => ({
      connect: vi.fn(), disconnect: vi.fn(),
      threshold: { value: -3, setTargetAtTime: vi.fn() },
      knee: { value: 0 }, ratio: { value: 20 }, attack: { value: 0.003 }, release: { value: 0.1 },
      reduction: 0,
    })),
    createAnalyser: vi.fn(() => ({
      connect: vi.fn(), disconnect: vi.fn(), fftSize: 2048, smoothingTimeConstant: 0.3,
      getFloatTimeDomainData: vi.fn((buf: Float32Array) => { buf.fill(0); }),
    })),
  };
}
afterEach(() => vi.useRealTimers());
it("updates a playing grid without resetting transport and cancels obsolete clicks", async () => {
  vi.useFakeTimers();
  const context = { currentTime: 0, state: "running", destination: {}, createGain: vi.fn(node),
    createBufferSource: vi.fn(node), createOscillator: vi.fn(node), close: vi.fn(), ...masterContextExtras() };
  const player = new Player(context as unknown as AudioContext);
  player.load({ duration: 10 } as AudioBuffer);
  player.setGrid(new Float64Array([0.1, 0.6, 1.1]), 0.1, 4);
  player.setClickEnabled(true);
  await player.play();
  context.currentTime = 0.05;
  vi.advanceTimersByTime(50);
  const oldClick = context.createOscillator.mock.results[0].value;
  player.setGrid(new Float64Array([0.2, 0.7, 1.2]), 0.2, 4);
  expect(player.playerState).toBe("playing");
  expect(player.position).toBe(0.05);
  expect(context.createBufferSource).toHaveBeenCalledTimes(1);
  expect(oldClick.stop).toHaveBeenLastCalledWith();
  vi.advanceTimersByTime(50);
  expect(context.createOscillator).toHaveBeenCalledTimes(2);
  player.dispose();
});

function mockMediaElementSource() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

it("loadStream seeks via the media element clock", async () => {
  const mediaListeners: Record<string, Array<() => void>> = {};
  const media = {
    preload: "",
    paused: true,
    currentTime: 0,
    duration: 120,
    readyState: 1,
    error: null as { message: string } | null,
    src: "",
    onwaiting: null as (() => void) | null,
    onseeking: null as (() => void) | null,
    onplaying: null as (() => void) | null,
    onseeked: null as (() => void) | null,
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
    play: vi.fn(async () => { media.paused = false; media.onplaying?.(); }),
    pause: vi.fn(() => { media.paused = true; }),
    removeAttribute: vi.fn(),
  };
  const AudioMock = vi.fn(() => media);
  vi.stubGlobal("Audio", AudioMock);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });

  const context = {
    currentTime: 0,
    state: "running",
    destination: {},
    createGain: vi.fn(node),
    createBufferSource: vi.fn(node),
    createOscillator: vi.fn(node),
    createMediaElementSource: vi.fn(mockMediaElementSource),
    close: vi.fn(),
    resume: vi.fn(async () => {}),
    ...masterContextExtras(),
  };
  const player = new Player(context as unknown as AudioContext);
  await player.loadStream(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }), 120);
  expect(player.streaming).toBe(true);
  expect(player.duration).toBe(120);

  player.seek(45.5);
  expect(media.currentTime).toBe(45.5);
  expect(player.position).toBe(45.5);

  await player.play();
  expect(player.playerState).toBe("playing");
  player.seek(10);
  expect(media.currentTime).toBe(10);

  player.dispose();
  vi.unstubAllGlobals();
});
