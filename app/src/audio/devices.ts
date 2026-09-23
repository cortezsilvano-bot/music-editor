/**
 * Audio output device enumeration.
 *
 * `enumerateDevices` only returns real labels in a secure context, which the
 * desktop build has (`app://` is registered as secure) and a plain `file://`
 * page does not. Without labels the list is unusable, so that case is reported
 * rather than shown as a row of blank entries.
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
