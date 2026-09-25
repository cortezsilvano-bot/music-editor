/**
 * Audio output device enumeration and recovery.
 *
 * `enumerateDevices` only returns real labels in a secure context, which the
 * desktop build has (`app://` is registered as secure) and a plain `file://`
 * page does not. Without labels the list is unusable, so that case is reported
 * rather than shown as a row of blank entries.
 *
 * Device-loss / sleep-wake recovery is software policy only: re-enumerate on
 * `devicechange`, fall back to the system default when the selection vanishes,
 * and attempt AudioContext resume on visibility/focus. Physical USB/BT hotplug
 * and sleep-wake soak remain acceptance gates (UPG-008).
 */

export interface OutputDevice {
  deviceId: string;
  label: string;
}

export interface DeviceListResult {
  supported: boolean;
  /** True when labels came back empty, which means no permission or an insecure origin. */
  labelsHidden: boolean;
  devices: OutputDevice[];
}

/** Sentinels accepted by `setAudioOutputDevice` for the OS default sink. */
export const SYSTEM_DEFAULT_OUTPUT_ID = "default";

export interface OutputRecovery {
  /** Device id to apply (SYSTEM_DEFAULT_OUTPUT_ID when falling back). */
  deviceId: string;
  /** True when the previous selection was missing from the new list. */
  fellBack: boolean;
  /** UI status when fellBack; null otherwise. */
  message: string | null;
}

export interface ContextRecoveryHandlers {
  /** Fired when the context reports suspended/interrupted. */
  onSuspended?: (message: string) => void;
  /** Fired after a successful auto-resume. */
  onResumed?: () => void;
  /**
   * When true, visibility/focus will try `context.resume()`.
   * Callers typically check whether transport still wants to play.
   */
  shouldResume?: () => boolean;
}

export async function listOutputDevices(): Promise<DeviceListResult> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { supported: false, labelsHidden: false, devices: [] };
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outputs = all.filter((d) => d.kind === "audiooutput");
    const labelsHidden = outputs.length > 0 && outputs.every((d) => d.label === "");
    return {
      supported: true,
      labelsHidden,
      devices: outputs.map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${d.deviceId.slice(0, 6)}`,
      })),
    };
  } catch {
    return { supported: false, labelsHidden: false, devices: [] };
  }
}

/**
 * Re-list outputs whenever the browser fires `devicechange` (unplug, BT drop, etc.).
 * Invokes `onChange` once immediately, then on each event. Returns an unsubscribe.
 */
export function watchOutputDevices(onChange: (result: DeviceListResult) => void): () => void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    onChange({ supported: false, labelsHidden: false, devices: [] });
    return () => {};
  }
  const refresh = (): void => {
    void listOutputDevices().then(onChange);
  };
  refresh();
  const media = navigator.mediaDevices;
  if (typeof media.addEventListener === "function") {
    media.addEventListener("devicechange", refresh);
    return () => media.removeEventListener("devicechange", refresh);
  }
  const previous = media.ondevicechange;
  media.ondevicechange = refresh;
  return () => {
    if (media.ondevicechange === refresh) media.ondevicechange = previous;
  };
}

/**
 * If `selectedId` is still in `devices`, keep it; otherwise fall back to system default.
 * Empty / "default" selections are treated as already on the default path.
 */
export function recoverOutputSelection(
  selectedId: string | null | undefined,
  devices: OutputDevice[],
): OutputRecovery {
  if (!selectedId || selectedId === SYSTEM_DEFAULT_OUTPUT_ID || selectedId === "") {
    return { deviceId: SYSTEM_DEFAULT_OUTPUT_ID, fellBack: false, message: null };
  }
  if (devices.some((d) => d.deviceId === selectedId)) {
    return { deviceId: selectedId, fellBack: false, message: null };
  }
  return {
    deviceId: SYSTEM_DEFAULT_OUTPUT_ID,
    fellBack: true,
    message: "Selected output disconnected; switched to system default.",
  };
}

export function supportsAudioOutputSelection(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof (AudioContext.prototype as unknown as Record<string, unknown>).setSinkId === "function"
  );
}

/** Route an AudioContext to a sink via setSinkId when Chromium exposes it. */
export async function setAudioOutputDevice(
  context: AudioContext,
  deviceId: string,
): Promise<boolean> {
  const ctx = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof ctx.setSinkId !== "function") return false;
  try {
    const sink =
      !deviceId || deviceId === SYSTEM_DEFAULT_OUTPUT_ID ? "" : deviceId;
    await ctx.setSinkId(sink);
    return true;
  } catch {
    return false;
  }
}

/**
 * Listen for AudioContext suspend/interrupt and try resume on visibility/focus.
 * Does not claim physical sleep-wake acceptance; browsers often still need a
 * user gesture, in which case `onSuspended` surfaces an honest status.
 */
export function attachAudioContextRecovery(
  context: AudioContext,
  handlers: ContextRecoveryHandlers = {},
): () => void {
  const suspendedMessage =
    "Audio interrupted (sleep or device change); press play if sound does not return.";

  const tryResume = (): void => {
    if (context.state === "closed") return;
    if (context.state !== "suspended" && (context.state as string) !== "interrupted") {
      return;
    }
    if (handlers.shouldResume && !handlers.shouldResume()) return;
    void context
      .resume()
      .then(() => {
        if (context.state === "running") {
          handlers.onResumed?.();
        } else {
          handlers.onSuspended?.(suspendedMessage);
        }
      })
      .catch(() => {
        handlers.onSuspended?.(suspendedMessage);
      });
  };

  const onStateChange = (): void => {
    const state = context.state as string;
    if (state === "suspended" || state === "interrupted") {
      handlers.onSuspended?.(suspendedMessage);
    }
  };

  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      tryResume();
    }
  };

  const onFocus = (): void => {
    tryResume();
  };

  // Stub/test contexts may omit EventTarget methods; skip quietly.
  const canListen =
    typeof context.addEventListener === "function" &&
    typeof context.removeEventListener === "function";
  if (canListen) {
    context.addEventListener("statechange", onStateChange);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
  }

  return () => {
    if (canListen) {
      context.removeEventListener("statechange", onStateChange);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
    }
  };
}
