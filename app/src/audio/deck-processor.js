/**
 * Deck audio processor.
 *
 * Runs on the audio thread. The real-time rules from the brief apply here and
 * nowhere else in the app: no allocation, no locks, no logging, no unbounded
 * work. Everything it needs is allocated when a track is loaded, on the main
 * thread, and transferred in.
 *
 * Position is reported back to the UI on a timer rather than every block: at
 * 128 frames a block that would be ~375 messages a second per deck, which costs
 * more than the audio does.
 */
import { Wsola } from "./wsola.js";

/** How often to post the playhead back to the main thread, in seconds. */
const REPORT_INTERVAL = 1 / 30;

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wsola = null;
    this.playing = false;
    this.rate = 1;
    this.keyLock = true;
    this.loopStart = -1;
    this.loopEnd = -1;
    this.lastReport = 0;
    this.trackLength = 0;
    /**
     * Slip mode: a second playhead that keeps advancing through a loop as if
     * the loop were not there. Leaving the loop jumps here, so the track lands
     * where it would have been - which is what makes a loop roll usable mid-mix
     * instead of throwing the phrase out.
     */
    this.slip = false;
    this.slipPosition = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    switch (message.type) {
      case "load": {
        // Channels arrive as transferred ArrayBuffers: no copy, no allocation
        // on the audio thread beyond the views.
        const channels = message.channels.map((buffer) => new Float32Array(buffer));
        this.wsola = new Wsola(channels);
        this.trackLength = channels[0] ? channels[0].length : 0;
        this.playing = false;
        this.loopStart = -1;
        this.loopEnd = -1;
        this.port.postMessage({ type: "loaded", length: this.trackLength });
        break;
      }
      case "play":
        this.playing = this.wsola !== null;
        break;
      case "pause":
        this.playing = false;
        break;
      case "seek":
        if (this.wsola) this.wsola.seek(message.sample);
        break;
      case "rate":
        this.rate = message.value;
        break;
      case "keyLock":
        this.keyLock = message.value;
        break;
      case "loop": {
        const clearing = message.end <= message.start || message.start < 0;
        if (clearing && this.slip && this.wsola && this.looping) {
          // Rejoin the timeline where the slip playhead reached.
          this.wsola.seek(Math.min(this.slipPosition, this.trackLength));
        }
        // -1 clears. Positions are sample-exact so beat loops do not drift.
        this.loopStart = message.start;
        this.loopEnd = message.end;
        if (!clearing && this.wsola) this.slipPosition = this.wsola.position;
        break;
      }
      case "slip":
        this.slip = message.value;
        if (this.wsola) this.slipPosition = this.wsola.position;
        break;
      case "eject":
        this.wsola = null;
        this.playing = false;
        this.trackLength = 0;
        break;
      default:
        break;
    }
  }

  get looping() {
    return this.loopEnd > this.loopStart && this.loopStart >= 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;

    if (!this.wsola || !this.playing) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    // A loop wraps mid-block when its end falls inside this render quantum.
    // Splitting the block keeps the wrap sample-accurate rather than rounding
    // it to a block boundary, which is what makes a beat loop stay in time.
    let written = 0;
    while (written < frames) {
      let want = frames - written;

      if (this.looping) {
        const remaining = this.loopEnd - this.wsola.position;
        if (remaining <= 0) {
          this.wsola.seek(this.loopStart);
          continue;
        }
        // Convert remaining source samples into output frames at this rate.
        const framesLeft = Math.ceil(remaining / Math.max(this.rate, 1e-6));
        if (framesLeft < want) want = Math.max(1, framesLeft);
      }

      const slice = this.scratchFor(output, written, want);
      const produced = this.wsola.process(slice, this.rate, this.keyLock);
      if (produced === 0) break;
      written += produced;
    }

    // Anything not produced is silence: end of track, or a loop that ran dry.
    for (let c = 0; c < output.length; c++) {
      for (let i = written; i < frames; i++) output[c][i] = 0;
    }

    if (written === 0 && this.playing) {
      this.playing = false;
      this.port.postMessage({ type: "ended" });
    }

    // The slip playhead ignores the loop entirely: it advances by the source
    // time this block consumed, as though playback had run straight on.
    if (this.slip) {
      this.slipPosition += written * this.rate;
    } else {
      this.slipPosition = this.wsola.position;
    }

    if (currentTime - this.lastReport >= REPORT_INTERVAL) {
      this.lastReport = currentTime;
      this.port.postMessage({
        type: "position",
        sample: this.wsola.position,
        slip: this.slip ? this.slipPosition : null,
      });
    }

    return true;
  }

  /**
   * Views onto the output buffers for a partial block.
   *
   * `subarray` creates a view, not a copy, so this does not allocate audio
   * memory; only the small holder array is reused.
   */
  scratchFor(output, offset, length) {
    if (!this.scratch || this.scratch.length !== output.length) {
      this.scratch = new Array(output.length);
    }
    for (let c = 0; c < output.length; c++) {
      this.scratch[c] = output[c].subarray(offset, offset + length);
    }
    return this.scratch;
  }
}

registerProcessor("deck-processor", DeckProcessor);
