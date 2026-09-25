/**
 * Single-deck playback with a beat click.
 *
 * The click is the point of this: it is how you tell whether a detected grid is
 * actually right. A BPM readout you cannot hear against the music is a number
 * you have to take on trust, and detected grids are wrong often enough that
 * trusting them silently is how bad cue points get made.
 *
 * Buffered playback uses the audio-context clock. Long files use the browser's
 * streaming media clock; their beat click is an audition aid, not sample-accurate sync.
 */

import { setAudioOutputDevice } from "./devices";
import { MasterBus } from "./masterBus";
import type { MasteringSettings } from "./mastering";

export type PlayerState = "stopped" | "playing" | "paused";

export interface PlayerListener {
  onStateChange?: (state: PlayerState) => void;
  onEnded?: () => void;
  onError?: (message: string) => void;
}

/** How far ahead click events are scheduled, in seconds. */
const LOOKAHEAD = 0.25;
/** How often the scheduler wakes, in milliseconds. */
const SCHEDULE_INTERVAL = 50;

export class Player {
  private readonly context: AudioContext;
  private readonly output: GainNode;
  private readonly masterBus: MasterBus;
  private readonly clickGain: GainNode;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private mediaUrl: string | null = null;
  private cancelMediaLoad: (() => void) | null = null;
  private durationHint = 0;
  private playRequest = 0;

  /** Context time at which the current playback run started. */
  private startedAt = 0;
  /** Offset into the track that run began from. */
  private startOffset = 0;
  private state: PlayerState = "stopped";

  private beats: Float64Array | null = null;
  private downbeatIndex = 0;
  private beatsPerBar = 4;
  private nextBeat = 0;
  private timer: number | null = null;
  private clickEnabled = false;
  private pendingClicks = new Set<OscillatorNode>();

