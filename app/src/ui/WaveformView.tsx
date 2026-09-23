/**
 * Waveform with beat/bar overlays, a playhead, and click-to-seek.
 *
 * Drawn from a precomputed peak envelope, so redraw cost scales with canvas
 * width rather than track length. Beat positions come from the analytic grid
 * via deriveBeatTimes - they are not stored per beat.
 *
 * The static layer (waveform, grid) and the moving layer (playhead) are drawn
 * on separate canvases so following the playhead does not repaint the whole
 * waveform sixty times a second.
 */
import { useCallback, useEffect, useRef } from "react";

interface Props {
  peaks: Float32Array;
  durationSec: number;
  beats: Float64Array | null;
  firstDownbeatSec: number | null;
  beatsPerBar: number;
  /** Live position in seconds. */
  positionSec: number;
  onSeek?: (seconds: number) => void;
}

export function WaveformView({
  peaks,
  durationSec,
  beats,
  firstDownbeatSec,
  beatsPerBar,
  positionSec,
  onSeek,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLCanvasElement | null>(null);

  const sizeCanvas = (canvas: HTMLCanvasElement) => {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
  };

  // Static layer: waveform plus grid.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const { ctx, width, height } = sizeCanvas(canvas);
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, width, height);

    const mid = height / 2;
    ctx.fillStyle = "#3f7d8c";
    for (let x = 0; x < width; x++) {
      const index = Math.floor((x / width) * peaks.length);
      const amplitude = (peaks[index] ?? 0) * mid;
      ctx.fillRect(x, mid - amplitude, 1, Math.max(1, amplitude * 2));
    }

    if (!beats || durationSec <= 0) return;

    let downbeatIndex = 0;
    if (firstDownbeatSec !== null) {
      for (let i = 0; i < beats.length; i++) {
        if (beats[i] >= firstDownbeatSec - 1e-6) {
          downbeatIndex = i;
          break;
        }
      }
    }

    for (let i = 0; i < beats.length; i++) {
      const x = (beats[i] / durationSec) * width;
      if (x < 0 || x > width) continue;
      const isDownbeat = i >= downbeatIndex && (i - downbeatIndex) % beatsPerBar === 0;
      ctx.fillStyle = isDownbeat ? "#e4b429" : "rgba(255,255,255,0.18)";
      ctx.fillRect(
        x,
        isDownbeat ? 0 : height * 0.25,
        isDownbeat ? 1.5 : 1,
        isDownbeat ? height : height * 0.5,
      );
    }
  }, [peaks, durationSec, beats, firstDownbeatSec, beatsPerBar]);

  // Moving layer: playhead only.
  useEffect(() => {
    const canvas = headRef.current;
    if (!canvas) return;
    const { ctx, width, height } = sizeCanvas(canvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (durationSec <= 0) return;
    const x = (positionSec / durationSec) * width;
    ctx.fillStyle = "#f5f5ff";
    ctx.fillRect(x - 0.5, 0, 1.5, height);
  }, [positionSec, durationSec]);

  const handleSeek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onSeek || durationSec <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = (event.clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(1, fraction)) * durationSec);
    },
    [onSeek, durationSec],
  );

  return (
    <div
      className="waveform-wrap"
      onClick={handleSeek}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec)}
      aria-valuenow={Math.round(positionSec)}
      onKeyDown={(e) => {
        if (!onSeek) return;
        if (e.key === "ArrowLeft") onSeek(Math.max(0, positionSec - 5));
        if (e.key === "ArrowRight") onSeek(Math.min(durationSec, positionSec + 5));
      }}
    >
      <canvas ref={baseRef} className="waveform" />
      <canvas ref={headRef} className="waveform playhead" />
    </div>
  );
}
