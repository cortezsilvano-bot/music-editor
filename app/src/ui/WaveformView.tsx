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
 *
 * Zoom: mouse wheel (ctrl/meta optional) zooms around the cursor. Pan: drag
 * horizontally, or Shift+wheel. Seek still uses click when not dragging.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  panViewWindow,
  samplePeaksForView,
  timeToViewX,
  viewXToTime,
  zoomViewWindow,
} from "./waveformPeaks";
import { selectPyramidLevel } from "./waveformPyramid";

interface Props {
  peaks: Float32Array;
  /** Optional coarse→fine peak pyramid; zoom picks a matching level. */
  pyramidLevels?: Float32Array[];
  durationSec: number;
  beats: Float64Array | null;
  firstDownbeatSec: number | null;
  beatsPerBar: number;
  /** Live position in seconds. */
  positionSec: number;
  /** Phrase starts in seconds, from the effective grid. */
  phraseStarts?: number[];
  onSeek?: (seconds: number) => void;
}

export function WaveformView({
  peaks,
  pyramidLevels,
  durationSec,
  beats,
  firstDownbeatSec,
  beatsPerBar,
  positionSec,
  phraseStarts,
  onSeek,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(1);
  const dragRef = useRef<{ x: number; start: number; end: number; moved: boolean } | null>(null);

  // Reset zoom when the peak buffer identity changes (new track).
  useEffect(() => {
    setViewStart(0);
    setViewEnd(1);
  }, [peaks]);

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

  // Static layer: waveform plus grid for the current view window.
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const { ctx, width, height } = sizeCanvas(canvas);
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, width, height);

    const source = pyramidLevels && pyramidLevels.length
      ? selectPyramidLevel(pyramidLevels, viewEnd - viewStart, Math.max(1, width))
      : peaks;
    const displayPeaks = samplePeaksForView(source, viewStart, viewEnd, Math.max(1, width));
    const mid = height / 2;
    ctx.fillStyle = "#3f7d8c";
    for (let x = 0; x < width; x++) {
      const index = Math.floor((x / width) * displayPeaks.length);
      const amplitude = (displayPeaks[index] ?? 0) * mid;
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
      const x = timeToViewX(beats[i], durationSec, viewStart, viewEnd, width);
      if (x === null) continue;
      const isDownbeat = i >= downbeatIndex && (i - downbeatIndex) % beatsPerBar === 0;
      ctx.fillStyle = isDownbeat ? "#e4b429" : "rgba(255,255,255,0.18)";
      ctx.fillRect(
        x,
        isDownbeat ? 0 : height * 0.25,
        isDownbeat ? 1.5 : 1,
        isDownbeat ? height : height * 0.5,
      );
    }

    if (phraseStarts && phraseStarts.length) {
      ctx.fillStyle = "#7ec8e3";
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "top";
      for (let i = 0; i < phraseStarts.length; i++) {
        const x = timeToViewX(phraseStarts[i], durationSec, viewStart, viewEnd, width);
        if (x === null) continue;
        ctx.fillRect(x, 0, 2, height);
        ctx.fillText(`P${i + 1}`, x + 3, 2);
      }
    }
  }, [peaks, pyramidLevels, durationSec, beats, firstDownbeatSec, beatsPerBar, phraseStarts, viewStart, viewEnd]);

  // Moving layer: playhead only (hidden when outside the zoomed window).
  useEffect(() => {
    const canvas = headRef.current;
    if (!canvas) return;
    const { ctx, width, height } = sizeCanvas(canvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (durationSec <= 0) return;
    const x = timeToViewX(positionSec, durationSec, viewStart, viewEnd, width);
    if (x === null) return;
    ctx.fillStyle = "#f5f5ff";
    ctx.fillRect(x - 0.5, 0, 1.5, height);
  }, [positionSec, durationSec, viewStart, viewEnd]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const focus = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      if (event.shiftKey) {
        const delta = event.deltaY > 0 ? 0.15 : -0.15;
        const next = panViewWindow(viewStart, viewEnd, delta);
        setViewStart(next.start);
        setViewEnd(next.end);
        return;
      }
      const factor = event.deltaY > 0 ? 1.2 : 1 / 1.2;
      const next = zoomViewWindow(viewStart, viewEnd, focus, factor);
      setViewStart(next.start);
      setViewEnd(next.end);
    },
    [viewStart, viewEnd],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = {
        x: event.clientX,
        start: viewStart,
        end: viewEnd,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [viewStart, viewEnd],
  );

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    const deltaFrac = -dx / rect.width;
    const next = panViewWindow(drag.start, drag.end, deltaFrac);
    setViewStart(next.start);
    setViewEnd(next.end);
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (!drag || drag.moved || !onSeek || durationSec <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      onSeek(viewXToTime(x, rect.width, durationSec, viewStart, viewEnd));
    },
    [onSeek, durationSec, viewStart, viewEnd],
  );

  const zoomed = viewEnd - viewStart < 0.999;

  return (
    <div>
      <div
        ref={wrapRef}
        className="waveform-wrap"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
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
          if (e.key === "Home") {
            setViewStart(0);
            setViewEnd(1);
          }
        }}
      >
        <canvas ref={baseRef} className="waveform" />
        <canvas ref={headRef} className="waveform playhead" />
      </div>
      <div className="ge-row">
        <span className="muted" style={{ fontSize: 12 }}>
          Wheel zoom · Shift+wheel or drag to pan · Home resets
          {zoomed ? ` · view ${(viewStart * 100).toFixed(0)}–${(viewEnd * 100).toFixed(0)}%` : ""}
        </span>
        {zoomed && (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setViewStart(0);
              setViewEnd(1);
            }}
          >
            Reset zoom
          </button>
        )}
      </div>
    </div>
  );
}
