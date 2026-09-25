import { afterEach, expect, it, vi } from "vitest";
import {
  SYSTEM_DEFAULT_OUTPUT_ID,
  attachAudioContextRecovery,
  listOutputDevices,
  recoverOutputSelection,
  setAudioOutputDevice,
  supportsAudioOutputSelection,
  watchOutputDevices,
} from "./devices";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("recoverOutputSelection keeps a still-present device", () => {
  const devices = [
    { deviceId: "usb-1", label: "USB DAC" },
    { deviceId: "bt-2", label: "BT Speakers" },
  ];
  expect(recoverOutputSelection("usb-1", devices)).toEqual({
    deviceId: "usb-1",
    fellBack: false,
    message: null,
  });
});

it("recoverOutputSelection falls back when the selected output is gone", () => {
  const devices = [{ deviceId: "speakers", label: "Speakers" }];
  const result = recoverOutputSelection("usb-gone", devices);
  expect(result.deviceId).toBe(SYSTEM_DEFAULT_OUTPUT_ID);
  expect(result.fellBack).toBe(true);
  expect(result.message).toMatch(/disconnected/i);
});

it("recoverOutputSelection treats default/empty as already on the default path", () => {
  const devices = [{ deviceId: "speakers", label: "Speakers" }];
  expect(recoverOutputSelection(null, devices).fellBack).toBe(false);
  expect(recoverOutputSelection("", devices).deviceId).toBe(SYSTEM_DEFAULT_OUTPUT_ID);
  expect(recoverOutputSelection(SYSTEM_DEFAULT_OUTPUT_ID, devices).fellBack).toBe(false);
});

it("listOutputDevices maps audiooutput entries and reports hidden labels", async () => {
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "mic", label: "Mic" },
        { kind: "audiooutput", deviceId: "out-a", label: "" },
        { kind: "audiooutput", deviceId: "out-b", label: "" },
      ],
    },
  });
  const result = await listOutputDevices();
  expect(result.supported).toBe(true);
  expect(result.labelsHidden).toBe(true);
  expect(result.devices).toHaveLength(2);
  expect(result.devices[0].label).toMatch(/^Output /);
});

it("watchOutputDevices refreshes on devicechange and unsubscribes cleanly", async () => {
  const listeners = new Map<string, Set<() => void>>();
  const enumerate = vi.fn(async () => [
    { kind: "audiooutput", deviceId: "a", label: "A" },
  ]);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: enumerate,
      addEventListener: (type: string, fn: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.get(type)?.delete(fn);
      },
    },
  });

  const seen: string[][] = [];
  const stop = watchOutputDevices((result) => {
    seen.push(result.devices.map((d) => d.deviceId));
  });

  await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
  expect(seen[0]).toEqual(["a"]);

  enumerate.mockResolvedValueOnce([
    { kind: "audiooutput", deviceId: "b", label: "B" },
  ]);
  for (const fn of listeners.get("devicechange") ?? []) fn();
  await vi.waitFor(() => expect(seen.at(-1)).toEqual(["b"]));

  stop();
  expect(listeners.get("devicechange")?.size ?? 0).toBe(0);
});

it("setAudioOutputDevice maps default to empty sink id", async () => {
  const setSinkId = vi.fn(async () => {});
  const context = { setSinkId } as unknown as AudioContext;
  expect(await setAudioOutputDevice(context, SYSTEM_DEFAULT_OUTPUT_ID)).toBe(true);
  expect(setSinkId).toHaveBeenCalledWith("");
  expect(await setAudioOutputDevice(context, "usb-1")).toBe(true);
  expect(setSinkId).toHaveBeenCalledWith("usb-1");
});

it("setAudioOutputDevice returns false when setSinkId is missing or throws", async () => {
  expect(await setAudioOutputDevice({} as AudioContext, "x")).toBe(false);
  const setSinkId = vi.fn(async () => {
    throw new Error("gone");
  });
  expect(await setAudioOutputDevice({ setSinkId } as unknown as AudioContext, "x")).toBe(false);
});

it("supportsAudioOutputSelection reflects prototype capability", () => {
  class FakeContext {}
  vi.stubGlobal("AudioContext", FakeContext);
  expect(supportsAudioOutputSelection()).toBe(false);
  (FakeContext.prototype as unknown as { setSinkId: () => void }).setSinkId = () => {};
  expect(supportsAudioOutputSelection()).toBe(true);
});

it("attachAudioContextRecovery notifies on suspend and tries resume on visibility", async () => {
  const stateListeners = new Set<() => void>();
  const context = {
    state: "running" as string,
    resume: vi.fn(async () => {
      context.state = "running";
    }),
    addEventListener: (type: string, fn: () => void) => {
      if (type === "statechange") stateListeners.add(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      stateListeners.delete(fn);
    },
  };

  const visibilityListeners = new Set<() => void>();
  const focusListeners = new Set<() => void>();
  let visibilityState = "visible";
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") visibilityListeners.add(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      visibilityListeners.delete(fn);
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: () => void) => {
      if (type === "focus") focusListeners.add(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      focusListeners.delete(fn);
    },
  });

  const onSuspended = vi.fn();
  const onResumed = vi.fn();
  const stop = attachAudioContextRecovery(context as unknown as AudioContext, {
    onSuspended,
    onResumed,
    shouldResume: () => true,
  });

  context.state = "suspended";
  for (const fn of stateListeners) fn();
  expect(onSuspended).toHaveBeenCalled();
  expect(String(onSuspended.mock.calls[0][0])).toMatch(/interrupted/i);

  visibilityState = "visible";
  for (const fn of visibilityListeners) fn();
  await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());
  await vi.waitFor(() => expect(onResumed).toHaveBeenCalled());

  stop();
  expect(stateListeners.size).toBe(0);
  expect(visibilityListeners.size).toBe(0);
  expect(focusListeners.size).toBe(0);
});
