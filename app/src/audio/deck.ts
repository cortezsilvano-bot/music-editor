/**
 * Two-deck mixer (research Phase K).
 *
 * The audio graph is built from native Web Audio nodes plus one AudioWorklet
 * per deck. Nothing in this file runs on the audio thread: the worklet does the
 * sample work, and everything here only sets parameters on it.
 *
 *   worklet -> low/mid/high EQ -> channel gain -> crossfader gain
 *                                                      |
 *                              both decks ------------> master gain -> safety limiter -> monitoring master -> out
 *
 * Sync uses the stored beat grids, not a visual estimate: matching tempo is a
 * ratio of two BPMs, and matching phase means moving one deck's playhead to the
 * beat that lines up with the other's. Both come from analysis that has already
 * been checked by ear in the editor.
 */
import workletUrl from "./deck-processor.js?audio-worklet";
import { deriveBeatTimes, type BeatGrid } from "../dsp/beats";
import { setAudioOutputDevice, supportsAudioOutputSelection } from "./devices";
import { MasterBus } from "./masterBus";
import type { MasteringSettings } from "./mastering";

export type DeckId = "A" | "B";

export interface DeckState {
  loaded: boolean;
  /** True when the deck is on MediaElement streaming (no full PCM / no WSOLA). */
  streaming: boolean;
  playing: boolean;
  positionSec: number;
  durationSec: number;
  /** Tempo multiplier; 1 is the track's own tempo. */
  rate: number;
  keyLock: boolean;
  loop: { startSec: number; endSec: number; beats: number } | null;
  slip: boolean;
}

export interface HotCue {
  index: number;
  timeSec: number;
}

const EQ_BANDS = { low: 200, mid: 1000, high: 4000 } as const;
/** Maximum cut applied by an EQ knob at its lowest position. */
const EQ_MIN_DB = -26;
const EQ_MAX_DB = 6;

export class Deck {
  readonly id: DeckId;
  private readonly context: AudioContext;
  private node: AudioWorkletNode | null = null;

  private readonly lowEq: BiquadFilterNode;
  private readonly midEq: BiquadFilterNode;
  private readonly highEq: BiquadFilterNode;
  private readonly channelGain: GainNode;
  readonly faderGain: GainNode;

  private sampleRate = 44100;
  private lengthSamples = 0;
  private positionSample = 0;
  private playing = false;
  private rate = 1;
  private keyLock = true;
  private loop: { startSec: number; endSec: number; beats: number } | null = null;
  private slip = false;
  /** Loop to restore when a roll is released, if one was running. */
  private rollPrevious: { startSec: number; endSec: number; beats: number } | null = null;

  /** MediaElement path for oversized tracks (bounded memory; no WSOLA). */
  private media: HTMLAudioElement | null = null;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private mediaUrl: string | null = null;
  private cancelMediaLoad: (() => void) | null = null;
  private durationHint = 0;
  private streamReady = false;
  private playRequest = 0;
  private positionTimer: number | null = null;

  grid: BeatGrid | null = null;
  durationSec = 0;
  hotCues: HotCue[] = [];

  onChange: (() => void) | null = null;

  constructor(id: DeckId, context: AudioContext) {
    this.id = id;
    this.context = context;

    this.lowEq = context.createBiquadFilter();
    this.lowEq.type = "lowshelf";
    this.lowEq.frequency.value = EQ_BANDS.low;

    this.midEq = context.createBiquadFilter();
    this.midEq.type = "peaking";
    this.midEq.frequency.value = EQ_BANDS.mid;
    this.midEq.Q.value = 0.9;

    this.highEq = context.createBiquadFilter();
    this.highEq.type = "highshelf";
    this.highEq.frequency.value = EQ_BANDS.high;

    this.channelGain = context.createGain();
    this.faderGain = context.createGain();

    this.lowEq.connect(this.midEq);
    this.midEq.connect(this.highEq);
    this.highEq.connect(this.channelGain);
    this.channelGain.connect(this.faderGain);
  }

