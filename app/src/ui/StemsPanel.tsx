/**
 * Stem separation panel (research Phase M).
 *
 * The separation engine lives in a separate process, so the first thing this
 * panel does is ask whether it is running. Not running is an ordinary state,
 * not an error, and it is reported with the command to start it rather than a
 * failure message.
 *
 * Results are cached by the recording's audio hash, so re-opening a track shows
 * its stems immediately and the expensive work happens once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoredTrack } from "../db/library";
import {
  allCached,
  cacheSize,
  checkStemsPlausible,
  DEFAULT_CACHE_LIMIT_BYTES,
  enforceCacheLimit,
  getCachedStems,
  putCachedStems,
  removeCached,
  setPinned,
  type StemCacheEntry,
} from "../db/stems";
import {
  checkService,
  downloadStems,
  separate,
  stemColour,
  type ServiceStatus,
} from "../stems/service";

interface Props {
  track: StoredTrack;
}

function formatBytes(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function StemsPanel({ track }: Props) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [entry, setEntry] = useState<StemCacheEntry | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState({ bytes: 0, entries: 0, pinned: 0 });
  const [quality, setQuality] = useState<"balanced" | "high">("balanced");
  const abortRef = useRef<AbortController | null>(null);

  const model = useMemo(
    () => (status?.backend === "demucs" ? `demucs/${status.model ?? "htdemucs"}` : "dsp"),
    [status],
  );

  useEffect(() => {
    void checkService().then(setStatus);
  }, []);

  const refreshUsage = useCallback(async () => setUsage(await cacheSize()), []);
  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  // Look for an existing result whenever the track or engine changes.
  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    if (!track.audioHash || !status?.reachable) return;
    void getCachedStems(track.audioHash, model).then((found) => {
      if (!cancelled) setEntry(found ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [track.audioHash, model, status?.reachable]);

  // Elapsed time instead of a progress bar: the service answers only when the
  // whole job is done, so any percentage would be invented.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [running]);

  const run = useCallback(async () => {
    if (!track.audioHash) {
      setError("This track has no audio hash yet; wait for analysis to finish.");
      return;
    }
    setRunning(true);
    setError(null);
    setElapsed(0);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await separate(track.audio, track.name, {
        stems: "basic",
        quality,
        signal: controller.signal,
      });
      const stems = await downloadStems(result, controller.signal);

      const plausible = checkStemsPlausible(stems, track.sizeBytes);
      if (!plausible.ok) {
        setError(plausible.reason);
        return;
      }

      const saved = await putCachedStems({
        audioHash: track.audioHash,
        model: result.backend === "demucs" ? `demucs/${status?.model ?? "htdemucs"}` : "dsp",
        trackId: track.id,
        trackName: track.name,
        stems,
      });
      setEntry(saved);

      const evicted = await enforceCacheLimit();
      if (evicted.blockedByPins) {
        setError("Stem cache is over its limit and every entry is pinned.");
      }
      await refreshUsage();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setError("Cancelled.");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [track, quality, status, refreshUsage]);

  const download = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="export-panel">
      <h3>Stems</h3>

      {status === null && <p className="muted">Checking for the separation service…</p>}

      {status && !status.reachable && (
        <>
          <p className="conf amber">{status.error}</p>
          <p className="muted">
            Separation runs in a separate process because it needs PyTorch, which
            is far too large to ship inside this app. Start it with:
          </p>
          <pre className="cmd">cd server{"\n"}.\run.ps1</pre>
          <button className="ghost small" onClick={() => void checkService().then(setStatus)}>
            Check again
          </button>
        </>
      )}

      {status?.reachable && (
        <>
          <div className="ge-row">
            <span className="ge-label">Engine</span>
            <span className="value">
              {status.backend === "demucs" ? `Demucs (${status.model})` : "DSP fallback"}
            </span>
            {status.backend === "demucs" && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={quality === "high"}
                  disabled={running}
                  onChange={(e) => setQuality(e.target.checked ? "high" : "balanced")}
                />
                Higher quality (slower)
              </label>
            )}
          </div>

          <div className="ge-row">
            <button className="ghost small" disabled={running} onClick={() => void run()}>
              {entry ? "Separate again" : "Separate"}
            </button>
            {running && (
              <>
                <span className="muted">Separating… {elapsed.toFixed(0)}s</span>
                <button className="ghost small" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              </>
            )}
            {!running && entry && (
              <span className="muted">
                Cached {formatBytes(entry.sizeBytes)} · {entry.model}
              </span>
            )}
          </div>

          {error && <p className="conf red">{error}</p>}

          {entry && (
            <table className="changes">
              <tbody>
                {entry.stems.map((stem) => (
                  <tr key={stem.name}>
                    <td>
                      <span
                        className="stem-dot"
                        style={{ background: stemColour(stem.type) }}
                      />
                      {stem.type}
                    </td>
                    <td className="muted">{formatBytes(stem.blob.size)}</td>
                    <td>
                      <audio controls preload="none" src={URL.createObjectURL(stem.blob)} />
                    </td>
                    <td>
                      <button
                        className="ghost small"
                        onClick={() => download(stem.name, stem.blob)}
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {entry && (
            <div className="ge-row">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={entry.pinned}
                  onChange={async (e) => {
                    await setPinned(entry.id, e.target.checked);
                    setEntry({ ...entry, pinned: e.target.checked });
                    await refreshUsage();
                  }}
                />
                Keep (never evict)
              </label>
              <button
                className="ghost small"
                onClick={async () => {
                  await removeCached(entry.id);
                  setEntry(null);
                  await refreshUsage();
                }}
              >
                Delete stems
              </button>
            </div>
          )}

          <p className="muted">
            Cache: {formatBytes(usage.bytes)} of {formatBytes(DEFAULT_CACHE_LIMIT_BYTES)} ·{" "}
            {usage.entries} track(s), {usage.pinned} kept.{" "}
            <button
              className="linkish"
              onClick={async () => {
                const all = await allCached();
                for (const row of all) if (!row.pinned) await removeCached(row.id);
                setEntry(null);
                await refreshUsage();
              }}
            >
              Clear unkept
            </button>
          </p>
        </>
      )}
    </div>
  );
}
