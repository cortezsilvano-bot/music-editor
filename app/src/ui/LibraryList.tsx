import type { ReactNode } from "react";
import type { TrackMetadata } from "../db/catalog";
import { memo, useEffect, useRef, useState } from "react";
import { bpmIsManual, effectiveBpm, effectiveKey } from "../db/library";
import { camelotLabel } from "../dsp/key";
import { displayName } from "../metadata/tags";

export const ROW_HEIGHT = 68;
interface Props {
  tracks: TrackMetadata[]; selectedId: string | null; onSelect: (id: string) => void;
  jobs: Record<string, { stage: string; progress: number }>;
  emptyMessage?: string;
  /** Rich empty-state content (preferred over emptyMessage when provided). */
  emptyState?: ReactNode;
  offset?: number; total?: number; resetKey?: string;
}
/** Render only the visible rows; playback ticks do not repaint the library. */
export const LibraryList = memo(function LibraryList({ tracks, selectedId, onSelect, jobs, emptyMessage = "Drop audio files here", emptyState, offset: pageOffset = 0, total = tracks.length, resetKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(640);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; setScrollTop(0); }, [resetKey]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const index = tracks.findIndex(track => track.id === selectedId);
    const element = scrollRef.current;
    if (index < 0 || !element) return;
    if (index * ROW_HEIGHT < element.scrollTop || (index + 1) * ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = index * ROW_HEIGHT;
      setScrollTop(element.scrollTop);
    }
  }, [selectedId, tracks]);
  if (tracks.length === 0) {
    return (
      <div className="library library-empty" ref={scrollRef} aria-label="Tracks">
        {emptyState ?? (
          <div className="empty-state">
            <p className="empty-state-title">No tracks yet</p>
            <p className="empty-state-sub">{emptyMessage}</p>
          </div>
        )}
      </div>
    );
  }
  const virtual = tracks.length > 100;
  const first = virtual ? Math.max(0, Math.min(tracks.length - 1, Math.floor(scrollTop / ROW_HEIGHT)) - 5) : 0;
  const last = virtual ? Math.min(tracks.length, first + Math.ceil(height / ROW_HEIGHT) + 11) : tracks.length;
  return <div className="library" ref={scrollRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <ul aria-label="Tracks" style={{ listStyle: "none", margin: 0, padding: 0, position: "relative", height: tracks.length * ROW_HEIGHT }}>
      {tracks.slice(first, last).map((track, offset) => {
        const running = jobs[track.id], bpm = effectiveBpm(track), key = effectiveKey(track);
        return <li key={track.id} className={track.id === selectedId ? "row selected" : "row"}
          style={{ height: ROW_HEIGHT, ...(virtual ? { position: "absolute", width: "100%", top: (first + offset) * ROW_HEIGHT } : {}) }}
          tabIndex={0} aria-current={track.id === selectedId ? "true" : undefined}
          aria-posinset={pageOffset + first + offset + 1} aria-setsize={total}
          onClick={() => onSelect(track.id)} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(track.id); }
          }}>
          <span className="name">{displayName(track.tags, track.name)}</span>
          <span className="meta">{track.analysisError ? <span className="conf red">failed</span> : running ?
            <span>{running.stage} {Math.round(running.progress * 100)}%</span> : <>
              <span>{bpm !== null ? `${bpm.toFixed(1)} BPM` : "—"}{bpmIsManual(track) && <em className="manual"> manual</em>}</span>
              <span>{key ? camelotLabel(key.tonic, key.mode) : "—"}</span>
              <span>{Math.floor(track.durationSec / 60)}:{Math.floor(track.durationSec % 60).toString().padStart(2, "0")}</span>
            </>}</span>
        </li>;
      })}
    </ul>
  </div>;
});