  /** Load the worklet module once per context before any deck is used. */
  static async register(context: AudioContext): Promise<void> {
    await context.audioWorklet.addModule(workletUrl);
  }

  /** True while this deck plays via HTMLAudioElement (no full PCM in the worklet). */
  get streaming(): boolean {
    return this.media !== null;
  }

  async load(buffer: AudioBuffer, grid: BeatGrid | null): Promise<void> {
    this.clearStreamTransport();

    if (!this.node) {
      this.node = new AudioWorkletNode(this.context, "deck-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.node.port.onmessage = (event) => this.handleMessage(event.data);
    }
    try {
      this.node.connect(this.lowEq);
    } catch {
      // Already connected.
    }

    // Copy out of the AudioBuffer so the transfer does not detach anything the
    // rest of the app still holds.
    const channels: ArrayBuffer[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      channels.push(buffer.getChannelData(c).slice().buffer);
    }
    if (channels.length === 1) channels.push(channels[0].slice(0));

    this.sampleRate = buffer.sampleRate;
    this.durationSec = buffer.duration;
    this.grid = grid;
    this.positionSample = 0;
    this.playing = false;
    this.loop = null;
    this.hotCues = [];
    this.streamReady = false;

    this.node.port.postMessage({ type: "load", channels }, channels);
    this.emit();
  }

  /**
   * Load a long track via the browser media pipeline.
   *
   * Bounded memory: no full AudioBuffer, no WSOLA. EQ/gain/crossfade still apply
   * through the existing graph. Tempo is HTMLMediaElement.playbackRate (pitch
   * follows). Beat loops / slip / rolls stay unavailable.
   */
  async loadStream(blob: Blob, durationHint: number, grid: BeatGrid | null): Promise<void> {
    this.clearStreamTransport();
    this.node?.port.postMessage({ type: "eject" });
    if (this.node) {
      try {
        this.node.disconnect();
      } catch {
        // Not connected.
      }
    }

    const media = new Audio();
    this.media = media;
    this.durationHint = durationHint;
    this.mediaUrl = URL.createObjectURL(blob);
    media.preload = "metadata";
    media.playbackRate = this.rate;
    this.mediaNode = this.context.createMediaElementSource(media);
    this.mediaNode.connect(this.lowEq);

    media.onended = () => {
      if (this.media !== media) return;
      this.playing = false;
      this.stopPositionTimer();
      this.emit();
    };
    media.onerror = () => {
      if (this.media !== media) return;
      this.playing = false;
      this.stopPositionTimer();
      this.emit();
    };

    this.durationSec = durationHint;
    this.grid = grid;
    this.positionSample = 0;
    this.lengthSamples = 0;
    this.playing = false;
    this.loop = null;
    this.hotCues = [];
    this.streamReady = false;
    this.sampleRate = this.context.sampleRate;

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          media.removeEventListener("loadedmetadata", loaded);
          media.removeEventListener("error", failed);
          if (this.media === media) this.cancelMediaLoad = null;
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error(media.error?.message || "Unsupported or unreadable streaming audio"));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out opening streaming Mix deck"));
        }, 30000);
        this.cancelMediaLoad = () => {
          cleanup();
          reject(new DOMException("Track changed", "AbortError"));
        };
        media.addEventListener("loadedmetadata", loaded);
        media.addEventListener("error", failed);
        media.src = this.mediaUrl!;
        media.load();
      });
    } catch (error) {
      if (this.media === media) this.clearStreamTransport();
      throw error;
    }

    if (Number.isFinite(media.duration) && media.duration > 0) {
      this.durationSec = media.duration;
    }
    this.streamReady = true;
    this.emit();
  }

  eject(): void {
    this.playRequest++;
    this.stopPositionTimer();
    this.clearStreamTransport();
    this.node?.port.postMessage({ type: "eject" });
    this.playing = false;
    this.positionSample = 0;
    this.durationSec = 0;
    this.grid = null;
    this.loop = null;
    this.hotCues = [];
    this.lengthSamples = 0;
    this.streamReady = false;
    this.emit();
  }

  private clearStreamTransport(): void {
    this.cancelMediaLoad?.();
    this.cancelMediaLoad = null;
    this.stopPositionTimer();
    if (this.media) {
      this.media.onended = null;
      this.media.onerror = null;
      this.media.pause();
      this.media.removeAttribute("src");
      this.media.load();
      this.media = null;
    }
    this.mediaNode?.disconnect();
    this.mediaNode = null;
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = null;
    this.durationHint = 0;
    this.streamReady = false;
  }

  private startPositionTimer(): void {
    this.stopPositionTimer();
    this.positionTimer = setInterval(() => this.emit(), 50) as unknown as number;
  }

  private stopPositionTimer(): void {
    if (this.positionTimer !== null) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  private handleMessage(message: { type: string; sample?: number; length?: number }): void {
    if (message.type === "position" && typeof message.sample === "number") {
      this.positionSample = message.sample;
      this.emit();
    } else if (message.type === "loaded" && typeof message.length === "number") {
      this.lengthSamples = message.length;
      this.emit();
    } else if (message.type === "ended") {
      this.playing = false;
      this.emit();
    }
  }

  private emit(): void {
    this.onChange?.();
  }

  get state(): DeckState {
    const streaming = this.streaming;
    const positionSec = streaming
      ? (this.media?.currentTime ?? 0)
      : this.positionSample / this.sampleRate;
    const durationSec = streaming
      ? (this.media && Number.isFinite(this.media.duration) && this.media.duration > 0
          ? this.media.duration
          : (this.durationHint || this.durationSec))
      : this.durationSec;
    return {
      loaded: streaming ? this.streamReady : this.lengthSamples > 0,
      streaming,
      playing: this.playing,
      positionSec,
      durationSec,
      rate: this.rate,
      keyLock: this.keyLock,
      loop: this.loop,
      slip: this.slip,
    };
  }

  /** Track tempo after the pitch fader, which is what sync matches. */
  get effectiveBpm(): number | null {
    if (!this.grid || this.grid.anchors.length === 0) return null;
    return this.grid.anchors[0].bpm * this.rate;
  }

  async play(): Promise<void> {
    if (this.streaming) {
      if (!this.streamReady || !this.media) return;
      const request = ++this.playRequest;
      if (this.context.state === "suspended") await this.context.resume();
      if (request !== this.playRequest || !this.media) return;
      const media = this.media;
      if (media.currentTime >= this.state.durationSec) media.currentTime = 0;
      await media.play();
      if (request !== this.playRequest || this.media !== media) return;
      this.playing = true;
      this.startPositionTimer();
      this.emit();
      return;
    }
    if (this.lengthSamples === 0) return;
    if (this.context.state === "suspended") await this.context.resume();
    this.playing = true;
    this.node?.port.postMessage({ type: "play" });
    this.emit();
  }

  pause(): void {
    this.playRequest++;
    if (this.streaming && this.media) {
      this.media.pause();
      this.playing = false;
      this.stopPositionTimer();
      this.emit();
      return;
    }
    this.playing = false;
    this.node?.port.postMessage({ type: "pause" });
    this.emit();
  }

  seekSeconds(seconds: number): void {
    const duration = this.state.durationSec;
    const clamped = Math.max(0, Math.min(seconds, duration || this.durationSec));
    if (this.streaming && this.media) {
      try {
        this.media.currentTime = clamped;
      } catch {
        // Seeking before readyState can throw; ignore.
      }
      this.emit();
      return;
    }
    this.positionSample = Math.round(clamped * this.sampleRate);
    this.node?.port.postMessage({ type: "seek", sample: this.positionSample });
    this.emit();
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2, rate));
    if (this.streaming && this.media) {
      // Honest: pitch follows rate; WSOLA key-lock is not available on stream.
      this.media.playbackRate = this.rate;
      this.emit();
      return;
    }
    this.node?.port.postMessage({ type: "rate", value: this.rate });
    this.emit();
  }

  setKeyLock(enabled: boolean): void {
    this.keyLock = enabled;
    // Streaming decks cannot WSOLA-lock pitch; UI disables the control.
    if (!this.streaming) {
      this.node?.port.postMessage({ type: "keyLock", value: enabled });
    }
    this.emit();
  }

  /**
   * Briefly offset the rate, as a DJ nudges a platter.
   *
   * The rate is restored by a timer rather than a ramp because the worklet
   * reads a plain value, not an AudioParam.
   */
  nudge(amount: number, durationMs = 180): void {
    const base = this.rate;
    if (this.streaming && this.media) {
      this.media.playbackRate = base + amount;
      setTimeout(() => {
        if (this.media) this.media.playbackRate = base;
      }, durationMs);
      return;
    }
    this.node?.port.postMessage({ type: "rate", value: base + amount });
    setTimeout(() => this.node?.port.postMessage({ type: "rate", value: base }), durationMs);
  }

  setEq(band: "low" | "mid" | "high", value: number): void {
    // 0..1 knob mapped so 0.5 is flat.
    const db = value >= 0.5 ? ((value - 0.5) / 0.5) * EQ_MAX_DB : ((value - 0.5) / 0.5) * -EQ_MIN_DB;
    const node = band === "low" ? this.lowEq : band === "mid" ? this.midEq : this.highEq;
    node.gain.setTargetAtTime(db, this.context.currentTime, 0.01);
  }

  setGain(value: number): void {
    this.channelGain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, value)),
      this.context.currentTime,
      0.01,
    );
  }

  /** Beat times from the stored grid; empty when the track has none. */
  beatTimes(): Float64Array {
    if (!this.grid || this.durationSec <= 0) return new Float64Array(0);
    return deriveBeatTimes(this.grid, this.durationSec);
  }

  /**
   * Loop a whole number of beats from the current position.
   *
   * Both ends are snapped to the grid, so the loop length is exactly the beats
   * asked for and repeated passes do not drift.
   */
  setBeatLoop(beats: number): void {
    // Sample-accurate loops need the worklet buffer; no-op on stream.
    if (this.streaming) return;
    const times = this.beatTimes();
    if (times.length < 2 || beats <= 0) return;
    const position = this.state.positionSec;

    let index = 0;
    for (let i = 0; i < times.length; i++) {
      if (times[i] <= position + 1e-6) index = i;
      else break;
    }
    const endIndex = Math.min(index + beats, times.length - 1);
    if (endIndex <= index) return;

    const startSec = times[index];
    const endSec = times[endIndex];
    this.loop = { startSec, endSec, beats };
    this.node?.port.postMessage({
      type: "loop",
      start: Math.round(startSec * this.sampleRate),
      end: Math.round(endSec * this.sampleRate),
    });
    this.emit();
  }

  /** Halve or double the loop, keeping its start fixed. */
  scaleLoop(factor: number): void {
    if (!this.loop) return;
    const beats = factor > 1 ? this.loop.beats * 2 : Math.max(1, Math.round(this.loop.beats / 2));
    const times = this.beatTimes();
    let index = 0;
    for (let i = 0; i < times.length; i++) {
      if (Math.abs(times[i] - this.loop.startSec) < 1e-6) {
        index = i;
        break;
      }
    }
    const endIndex = Math.min(index + beats, times.length - 1);
    if (endIndex <= index) return;
    this.loop = { startSec: times[index], endSec: times[endIndex], beats };
    this.node?.port.postMessage({
      type: "loop",
      start: Math.round(times[index] * this.sampleRate),
      end: Math.round(times[endIndex] * this.sampleRate),
    });
    this.emit();
  }

  clearLoop(): void {
    this.loop = null;
    this.node?.port.postMessage({ type: "loop", start: -1, end: -1 });
    this.emit();
  }

  /**
   * Slip mode: keep a second playhead running through loops.
   *
   * Leaving a loop then rejoins the track where it would have been, so a roll
   * does not push the rest of the phrase late.
   */
  setSlip(enabled: boolean): void {
    if (this.streaming) return;
    this.slip = enabled;
    this.node?.port.postMessage({ type: "slip", value: enabled });
    this.emit();
  }

  /**
   * Momentary loop. Slip is forced on for the duration, which is what makes a
   * roll a roll rather than just a short loop.
   */
  startRoll(beats: number): void {
    if (this.streaming) return;
    this.rollPrevious = this.loop;
    if (!this.slip) this.node?.port.postMessage({ type: "slip", value: true });
    this.setBeatLoop(beats);
  }

  releaseRoll(): void {
    this.clearLoop();
    if (!this.slip) this.node?.port.postMessage({ type: "slip", value: false });
    const previous = this.rollPrevious;
    this.rollPrevious = null;
    if (previous) this.setBeatLoop(previous.beats);
  }

  setHotCue(index: number): void {
    const timeSec = this.state.positionSec;
    this.hotCues = [...this.hotCues.filter((c) => c.index !== index), { index, timeSec }].sort(
      (a, b) => a.index - b.index,
    );
    this.emit();
  }

  jumpToHotCue(index: number): void {
    const cue = this.hotCues.find((c) => c.index === index);
    if (cue) this.seekSeconds(cue.timeSec);
  }

  clearHotCue(index: number): void {
    this.hotCues = this.hotCues.filter((c) => c.index !== index);
    this.emit();
  }

  /**
   * Match this deck's tempo to another's.
   *
   * The ratio is folded into the nearest octave first, so syncing a 174 BPM
   * track to a 128 one gives a usable 0.74x rather than an unplayable 1.36x.
   */
  syncTempoTo(other: Deck): boolean {
    const mine = this.grid?.anchors[0]?.bpm;
    const theirs = other.effectiveBpm;
    if (!mine || !theirs) return false;
    let ratio = theirs / mine;
    while (ratio > 1.42) ratio /= 2;
    while (ratio < 0.71) ratio *= 2;
    this.setRate(ratio);
    return true;
  }

  /**
   * Align this deck's playhead so its next beat lands with the other's.
   *
   * `bar` aligns downbeats instead, which is what keeps phrases together.
   */
  syncPhaseTo(other: Deck, bar = false): boolean {
    const mineBeats = this.beatTimes();
    const theirBeats = other.beatTimes();
    if (mineBeats.length < 2 || theirBeats.length < 2) return false;

    const otherPosition = other.state.positionSec;
    const step = bar ? (other.grid?.beatsPerBar ?? 4) : 1;

    // Where is the other deck within its current beat (or bar)?
    let otherIndex = 0;
    for (let i = 0; i < theirBeats.length; i++) {
      if (theirBeats[i] <= otherPosition + 1e-6) otherIndex = i;
      else break;
    }
    const otherBeatStart = theirBeats[otherIndex];
    const otherNext = theirBeats[Math.min(otherIndex + 1, theirBeats.length - 1)];
    const beatLength = otherNext - otherBeatStart;
    if (beatLength <= 0) return false;
    const phase = (otherPosition - otherBeatStart) / beatLength;

    // Land on the beat of ours nearest the current position, offset by phase.
    const myPosition = this.state.positionSec;
    let myIndex = 0;
    for (let i = 0; i < mineBeats.length; i++) {
      if (mineBeats[i] <= myPosition + 1e-6) myIndex = i;
      else break;
    }
    if (bar && this.grid) {
      const beatsPerBar = this.grid.beatsPerBar;
      myIndex = Math.round(myIndex / beatsPerBar) * beatsPerBar;
      myIndex = Math.max(0, Math.min(myIndex, mineBeats.length - 1 - step));
    }
    const myBeatStart = mineBeats[myIndex];
    const myNext = mineBeats[Math.min(myIndex + 1, mineBeats.length - 1)];
    const myBeatLength = myNext - myBeatStart;

    this.seekSeconds(myBeatStart + phase * myBeatLength);
    return true;
  }
}