  private listener: PlayerListener = {};

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext();
    this.output = this.context.createGain();
    this.masterBus = new MasterBus(this.context);
    this.output.connect(this.masterBus.input);
    this.clickGain = this.context.createGain();
    this.clickGain.gain.value = 0.35;
    // Beat click stays dry so grid audition is not coloured by the monitor master.
    this.clickGain.connect(this.context.destination);
  }

  get audioContext(): AudioContext {
    return this.context;
  }

  /** Monitoring master bus (inspector playback). */
  get mastering(): MasterBus {
    return this.masterBus;
  }

  applyMastering(settings: Partial<MasteringSettings>): void {
    this.masterBus.applySettings(settings);
  }

  setListener(listener: PlayerListener): void {
    this.listener = listener;
  }

  /** Replace the loaded track. Stops whatever was playing. */
  load(buffer: AudioBuffer): void {
    this.unload();
    this.buffer = buffer;
    this.startOffset = 0;
  }

  /** A Blob URL lets Chromium seek/read compressed bytes without full PCM in JS. */
  async loadStream(blob: Blob, durationHint: number): Promise<void> {
    this.unload();
    const media = new Audio();
    this.media = media; this.durationHint = durationHint;
    this.mediaUrl = URL.createObjectURL(blob);
    media.preload = "metadata";
    this.mediaNode = this.context.createMediaElementSource(media);
    this.mediaNode.connect(this.output);
    media.onwaiting = () => this.stopScheduler();
    media.onseeking = () => this.stopScheduler();
    const resumeClicks = () => {
      if (this.media === media && !media.paused && this.state === "playing") { this.syncClickCursor(); this.startScheduler(); }
    };
    media.onplaying = resumeClicks; media.onseeked = resumeClicks;
    media.onended = () => {
      if (this.media !== media) return;
      this.stop(); this.listener.onEnded?.();
    };
    media.onerror = () => {
      if (this.media !== media) return;
      this.stopScheduler(); this.setState("paused");
      this.listener.onError?.(media.error?.message || "Streaming audio could not be read");
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer); media.removeEventListener("loadedmetadata", loaded); media.removeEventListener("error", failed);
          if (this.media === media) this.cancelMediaLoad = null;
        };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error(media.error?.message || "Unsupported or unreadable streaming audio")); };
        const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out opening streaming audio")); }, 30000);
        this.cancelMediaLoad = () => { cleanup(); reject(new DOMException("Track changed", "AbortError")); };
        media.addEventListener("loadedmetadata", loaded); media.addEventListener("error", failed);
        media.src = this.mediaUrl!; media.load();
      });
    } catch (error) { if (this.media === media) this.unload(); throw error; }
  }

  get streaming(): boolean { return this.media !== null; }

  unload(): void {
    this.stop(); this.cancelMediaLoad?.(); this.cancelMediaLoad = null;
    if (this.media) {
      this.media.onended = this.media.onerror = this.media.onwaiting = this.media.onplaying = this.media.onseeking = this.media.onseeked = null;
      this.media.removeAttribute("src"); this.media.load(); this.media = null;
    }
    this.mediaNode?.disconnect(); this.mediaNode = null;
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = null; this.buffer = null; this.durationHint = 0;
  }

  setGrid(beats: Float64Array | null, firstDownbeatSec: number, beatsPerBar: number): void {
    this.clearClicks();
    this.beats = beats;
    this.beatsPerBar = beatsPerBar;
    this.downbeatIndex = 0;
    if (beats) {
      for (let i = 0; i < beats.length; i++) {
        if (beats[i] >= firstDownbeatSec - 1e-6) {
          this.downbeatIndex = i;
          break;
        }
      }
    }
    this.syncClickCursor();
  }

  setClickEnabled(enabled: boolean): void {
    this.clearClicks();
    this.clickEnabled = enabled;
    if (enabled && this.state === "playing") this.syncClickCursor();
  }

  get clickIsEnabled(): boolean {
    return this.clickEnabled;
  }

  setVolume(value: number): void {
    this.output.gain.value = Math.max(0, Math.min(1, value));
  }

  get playerState(): PlayerState {
    return this.state;
  }

  get duration(): number {
    if (this.media) return Number.isFinite(this.media.duration) ? this.media.duration : this.durationHint;
    return this.buffer?.duration ?? 0;
  }

  /** Current position in seconds, derived from the audio clock. */
  get position(): number {
    if (this.media) return this.media.currentTime;
    if (this.state !== "playing") return this.startOffset;
    const elapsed = this.context.currentTime - this.startedAt;
    return Math.min(this.startOffset + elapsed, this.duration);
  }

  async play(): Promise<void> {
    if ((!this.buffer && !this.media) || this.state === "playing") return;
    const request = ++this.playRequest;
    // Browsers start contexts suspended until a gesture; this is that gesture.
    if (this.context.state === "suspended") await this.context.resume();
    if (request !== this.playRequest) return;
    if (this.media) {
      const media = this.media;
      if (media.currentTime >= this.duration) media.currentTime = 0;
      await media.play();
      if (request !== this.playRequest || this.media !== media) return;
      this.setState("playing"); this.syncClickCursor(); this.startScheduler(); return;
    }

    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.output);
    source.onended = () => {
      // Fires on manual stop too; only treat a natural finish as an end.
      if (this.source === source && this.state === "playing") {
        this.state = "stopped";
        this.startOffset = 0;
        this.stopScheduler();
        this.listener.onStateChange?.(this.state);
        this.listener.onEnded?.();
      }
    };

    const offset = this.startOffset >= this.duration ? 0 : this.startOffset;
    this.startOffset = offset;
    this.startedAt = this.context.currentTime;
    source.start(0, offset);
    this.source = source;
    this.setState("playing");

    this.syncClickCursor();
    this.startScheduler();
  }

  pause(): void {
    this.playRequest++;
    if (this.media) { this.media.pause(); this.stopScheduler(); this.setState("paused"); return; }
    if (this.state !== "playing") return;
    const at = this.position;
    this.teardownSource();
    this.startOffset = at;
    this.setState("paused");
  }

  stop(): void {
    this.playRequest++;
    if (this.media) {
      this.media.pause();
      if (this.media.readyState >= 1) this.media.currentTime = 0;
    }
    this.teardownSource();
    this.startOffset = 0;
    this.setState("stopped");
  }

  /** Move the playhead, continuing to play if it was playing. */
  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const target = Math.max(0, Math.min(seconds, this.duration));
    if (this.media) {
      this.stopScheduler();
      try { this.media.currentTime = target; } catch (error) { this.listener.onError?.(String(error)); }
      return;
    }
    const wasPlaying = this.state === "playing";
    this.teardownSource();
    this.startOffset = target;
    if (wasPlaying) {
      void this.play().catch(error => this.listener.onError?.(String(error)));
    } else {
      this.setState(this.state === "stopped" ? "stopped" : "paused");
    }
  }

  /**
   * Route playback to a specific output when Chromium exposes setSinkId.
   * Shared helper with Mix Mode Mixer.
   */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    return setAudioOutputDevice(this.context, deviceId);
  }

  dispose(): void {
    this.unload();
    this.masterBus.disconnect();
    void this.context.close();
  }

  private setState(state: PlayerState): void {
    if (this.state === state) return;
    this.state = state;
    this.listener.onStateChange?.(state);
  }

  private teardownSource(): void {
    this.playRequest++;
    this.stopScheduler();
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.state === "playing") this.setState("paused");
  }

  /** Point the click cursor at the first beat at or after the playhead. */
  private syncClickCursor(): void {
    if (!this.beats) return;
    const now = this.position;
    this.nextBeat = this.beats.length;
    for (let i = 0; i < this.beats.length; i++) {
      if (this.beats[i] >= now) {
        this.nextBeat = i;
        break;
      }
    }
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.timer = setInterval(() => this.scheduleClicks(), SCHEDULE_INTERVAL) as unknown as number;
  }

  private stopScheduler(): void {
    this.clearClicks();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Schedule click tones slightly ahead of the playhead.
   *
   * Web Audio only guarantees timing for events booked in advance, so clicks
   * are queued a fraction of a second early rather than fired when they are due.
   */
  private scheduleClicks(): void {
    if (!this.clickEnabled || !this.beats || this.state !== "playing") return;
    const horizon = this.position + LOOKAHEAD;

    while (this.nextBeat < this.beats.length && this.beats[this.nextBeat] <= horizon) {
      const beatTime = this.beats[this.nextBeat];
      const delay = beatTime - this.position;
      if (delay >= 0) {
        const isDownbeat =
          this.nextBeat >= this.downbeatIndex &&
          (this.nextBeat - this.downbeatIndex) % this.beatsPerBar === 0;
        this.click(this.context.currentTime + delay, isDownbeat);
      }
      this.nextBeat++;
    }
  }

  private clearClicks(): void {
    for (const osc of this.pendingClicks) {
      osc.stop();
      osc.disconnect();
    }
    this.pendingClicks.clear();
  }

  /** Short pitched blip; downbeats an octave up so bars are audible. */
  private click(at: number, isDownbeat: boolean): void {
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.frequency.value = isDownbeat ? 1600 : 800;
    osc.connect(gain);
    gain.connect(this.clickGain);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(1, at + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
    this.pendingClicks.add(osc);
    osc.onended = () => { this.pendingClicks.delete(osc); osc.disconnect(); gain.disconnect(); };
    osc.start(at);
    osc.stop(at + 0.05);
  }
}
