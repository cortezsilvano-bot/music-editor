import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { LibraryList } from "../src/ui/LibraryList";
import type { StoredTrack } from "../src/db/library";
import { EMPTY_TAGS } from "../src/metadata/tags";

async function runLibraryUiBenchmark() {
  const reports = [];
  for (const size of [10_000, 50_000, 100_000]) {
    const tracks = Array.from({ length: size }, (_, index) => ({ id: String(index), name: `Track ${index}`,
      tags: EMPTY_TAGS, manualBpm: null, manualKeyTonic: null, manualKeyMode: null, analysis: null, durationSec: 120 }) as StoredTrack);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:320px;height:500px;display:grid;grid-template-rows:minmax(0,1fr);z-index:10000;background:#121218";
    document.body.append(host);
    const root = createRoot(host);
    try {
      const renderAt = performance.now();
      flushSync(() => root.render(<LibraryList tracks={tracks} selectedId={null} jobs={{}} onSelect={() => {}} />));
      const scroller = host.querySelector<HTMLElement>(".library")!;
      scroller.getBoundingClientRect();
      const renderMs = performance.now() - renderAt;
      const times = [];
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const at = performance.now();
        scroller.scrollTop = fraction * scroller.scrollHeight;
        flushSync(() => scroller.dispatchEvent(new Event("scroll", { bubbles: true })));
        // Allow Chromium's queued scroll event and React's continuous-event
        // update to commit; requestAnimationFrame is throttled in hidden windows.
        await new Promise(resolve => setTimeout(resolve, 20));
        scroller.getBoundingClientRect(); times.push(performance.now() - at);
      }
      const renderedRows = host.querySelectorAll(".row").length;
      const lastTrackVisible = host.textContent?.includes(`Track ${size - 1}`) ?? false;
      if (renderedRows > 30 || !lastTrackVisible) throw new Error(`Virtual library bounds/navigation: ${JSON.stringify({ renderedRows, lastTrackVisible, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, height: scroller.clientHeight, last: host.querySelector(".row:last-child")?.textContent })}`);
      reports.push({ count: size, initialCommitAndLayoutMs: Math.round(renderMs * 10) / 10,
        scrollCommitAndLayoutMs: times.map(value => Math.round(value * 10) / 10), renderedRows, lastTrackVisible,
        visibility: document.visibilityState,
        limits: "Synthetic metadata, actual LibraryList in Chromium at 320x500. DOM commit/layout with a 20ms event-settling wait per scroll, not perceived latency or paint. Hidden Electron windows throttle animation frames. Excludes database loading, analysis and audio." });
    } finally { root.unmount(); host.remove(); }
  }
  return reports;
}
Object.assign(globalThis, { runLibraryUiBenchmark });
