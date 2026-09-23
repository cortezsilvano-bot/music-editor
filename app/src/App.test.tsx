/**
 * Mount smoke test.
 *
 * A successful build says nothing about whether the app renders - a throw in a
 * constructor or a top-level effect produces a perfectly valid bundle and a
 * blank page. This mounts the real component tree and asserts something
 * visible, with jsdom's missing browser APIs stubbed rather than the component
 * weakened to suit the test.
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

class StubWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

/** Enough of the Web Audio graph for Player's constructor and transport. */
function stubAudioNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    frequency: { value: 0 },
    start: vi.fn(),
    stop: vi.fn(),
    onended: null,
  };
}

class StubAudioContext {
  currentTime = 0;
  state = "running";
  destination = stubAudioNode();
  createGain = vi.fn(stubAudioNode);
  createOscillator = vi.fn(stubAudioNode);
  createBufferSource = vi.fn(() => ({ ...stubAudioNode(), buffer: null }));
  decodeAudioData = vi.fn(() => Promise.reject(new Error("not used in this test")));
  resume = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}

vi.stubGlobal("Worker", StubWorker);
vi.stubGlobal("AudioContext", StubAudioContext);
vi.stubGlobal(
  "requestAnimationFrame",
  vi.fn(() => 0),
);
vi.stubGlobal("cancelAnimationFrame", vi.fn());
HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

afterEach(cleanup);

describe("App", () => {
  it("renders without throwing", () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it("shows the header and the import control", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Music Editor")).toBeTruthy());
    expect(screen.getByText("Add audio")).toBeTruthy();
  });

  it("shows the empty state before any track is added", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Drop audio files here")).toBeTruthy());
    expect(screen.getByText("Select a track")).toBeTruthy();
  });

  it("mounts a real file input that accepts audio", () => {
    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    expect(input?.getAttribute("accept")).toBe("audio/*");
    expect(input?.hasAttribute("multiple")).toBe(true);
  });

  it("builds a Player without touching the real audio hardware", () => {
    render(<App />);
    // Constructing the deck is what previously crashed the whole tree.
    expect(screen.getByText("Music Editor")).toBeTruthy();
  });
});
