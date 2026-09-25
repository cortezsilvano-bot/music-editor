/**
 * Live monitoring master bus (Web Audio).
 *
 * Graph: input -> dry|wet where wet is
 *   inputGain -> lowShelf -> highShelf -> softClip -> limiter -> outputGain -> analyser -> destination
 *
 * Settings are monitoring-only. Export pipelines are not processed through this
 * bus unless a future export path is explicitly wired.
 */

import {
  type MasteringSettings,
  DEFAULT_MASTERING,
  clampMasteringSettings,
  dbToGain,
  makeSoftClipCurve,
  ceilingToThresholdDb,
  linearToMeterDb,
} from "./mastering";

export interface MasterMeterReading {
  /** Approx peak from analyser time domain, dBFS. */
  peakDb: number;
  /** Approx RMS from analyser time domain, dBFS. */
  rmsDb: number;
  /** DynamicsCompressor.reduction (negative when working). */
  reductionDb: number;
}

export class MasterBus {
  readonly context: AudioContext;
  /** Connect playback sources here. */
  readonly input: GainNode;
  readonly analyser: AnalyserNode;

  private readonly dryGain: GainNode;
  private readonly wetGate: GainNode;
  private readonly inputGain: GainNode;
  private readonly lowShelf: BiquadFilterNode;
  private readonly highShelf: BiquadFilterNode;
  private readonly softClip: WaveShaperNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly outputGain: GainNode;
  private readonly meterBuffer: Float32Array<ArrayBuffer>;
  private settings: MasteringSettings = { ...DEFAULT_MASTERING };

  constructor(context: AudioContext) {
    this.context = context;
    this.input = context.createGain();
    this.input.gain.value = 1;

    this.dryGain = context.createGain();
    this.wetGate = context.createGain();
    this.inputGain = context.createGain();
    this.outputGain = context.createGain();

    this.lowShelf = context.createBiquadFilter();
    this.lowShelf.type = "lowshelf";
    this.lowShelf.frequency.value = 120;

    this.highShelf = context.createBiquadFilter();
    this.highShelf.type = "highshelf";
    this.highShelf.frequency.value = 8000;

    this.softClip = context.createWaveShaper();
    this.softClip.oversample = "2x";
    this.softClip.curve = makeSoftClipCurve(DEFAULT_MASTERING.softClip);

    this.limiter = context.createDynamicsCompressor();
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.3;
    this.meterBuffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    // Dry path (bypass).
    this.input.connect(this.dryGain);
    this.dryGain.connect(context.destination);

    // Wet processing path.
    this.input.connect(this.wetGate);
    this.wetGate.connect(this.inputGain);
    this.inputGain.connect(this.lowShelf);
    this.lowShelf.connect(this.highShelf);
    this.highShelf.connect(this.softClip);
    this.softClip.connect(this.limiter);
    this.limiter.connect(this.outputGain);
    this.outputGain.connect(this.analyser);
    this.analyser.connect(context.destination);

    this.applySettings(DEFAULT_MASTERING);
  }

  get currentSettings(): MasteringSettings {
    return { ...this.settings };
  }

  applySettings(raw: Partial<MasteringSettings>): void {
    const s = clampMasteringSettings({ ...this.settings, ...raw });
    this.settings = s;
    const now = this.context.currentTime;
    const tau = 0.02;

    this.dryGain.gain.setTargetAtTime(s.bypass ? 1 : 0, now, tau);
    this.wetGate.gain.setTargetAtTime(s.bypass ? 0 : 1, now, tau);

    this.inputGain.gain.setTargetAtTime(dbToGain(s.inputGainDb), now, tau);
    this.outputGain.gain.setTargetAtTime(dbToGain(s.outputGainDb), now, tau);

    this.lowShelf.gain.setTargetAtTime(s.lowShelfDb, now, tau);
    this.highShelf.gain.setTargetAtTime(s.highShelfDb, now, tau);

    this.softClip.curve = makeSoftClipCurve(s.softClip);
    this.limiter.threshold.setTargetAtTime(ceilingToThresholdDb(s.ceilingDb), now, tau);
  }

  /** Live meter from AnalyserNode (not offline BS.1770). */
  readMeter(): MasterMeterReading {
    const buf = this.meterBuffer;
    this.analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > peak) peak = v;
      sumSq += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, buf.length));
    return {
      peakDb: linearToMeterDb(peak),
      rmsDb: linearToMeterDb(rms),
      reductionDb: this.limiter.reduction,
    };
  }

  get limiterReductionDb(): number {
    return this.limiter.reduction;
  }

  disconnect(): void {
    try {
      this.input.disconnect();
      this.dryGain.disconnect();
      this.wetGate.disconnect();
      this.inputGain.disconnect();
      this.lowShelf.disconnect();
      this.highShelf.disconnect();
      this.softClip.disconnect();
      this.limiter.disconnect();
      this.outputGain.disconnect();
      this.analyser.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}
