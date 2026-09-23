/**
 * Manual beat-grid correction (research Phase D, editor half).
 *
 * Each control calls a pure function from `gridEdit` and hands the result
 * straight back to be persisted as a manual grid. The automatic result is never
 * modified, so "Revert" always has something to go back to.
 */
import { useCallback, useRef, useState } from "react";
import type { BeatGrid } from "../dsp/beats";
import {
  gridBpm,
  nudgeGrid,
  scaleTempo,
  setDownbeat,
  setFirstBeat,
  setGridBpm,
  tapTempo,
} from "../dsp/gridEdit";

interface Props {
  grid: BeatGrid;
  durationSec: number;
  /** Current playhead, used as the target for "set first beat" and "downbeat". */
  positionSec: number;
  isManual: boolean;
  onChange: (grid: BeatGrid) => void;
  onRevert: () => void;
}

/** Nudge step in seconds. One millisecond is about the limit of audibility. */
const FINE_NUDGE = 0.001;
const COARSE_NUDGE = 0.01;

export function GridEditor({
  grid,
  durationSec,
  positionSec,
  isManual,
  onChange,
  onRevert,
}: Props) {
  const [bpmDraft, setBpmDraft] = useState("");
  const [tapCount, setTapCount] = useState(0);
  const tapsRef = useRef<number[]>([]);

  const tap = useCallback(() => {
    const now = performance.now() / 1000;
    const taps = tapsRef.current;
    // A long gap starts a fresh run rather than polluting the median.
    if (taps.length > 0 && now - taps[taps.length - 1] > 2) taps.length = 0;
    taps.push(now);
    setTapCount(taps.length);
    const bpm = tapTempo(taps);
    if (bpm !== null) onChange(setGridBpm(grid, bpm));
  }, [grid, onChange]);

  const resetTaps = useCallback(() => {
    tapsRef.current = [];
    setTapCount(0);
  }, []);

  const applyBpm = useCallback(() => {
    const parsed = Number.parseFloat(bpmDraft);
    if (Number.isFinite(parsed) && parsed > 0) onChange(setGridBpm(grid, parsed));
  }, [bpmDraft, grid, onChange]);

  return (
    <div className="grid-editor">
      <div className="ge-row">
        <span className="ge-label">Grid</span>
        <span className="value">
          {gridBpm(grid).toFixed(2)} BPM · downbeat {grid.firstDownbeatSec.toFixed(3)} s
        </span>
        {isManual ? (
          <span className="conf amber">manual</span>
        ) : (
          <span className="muted">automatic</span>
        )}
      </div>

      <div className="ge-row">
        <span className="ge-label">At playhead</span>
        <button className="ghost small" onClick={() => onChange(setFirstBeat(grid, positionSec, durationSec))}>
          Set beat
        </button>
        <button className="ghost small" onClick={() => onChange(setDownbeat(grid, positionSec, durationSec))}>
          Set downbeat
        </button>
      </div>

      <div className="ge-row">
        <span className="ge-label">Nudge</span>
        <button className="ghost small" onClick={() => onChange(nudgeGrid(grid, -COARSE_NUDGE))}>
          ◀◀ 10ms
        </button>
        <button className="ghost small" onClick={() => onChange(nudgeGrid(grid, -FINE_NUDGE))}>
          ◀ 1ms
        </button>
        <button className="ghost small" onClick={() => onChange(nudgeGrid(grid, FINE_NUDGE))}>
          1ms ▶
        </button>
        <button className="ghost small" onClick={() => onChange(nudgeGrid(grid, COARSE_NUDGE))}>
          10ms ▶▶
        </button>
      </div>

      <div className="ge-row">
        <span className="ge-label">Tempo</span>
        <button className="ghost small" onClick={() => onChange(scaleTempo(grid, 0.5))}>
          ÷2
        </button>
        <button className="ghost small" onClick={() => onChange(scaleTempo(grid, 2))}>
          ×2
        </button>
        <input
          className="bpm"
          placeholder="set BPM"
          value={bpmDraft}
          onChange={(e) => setBpmDraft(e.target.value)}
          onBlur={applyBpm}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyBpm();
          }}
        />
        <button className="ghost small" onClick={tap} onDoubleClick={resetTaps}>
          Tap{tapCount > 0 ? ` (${tapCount})` : ""}
        </button>
      </div>

      <div className="ge-row">
        <span className="ge-label" />
        <button className="ghost small" onClick={onRevert} disabled={!isManual}>
          Revert to automatic
        </button>
        <span className="muted">
          {grid.isFixed ? "fixed" : `dynamic · ${grid.anchors.length} anchors`}
        </span>
      </div>
    </div>
  );
}