/**
 * The mixer: two decks, a crossfader and a master limiter.
 *
 * The limiter is a DynamicsCompressor with a hard ratio rather than a true
 * brickwall. It stops two decks summing into clipping, which is its job here;
 * it is not a mastering limiter and is not presented as one.
 */
export class Mixer {
  readonly context: AudioContext;
  readonly deckA: Deck;
  readonly deckB: Deck;
  private readonly master: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  readonly masterBus: MasterBus;
  private crossfade = 0.5;

  constructor(context: AudioContext) {
    this.context = context;
    this.deckA = new Deck("A", context);
    this.deckB = new Deck("B", context);

    this.master = context.createGain();
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;

    this.deckA.faderGain.connect(this.master);
    this.deckB.faderGain.connect(this.master);
    this.master.connect(this.limiter);
    // Monitoring master (EQ / soft-clip / ceiling) after the deck safety limiter.
    this.masterBus = new MasterBus(context);
    this.limiter.connect(this.masterBus.input);

    this.setCrossfade(0.5);
  }

  static async register(context: AudioContext): Promise<void> {
    await Deck.register(context);
  }

  /**
   * Equal-power crossfade.
   *
   * A linear fade dips in level at the centre, which is exactly where a
   * transition lives; the sine/cosine pair holds perceived loudness constant.
   */
  setCrossfade(value: number): void {
    const x = Math.max(0, Math.min(1, value));
    this.crossfade = x;
    const now = this.context.currentTime;
    this.deckA.faderGain.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2), now, 0.01);
    this.deckB.faderGain.gain.setTargetAtTime(Math.cos(((1 - x) * Math.PI) / 2), now, 0.01);
  }

  get crossfadePosition(): number {
    return this.crossfade;
  }

  setMasterGain(value: number): void {
    this.master.gain.setTargetAtTime(
      Math.max(0, Math.min(1, value)),
      this.context.currentTime,
      0.01,
    );
  }

  /** Apply monitoring-master settings (shared localStorage key with inspector). */
  applyMastering(settings: Partial<MasteringSettings>): void {
    this.masterBus.applySettings(settings);
  }

  /** Gain reduction the limiter is applying, in dB. Negative means working. */
  get limiterReductionDb(): number {
    return this.limiter.reduction;
  }

  /**
   * Route the master output to a specific device.
   *
   * Shared with Player via `setAudioOutputDevice` (Chromium `setSinkId`).
   */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    return setAudioOutputDevice(this.context, deviceId);
  }

  static get supportsOutputSelection(): boolean {
    return supportsAudioOutputSelection();
  }

  /** What the browser reports about the output path, for the settings panel. */
  get latency(): { base: number; output: number; sampleRate: number } {
    return {
      base: this.context.baseLatency ?? 0,
      output: this.context.outputLatency ?? 0,
      sampleRate: this.context.sampleRate,
    };
  }
}

/** Equal-power gain pair, exported for testing. */
export function crossfadeGains(position: number): { a: number; b: number } {
  const x = Math.max(0, Math.min(1, position));
  return { a: Math.cos((x * Math.PI) / 2), b: Math.cos(((1 - x) * Math.PI) / 2) };
}

/** Tempo ratio to match `fromBpm` to `toBpm`, folded to a playable octave. */
export function syncRatio(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return 1;
  let ratio = toBpm / fromBpm;
  let guard = 0;
  while (ratio > 1.42 && guard++ < 8) ratio /= 2;
  guard = 0;
  while (ratio < 0.71 && guard++ < 8) ratio *= 2;
  return ratio;
}
