/**
 * Monitoring master helpers (software).
 *
 * Pure settings/DSP utilities for the live MasterBus. This is a monitoring
 * chain for the inspector Player and Mix Mode master â€” not album-master export
 * certification and not EBU R128 compliance proof.
 */

export const MASTERING_SETTING_KEY = "mastering";

export interface MasteringSettings {
  /** When true, audio bypasses the processing chain (unity dry path). */
  bypass: boolean;
  /** Pre-EQ gain in dB. */
  inputGainDb: number;
  /** Low shelf at ~120 Hz, dB. */
  lowShelfDb: number;
  /** High shelf at ~8 kHz, dB. */
  highShelfDb: number;
  /** Soft-clip drive 0..1 (0 = near-linear, 1 = heavy tanh). */
  softClip: number;
  /** Limiter ceiling / threshold in dB (negative). */
  ceilingDb: number;
  /** Post-limiter makeup / trim in dB. */
  outputGainDb: number;
}

export const DEFAULT_MASTERING: MasteringSettings = {
  bypass: true,
  inputGainDb: 0,
  lowShelfDb: 0,
  highShelfDb: 0,
  softClip: 0.25,
  ceilingDb: -1,
  outputGainDb: 0,
};

const RANGES = {
  inputGainDb: [-24, 12],
  lowShelfDb: [-12, 12],
  highShelfDb: [-12, 12],
  softClip: [0, 1],
  ceilingDb: [-6, 0],
  outputGainDb: [-24, 6],
} as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (!(gain > 0)) return -Infinity;
  return 20 * Math.log10(gain);
}

/** Peak/RMS linear magnitude â†’ dBFS for meter display. */
export function linearToMeterDb(linear: number): number {
  if (!(linear > 0)) return -60;
  return Math.max(-60, Math.min(6, 20 * Math.log10(linear)));
}

export function clampMasteringSettings(raw: Partial<MasteringSettings> | null | undefined): MasteringSettings {
  const src = raw ?? {};
  return {
    bypass: typeof src.bypass === "boolean" ? src.bypass : DEFAULT_MASTERING.bypass,
    inputGainDb: clamp(Number(src.inputGainDb ?? DEFAULT_MASTERING.inputGainDb), ...RANGES.inputGainDb),
    lowShelfDb: clamp(Number(src.lowShelfDb ?? DEFAULT_MASTERING.lowShelfDb), ...RANGES.lowShelfDb),
    highShelfDb: clamp(Number(src.highShelfDb ?? DEFAULT_MASTERING.highShelfDb), ...RANGES.highShelfDb),
    softClip: clamp(Number(src.softClip ?? DEFAULT_MASTERING.softClip), ...RANGES.softClip),
    ceilingDb: clamp(Number(src.ceilingDb ?? DEFAULT_MASTERING.ceilingDb), ...RANGES.ceilingDb),
    outputGainDb: clamp(Number(src.outputGainDb ?? DEFAULT_MASTERING.outputGainDb), ...RANGES.outputGainDb),
  };
}

export function loadMasteringSettings(): MasteringSettings {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`music-editor.${MASTERING_SETTING_KEY}`) ?? "null");
    if (stored && typeof stored === "object") {
      return clampMasteringSettings(stored as Partial<MasteringSettings>);
    }
  } catch {
    /* Storage may be unavailable. */
  }
  return { ...DEFAULT_MASTERING };
}

export function saveMasteringSettings(settings: MasteringSettings): void {
  try {
    localStorage.setItem(
      `music-editor.${MASTERING_SETTING_KEY}`,
      JSON.stringify(clampMasteringSettings(settings)),
    );
  } catch {
    /* Storage may be unavailable. */
  }
}

/**
 * Soft-clip transfer curve.
 *
 * drive 0 â†’ near identity (tiny tanh for safety); drive 1 â†’ strong saturation.
 * Exported for unit tests without Web Audio.
 */
export function makeSoftClipCurve(drive: number, samples = 1024): Float32Array<ArrayBuffer> {
  const amount = clamp(drive, 0, 1);
  const hardness = 1 + amount * 4;
  const curve = new Float32Array(new ArrayBuffer(Math.max(2, samples) * 4));
  const denom = Math.tanh(hardness);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    if (amount < 1e-6) {
      curve[i] = x;
    } else {
      curve[i] = Math.tanh(x * hardness) / denom;
    }
  }
  return curve;
}

/** Map ceiling dB to DynamicsCompressor threshold (slightly below ceiling). */
export function ceilingToThresholdDb(ceilingDb: number): number {
  return clamp(ceilingDb - 0.5, -24, 0);
}
