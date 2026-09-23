import { afterEach, expect, it, vi } from "vitest";
import { Player } from "./player";
function node() { return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
  frequency: { value: 0 }, onended: null }; }
afterEach(() => vi.useRealTimers());
it("updates a playing grid without resetting transport and cancels obsolete clicks", async () => {
  vi.useFakeTimers();
  const context = { currentTime: 0, state: "running", destination: {}, createGain: vi.fn(node),
    createBufferSource: vi.fn(node), createOscillator: vi.fn(node), close: vi.fn() };
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
