/**
 * Music Editor.
 *
 * Every control on this screen is wired to real behaviour: audio really plays,
 * the beat click really comes from the detected grid, overrides really persist,
 * and the library really survives a reload. Nothing here is a placeholder.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { useCatalog, useTrackDetail } from "./ui/useCatalog";
import { LibraryList } from "./ui/LibraryList";
import { JobsPanel } from "./ui/JobsPanel";
import { AnalysisHistory } from "./ui/AnalysisHistory";
import { ANALYSIS_VERSION } from "./analysis/pipeline";
import { Player, type PlayerState } from "./audio/player";
import { AudioBufferCache } from "./audio/bufferCache";
import { shouldStream } from "./audio/decodePolicy";
import { attachAudioContextRecovery } from "./audio/devices";
import {
  addTrack,
  setAudioHash,
  trackByFilePath,
  addCue,
  removeCue,
  setGridLocked,
  setManualKey,
  bpmIsManual,
  effectiveBpm,
  effectiveGridOf,
  effectiveKey,
  markReviewed,
  removeTrack,
  db,
  setManualBpm,
  setManualGrid,
  type AnalysisJob,
} from "./db/library";
import { deriveBeatTimes, type BeatGrid } from "./dsp/beats";
import { camelotLabel, keyName, openKeyLabel } from "./dsp/key";
import { reviewReasons } from "./db/review";
import { useSetting } from "./ui/settings";
import { displayName, readTags } from "./metadata/tags";
import { isDesktop, pickFolder, readFile, scanFolder } from "./desktop/bridge";
import { computeAudioHash } from "./analysis/fingerprint";
import { DuplicatesPanel } from "./ui/DuplicatesPanel";
import { ExportPanel } from "./ui/ExportPanel";
import { MixMode } from "./ui/MixMode";
import { StemsPanel } from "./ui/StemsPanel";
import { checkService } from "./stems/service";
import { stemRunner, cancelRemoteStemJob } from "./stems/jobs";
import { TagWritePanel } from "./ui/TagWritePanel";
import { FileLocationPanel } from "./ui/FileLocationPanel";
import { MissingFilesPanel } from "./ui/MissingFilesPanel";
import { SettingsPanel } from "./ui/SettingsPanel";
import { MasteringPanel } from "./ui/MasteringPanel";
import { PlaylistsPanel } from "./ui/PlaylistsPanel";
import { ensurePeakPyramid } from "./db/peakPyramids";
import { getPlaylist } from "./db/playlists";
import { FEATURE_FLAG_KEYS, useFeatureFlag } from "./ui/features";
import { GridEditor } from "./ui/GridEditor";
import { WaveformView } from "./ui/WaveformView";
import { recommend } from "./analysis/recommendations";
import { buildAuditionPayload, type AuditionPayload } from "./analysis/audition";
import { estimatePhrases } from "./dsp/phrase";
import { barsFromGrid } from "./dsp/structure";
import { libraryEnergyDisplay } from "./dsp/energy";
import { logFeedback, recentlyPlayed } from "./db/feedback";
import { PianoVerifier } from "./ui/PianoVerifier";
import { AnalysisScheduler } from "./analysis/scheduler";
import { workerRunner } from "./analysis/workerRunner";

interface JobState {
  stage: string;
  progress: number;
}

function buildPeaks(channel: Float32Array, buckets = 2000): Float32Array {
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(channel.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * per;
    const end = Math.min(start + per, channel.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

function confidenceClass(value: number): string {
  if (value >= 0.7) return "conf good";
  if (value >= 0.5) return "conf amber";
  return "conf red";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function humanizeStorageError(error: unknown): string {
  const text = String(error ?? "");
  if (/DatabaseClosedError|UnknownError\s+Internal error/i.test(text)) {
    return "Library storage briefly unavailable. Dismiss and keep working — restart the app if this keeps appearing.";
  }
  return text.replace(/^Error:\s*/i, "") || "Something went wrong with library storage.";
}


export function App() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [storedJobs, setStoredJobs] = useState<AnalysisJob[]>([]);
  const [timeoutMinutes, _setTimeoutMinutes] = useSetting("analysisTimeoutMinutes", 5);
  const [playerState, setPlayerState] = useState<PlayerState>("stopped");
  const [position, setPosition] = useState(0);
  const [clickOn, setClickOn] = useState(false);
  const [volume, setVolume] = useSetting("volume", 0.8);
  // Studio (the original app) is the landing view, so the address you already
  // use opens on the app you already know; the new tools are one click away.
  const [view, setView] = useState<"studio" | "library" | "mix" | "duplicates">("studio");
  // Both Studio and the editor use the same splitter; show its state once, here.
  const [splitterUp, setSplitterUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => void checkService().then((s) => alive && setSplitterUp(s.reachable));
    poll();
    const timer = setInterval(poll, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const [featureMixMode] = useFeatureFlag(FEATURE_FLAG_KEYS.mixMode);
  const [featureStems] = useFeatureFlag(FEATURE_FLAG_KEYS.stems);
  const [featureDuplicates] = useFeatureFlag(FEATURE_FLAG_KEYS.duplicates);
  const [query, setQuery] = useState("");
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<import("./db/catalog").CatalogTrack[]>([]);
  const [pyramidLevels, setPyramidLevels] = useState<Float32Array[] | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useSetting("filter", "all");
  const [sort, setSort] = useSetting("sort", "added");
  const [cueName, setCueName] = useState("");
  const [bpmDraft, setBpmDraft] = useState("");

  const playerRef = useRef<Player | null>(null);
  const schedulerRef = useRef<AnalysisScheduler | null>(null);
  const [notice, setNotice] = useState("");
  const [streamingPlayback, setStreamingPlayback] = useState(false);
  const decodedRef = useRef(new AudioBufferCache());
  const { result: libraryPage, all: tracks, stats, loading: libraryLoading } = useCatalog(query, filter, sort, page, !!selectedId || view !== "library", setNotice);
  const catalogVisible = libraryPage.tracks;
  const visibleTracks = activePlaylistId ? playlistTracks : catalogVisible;

  const selected = useTrackDetail(selectedId, setNotice);

  if (playerRef.current === null) playerRef.current = new Player();
  const player = playerRef.current;

  const timeoutMsRef = useRef(Math.max(1, Math.min(60, timeoutMinutes)) * 60_000);
  timeoutMsRef.current = Math.max(1, Math.min(60, timeoutMinutes)) * 60_000;

  useEffect(() => {
    let alive = true;
    let jobSubscription: { unsubscribe: () => void } | null = null;
    const scheduler = new AnalysisScheduler(
      workerRunner(player.audioContext, decodedRef.current),
      () => {},
      (id, stage, progress) => {
        if (alive) setJobs(current => ({ ...current, [id]: { stage, progress } }));
      },
      db,
      timeoutMsRef.current,
      {
        stemRunner,
        cancelRemote: cancelRemoteStemJob,
        onError: message => {
          if (!alive) return;
          const soft = humanizeStorageError(message);
          setNotice(soft.startsWith("Library storage") ? soft : `Job storage: ${soft}`);
          if (/DatabaseClosedError|Internal error/i.test(String(message))) {
            void db.open().catch(() => {});
          }
        },
      },
    );
    schedulerRef.current = scheduler;
    void (async () => {
      try {
        await db.open();
        if (!alive) return;
        jobSubscription = liveQuery(() => db.jobs.toArray()).subscribe({
          next: rows => {
            if (!alive) return;
            setStoredJobs(rows);
            setJobs(Object.fromEntries(rows.filter(j => j.status === "running" || j.status === "queued")
              .map(j => [j.id, { stage: j.stage ?? j.status, progress: j.progress ?? 0 }])));
          },
          error: error => {
            if (!alive) return;
            setNotice(humanizeStorageError(error));
            void db.open().catch(() => {});
          },
        });
        await scheduler.start();
      } catch (error) {
        if (alive) setNotice(humanizeStorageError(error));
      }
    })();
    return () => {
      alive = false;
      jobSubscription?.unsubscribe();
      void scheduler.dispose().catch(error => console.error("Scheduler shutdown", error));
      schedulerRef.current = null;
    };
  }, [player]);

  // Playhead. Driven by rAF off the audio clock rather than a timer, so the
  // line matches what you hear instead of drifting away from it.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setPosition(player.position);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);

  useEffect(() => {
    player.setListener({ onStateChange: setPlayerState });
    return () => player.setListener({});
  }, [player]);

  // Sleep/wake / device-interrupt recovery for the inspector player (software hooks).
  useEffect(() => {
    return attachAudioContextRecovery(player.audioContext, {
      onSuspended: (message) => setNotice(message),
      shouldResume: () => player.playerState === "playing",
    });
  }, [player]);

  useEffect(() => {
    player.setVolume(volume);
  }, [player, volume]);

  const activeGrid = useMemo(
    () => (selected ? effectiveGridOf(selected) : { grid: null, manual: false }),
    [selected],
  );

  const beats = useMemo(() => {
    if (!activeGrid.grid || !selected || selected.durationSec <= 0) return null;
    return deriveBeatTimes(activeGrid.grid, selected.durationSec);
  }, [activeGrid, selected]);

  const peaks = useMemo(() => {
    if (!selected?.peaks) return null;
    return new Float32Array(selected.peaks);
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    setPyramidLevels(undefined);
    if (!selected?.peaks) return;
    const peaksView = new Float32Array(selected.peaks);
    void ensurePeakPyramid(selected.id, selected.contentHash, peaksView)
      .then((pyramid) => { if (!cancelled) setPyramidLevels(pyramid.levels); })
      .catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.contentHash, selected?.peaks]);

  useEffect(() => {
    let cancelled = false;
    if (!activePlaylistId) { setPlaylistTracks([]); return; }
    void getPlaylist(activePlaylistId).then(async (playlist) => {
      if (!playlist || cancelled) return;
      const rows = await db.trackCatalog.bulkGet(playlist.trackIds);
      if (cancelled) return;
      setPlaylistTracks(rows.filter((row): row is NonNullable<typeof row> => !!row));
    }).catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [activePlaylistId, libraryPage.total]);

  // Only a selection change loads audio. Refreshing analysis or edits must not seek.
  useEffect(() => {
    player.stop();
    setStreamingPlayback(false);
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      const track = await db.tracks.get(selectedId);
      if (!track || cancelled) return;
      if (shouldStream(track)) {
        // Long files stay on the browser media pipeline; do not fill decodedRef with PCM.
        await player.loadStream(track.audio, track.durationSec);
        if (!cancelled) setStreamingPlayback(true);
        return;
      }
      let buffer = decodedRef.current.get(selectedId);
      if (!buffer) {
        buffer = await player.audioContext.decodeAudioData(await track.audio.arrayBuffer());
        if (cancelled) return;
        decodedRef.current.set(selectedId, buffer);
      }
      if (!cancelled) player.load(buffer);
    })().catch(error => { if (!cancelled) setNotice(`Playback failed: ${String(error)}`); });
    return () => { cancelled = true; };
  }, [selectedId, player]);

  useEffect(() => {
    player.setGrid(beats, activeGrid.grid?.firstDownbeatSec ?? 0, activeGrid.grid?.beatsPerBar ?? 4);
  }, [beats, activeGrid, player]);

  useEffect(() => {
    setBpmDraft(selected ? (effectiveBpm(selected)?.toFixed(2) ?? "") : "");
  }, [selected]);

  /**
   * Import one file. `origin` is supplied only by the desktop folder import,
   * where the real path on disk is known; drag-and-drop cannot provide it.
   */
  const importOne = useCallback(
    async (file: File, origin?: { filePath: string; relativePath: string }) => {
      try {
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
        if (await db.tracks.where("contentHash").equals(hash).first()) {
          setNotice(`Skipped exact duplicate: ${file.name}`);
          return;
        }
        const buffer = await player.audioContext.decodeAudioData(bytes.slice(0));
        const trackPeaks = buildPeaks(buffer.getChannelData(0));
        // Tag reading never throws; a file with broken tags still imports.
        const tags = await readTags(file);
        const stored = await addTrack(file, buffer.duration, trackPeaks, tags, hash, origin);
        // Catches the same master in another container; the file hash cannot.
        void computeAudioHash(buffer.getChannelData(0)).then((audioHash) =>
          setAudioHash(stored.id, audioHash),
        ).catch(error => setNotice(`Audio fingerprint failed: ${String(error)}`));
        decodedRef.current.set(stored.id, buffer);
        
        setSelectedId((existing) => existing ?? stored.id);
        await schedulerRef.current?.enqueue(stored.id);
      } catch (error) {
        setNotice(`Import failed for ${file.name}: ${String(error)}`);
      }
    },
    [player],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) await importOne(file);
    },
    [importOne],
  );

  /**
   * Desktop folder import.
   *
   * Reads through the bridge rather than a file input, so each track keeps its
   * absolute path - which is what makes tag writing and relocation possible.
   */
  const importFolder = useCallback(async () => {
    const folder = await pickFolder();
    if (!folder) return;
    const scan = await scanFolder(folder);
    if (!scan.ok) {
      setNotice(scan.error);
      return;
    }
    setNotice(`Scanning ${scan.files.length} file(s) from ${folder}Ã¢â‚¬Â¦`);
    let imported = 0;
    for (const entry of scan.files) {
      if (await trackByFilePath(entry.path)) continue;
      const read = await readFile(entry.path);
      if (!read.ok) {
        setNotice(`Could not read ${entry.name}: ${read.error}`);
        continue;
      }
      const file = new File([read.data], entry.name);
      await importOne(file, { filePath: entry.path, relativePath: entry.relativePath });
      imported++;
    }
    setNotice(`Imported ${imported} of ${scan.files.length} file(s) from ${folder}`);
  }, [importOne]);

  const togglePlay = useCallback(() => {
    if (player.playerState === "playing") player.pause();
    else void player.play().catch(error => setNotice(`Playback failed: ${String(error)}`));
  }, [player]);

  // Space toggles transport, as it does in every DJ tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
      if (!event.defaultPrevented && event.code === "Space") {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  const applyManualBpm = useCallback(async () => {
    if (!selected) return;
    const parsed = Number.parseFloat(bpmDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    try { await setManualBpm(selected.id, parsed); }
    catch (error) { setNotice(String(error)); return; }
    
  }, [selected, bpmDraft]);

  const applyGrid = useCallback(
    async (grid: BeatGrid) => {
      if (!selected) return;
      try { await setManualGrid(selected.id, grid); }
      catch (error) { setNotice(String(error)); return; }
      
    },
    [selected],
  );

  const revertGrid = useCallback(async () => {
    if (!selected) return;
    await setManualGrid(selected.id, null);
    
  }, [selected]);

  const revertBpm = useCallback(async () => {
    if (!selected) return;
    await setManualBpm(selected.id, null);
    
  }, [selected]);

  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    void recentlyPlayed().then(setRecentIds);
  }, [tracks]);

  const recommendations = useMemo(
    () => (selected ? recommend(selected, tracks, { recentIds }) : []),
    [selected, tracks, recentIds],
  );

  const [audition, setAudition] = useState<AuditionPayload | null>(null);

  const livePhrases = useMemo(() => {
    if (!selected || !activeGrid.grid) return selected?.analysis?.phrases ?? null;
    return estimatePhrases(activeGrid.grid, selected.durationSec, selected.analysis?.energy?.curve);
  }, [selected, activeGrid]);

  const liveBars = useMemo(() => {
    if (!selected || !activeGrid.grid || !selected.analysis?.energy?.curve) {
      return selected?.analysis?.structure?.bars ?? [];
    }
    return barsFromGrid(selected.analysis.energy.curve, activeGrid.grid, selected.durationSec);
  }, [selected, activeGrid]);

  const libraryEnergy = useMemo(() => {
    const raw = selected?.analysis?.energy?.rawScore;
    if (raw === undefined) return null;
    const scores = tracks
      .map((track) => track.analysis?.energy?.rawScore)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return libraryEnergyDisplay(raw, scores);
  }, [selected, tracks]);

  const key = selected ? effectiveKey(selected) : null;
  const job = selectedId ? jobs[selectedId] : undefined;
  const staleCount = stats.stale;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand-mark" aria-hidden="true" />
          <h1>Music Editor</h1>
        </div>
        <div className="head-right">
          <span
            className={`svc-pill ${splitterUp ? "up" : splitterUp === false ? "down" : ""}`}
            title="Stem splitter on :8787, shared by Studio and the editor"
          >
            <span className="svc-dot" />
            Splitter {splitterUp ? "online" : splitterUp === false ? "offline" : "…"}
          </span>
          {view === "library" && staleCount > 0 && <span className="conf amber">{staleCount} stale</span>}
          <div className="views">
            {(["studio", "library", "mix", "duplicates"] as const)
            .filter((v) => v === "studio" || v === "library" || (v === "mix" && featureMixMode) || (v === "duplicates" && featureDuplicates))
            .map((v) => (
              <button
                key={v}
                className={view === v ? "ghost active" : "ghost"}
                onClick={() => setView(v)}
              >
                {v === "studio" ? "Studio" : v === "library" ? "Library" : v === "mix" ? "Mix" : "Duplicates"}
              </button>
            ))}
          </div>
          {/* Desktop only: a browser cannot read a folder by path. */}
          {view === "library" && isDesktop() && (
            <button className="import" onClick={() => void importFolder()}>
              Import folder
            </button>
          )}
          <label className="import" style={view === "library" ? undefined : { display: "none" }}>
            Add audio
            <input
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </header>

      {view === "studio" && (
        // Same origin as this page, so the original app keeps its saved data
        // and talks to the same stem splitter on :8787.
        <iframe className="studio-frame" src="./studio/index.html" title="Studio" />
      )}

      <div className="transport toolbar" style={view === "library" ? undefined : { display: "none" }}>
        <div className="toolbar-row">
          <div className="search-field">
          <span className="search-field-icon" aria-hidden="true" />
          <input aria-label="Search library" placeholder="Search title, artist, album or filename" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />
        </div>
          <select aria-label="Filter library" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}>
          <option value="all">All tracks</option><option value="review">Needs verification</option>
          <option value="failed">Failed analysis</option><option value="reviewed">Reviewed</option>
        </select>
          <select aria-label="Sort library" value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}>
          <option value="added">Newest first</option><option value="name">Name</option><option value="bpm">BPM</option>
        </select>
        </div>
        <div className="toolbar-row toolbar-row-secondary">
          <span className="toolbar-meta">{libraryPage.total ? libraryPage.offset + 1 : 0}-{libraryPage.offset + visibleTracks.length} of {libraryPage.total} matches</span>
          <button disabled={libraryPage.offset === 0} onClick={() => setPage(Math.max(0, libraryPage.offset / 100 - 1))}>Previous page</button>
          <button disabled={libraryPage.offset + 100 >= libraryPage.total} onClick={() => setPage(libraryPage.offset / 100 + 1)}>Next page</button>
          <label className="import">Add folder<input type="file" multiple
          ref={input => { input?.setAttribute("webkitdirectory", ""); }}
          onChange={e => { if (e.target.files) void addFiles(Array.from(e.target.files).filter(f => /\.(mp3|wav|flac|aiff?|m4a|aac|ogg|opus)$/i.test(f.name))); e.target.value = ""; }} /></label>
          {staleCount > 0 && <button onClick={async () => {
          try { for (const id of await db.catalogKeys.where("stale").equals(1).primaryKeys()) await schedulerRef.current?.enqueue(id, -1); }
          catch (error) { setNotice(String(error)); }
        }}>Queue stale analyses ({staleCount})</button>}
        </div>
      </div>
      <div className="notice-stack" aria-live="polite">
        {notice && (
          <p role="alert" className="notice alert">
            {notice}
            <button type="button" onClick={() => setNotice("")}>Dismiss</button>
          </p>
        )}
        {!stats.complete && stats.total > 0 && (
          <p role="status" className="notice info">
            Preparing library index: {stats.indexed} of {stats.total} tracks. Search results will expand as indexing completes.
          </p>
        )}
        {libraryLoading && (
          <p role="status" className="notice info">Searching the library…</p>
        )}
      </div>
      {view !== "studio" && <JobsPanel jobs={storedJobs}
        onCancel={id => { void schedulerRef.current?.cancel(id).catch(error => setNotice(String(error))); }}
        onRetry={id => { void schedulerRef.current?.enqueue(id, 1).catch(error => setNotice(String(error))); }} />}
      {view === "mix" && featureMixMode && (
        <MixMode
          tracks={tracks}
          decoded={decodedRef.current}
          audition={audition}
          onNeedDecode={async (track) => {
            // Short-track PCM path only. Oversized tracks load via MixMode
            // deck.loadStream (MediaElement) Ã¢â‚¬â€ never decode them here.
            if (shouldStream(track)) {
              throw new Error("Mix Mode streaming path should load this track without full PCM decode");
            }
            // Mix Mode shares the editor's decode cache so a track loaded on a
            // deck is not decoded a second time.
            const cached = decodedRef.current.get(track.id);
            if (cached) return cached;
            try {
              const buffer = await player.audioContext.decodeAudioData(
                await track.audio.arrayBuffer(),
              );
              decodedRef.current.set(track.id, buffer);
              return buffer;
            } catch {
              return null;
            }
          }}
        />
      )}

      {view === "duplicates" && featureDuplicates && (
        <div className="inspector">
          <DuplicatesPanel
            tracks={tracks}
            onChanged={() => {}}
          />
        </div>
      )}

      <div className={`body${!selected && !stats.total ? " body-empty" : ""}`} style={view === "library" ? undefined : { display: "none" }}>
        <div className="library-pane">
          <div className="library-pane-head"><h2>Library</h2><span className="muted library-count">{stats.total} tracks</span></div>
        <LibraryList tracks={visibleTracks} selectedId={selectedId} onSelect={setSelectedId} jobs={jobs}
          offset={libraryPage.offset} total={libraryPage.total} resetKey={JSON.stringify([query, filter, sort, libraryPage.offset])}
          emptyMessage={activePlaylistId ? "Playlist is empty or tracks are missing" : stats.total ? "No matching tracks" : "Drop audio files here"}

          emptyState={
            <div className="empty-state">
              <p className="empty-state-title">{activePlaylistId ? "Playlist is empty" : stats.total ? "No matching tracks" : "No tracks yet"}</p>
              <p className="empty-state-sub">
                {activePlaylistId
                  ? "This playlist has no tracks, or its files are missing."
                  : stats.total
                    ? "Try a different search or clear filters."
                    : "Import a folder or add audio files to build your library."}
              </p>
              {!activePlaylistId && !stats.total && (
                <div className="empty-state-actions">
                  {isDesktop() && (
                    <button type="button" className="primary" onClick={() => void importFolder()}>Import folder</button>
                  )}
                  <label className="import primary-like">
                    Add audio
                    <input type="file" accept="audio/*" multiple onChange={e => {
                      if (e.target.files?.length) void addFiles(e.target.files);
                      e.target.value = "";
                    }} />
                  </label>
                </div>
              )}
            </div>
          }
        />
        </div>

        <section className="inspector">
          {!selected && (
            <>
              <div className="empty-state inspector-empty">
                <p className="empty-state-title">No track selected</p>
                <p className="empty-state-sub">
                  Choose a track in the library to inspect, play, and monitor mastering.
                </p>
                <p className="muted mastering-collapsed-hint">Select a track to monitor mastering</p>
                {!stats.total && (
                  <div className="empty-state-actions">
                    {isDesktop() && (
                      <button type="button" className="primary" onClick={() => void importFolder()}>Import folder</button>
                    )}
                    <label className="import primary-like">
                      Add audio
                      <input type="file" accept="audio/*" multiple onChange={e => {
                        if (e.target.files?.length) void addFiles(e.target.files);
                        e.target.value = "";
                      }} />
                    </label>
                  </div>
                )}
              </div>
<MissingFilesPanel />
              <PlaylistsPanel
                selectedTrackId={selectedId}
                activePlaylistId={activePlaylistId}
                onOpenPlaylist={setActivePlaylistId}
                onNotice={setNotice}
              />
              <SettingsPanel />
            </>
          )}
          {selected && (
            <>
              <div className="title-row">
                <h2>{displayName(selected.tags, selected.name)}</h2>
                <button
                  className="ghost"
                  onClick={async () => {
                    try {
                      await schedulerRef.current?.cancel(selected.id);
                      await removeTrack(selected.id);
                      decodedRef.current.delete(selected.id);
                      setSelectedId(null);
                    } catch (error) { setNotice(String(error)); }
                    
                  }}
                >
                  Remove
                </button>
              </div>

              {selected.analysisError && <p className="error">{selected.analysisError}</p>}

              {peaks && (
                <WaveformView
                  peaks={peaks}
                  pyramidLevels={pyramidLevels}
                  durationSec={selected.durationSec}
                  beats={beats}
                  firstDownbeatSec={activeGrid.grid?.firstDownbeatSec ?? null}
                  beatsPerBar={activeGrid.grid?.beatsPerBar ?? 4}
                  positionSec={position}
                  phraseStarts={livePhrases?.phrases.map((phrase) => phrase.startSec)}
                  onSeek={(s) => player.seek(s)}
                />
              )}

              <div className="transport">
                <button className="primary" onClick={togglePlay}>
                  {playerState === "playing" ? "Pause" : "Play"}
                </button>
                <button className="ghost" onClick={() => player.seek(0)}>
                  Start
                </button>
                <span className="clock">
                  {formatTime(position)} / {formatTime(selected.durationSec)}
                </span>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={clickOn}
                    disabled={!beats}
                    onChange={(e) => {
                      setClickOn(e.target.checked);
                      player.setClickEnabled(e.target.checked);
                    }}
                  />
                  Beat click
                </label>
                <label className="slider">
                  Vol
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                  />
                </label>
              </div>
              {streamingPlayback && (
                <p className="notice warn" role="status">
                  Long file: streaming playback (bounded memory). Beat click is audition-only, not sample-accurate.
                </p>
              )}

              <MasteringPanel bus={player.mastering} compact />

              <div className="transport">
                <button disabled={!!job} onClick={() => {
                  void schedulerRef.current?.enqueue(selected.id, 1).catch(error => setNotice(String(error)));
                }}>{selected.analysisError ? "Retry analysis" : "Reanalyse"}</button>
                {job && <button onClick={() => { void schedulerRef.current?.cancel(selected.id).catch(error => setNotice(String(error))); }}>Cancel analysis</button>}
              </div>
              {job && (
                <p className="muted">
                  Analysing Ã¢â‚¬â€ {job.stage} {Math.round(job.progress * 100)}%
                </p>
              )}

              {selected.analysis && (
                <dl className="facts">
                  <dt>Tempo</dt>
                  <dd>
                    <input
                      className="bpm"
                      value={bpmDraft}
                      onChange={(e) => setBpmDraft(e.target.value)}
                      onBlur={applyManualBpm}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void applyManualBpm();
                      }}
                    />
                    <span className={confidenceClass(selected.analysis.tempo.confidence)}>
                      {(selected.analysis.tempo.confidence * 100).toFixed(0)}%
                    </span>
                    {bpmIsManual(selected) ? (
                      <button className="ghost small" onClick={revertBpm}>
                        Revert to {selected.analysis.tempo.bpm.toFixed(2)}
                      </button>
                    ) : (
                      <span className="muted">automatic</span>
                    )}
                  </dd>

                  <dt>Octave</dt>
                  <dd>
                    <span className="value">{selected.analysis.tempo.rawBpm.toFixed(2)} raw</span>
                    <span className={confidenceClass(selected.analysis.tempo.octaveConfidence)}>
                      {(selected.analysis.tempo.octaveConfidence * 100).toFixed(0)}%
                    </span>
                  </dd>

                  <dt>Key</dt>
                  <dd>
                    <span className="value">
                      {key && `${keyName(key.tonic, key.mode)} Ã‚Â· ${camelotLabel(key.tonic, key.mode)} Ã‚Â· ${openKeyLabel(key.tonic, key.mode)}`}
                    </span>
                    <span className={confidenceClass(selected.analysis.key.confidence)}>
                      {(selected.analysis.key.confidence * 100).toFixed(0)}%
                    </span>
                    {selected.analysis.key.relativeAmbiguous && (
                      <span className="conf amber">relative ambiguous</span>
                    )}
                  </dd>

                  <dt>Tuning</dt>
                  <dd>
                    <span className="value">
                      {selected.analysis.key.tuningCents.toFixed(1)} cents
                    </span>
                  </dd>

                  <dt>Grid</dt>
                  <dd>
                    <span className="value">
                      {selected.analysis.grid.isFixed ? "fixed" : "dynamic"} Ã‚Â·{" "}
                      {selected.analysis.grid.anchors.length} anchor(s) Ã‚Â· offset{" "}
                      {(selected.analysis.gridOffsetSec * 1000).toFixed(0)} ms
                    </span>
                    <span className={confidenceClass(selected.analysis.grid.gridConfidence)}>
                      {(selected.analysis.grid.gridConfidence * 100).toFixed(0)}%
                    </span>
                  </dd>

                  <dt>Loudness</dt>
                  <dd>
                    <span className="value">
                      {!selected.analysis.loudness ? "Reanalyse to measure loudness" : Number.isFinite(selected.analysis.loudness.integratedLufs)
                        ? `${selected.analysis.loudness.integratedLufs.toFixed(1)} LUFS Ã‚Â· range ${selected.analysis.loudness.rangeLu.toFixed(1)} LU Ã‚Â· peak ${selected.analysis.loudness.samplePeakDbfs.toFixed(1)} dBFS ? true peak ${selected.analysis.loudness.truePeakDbtp.toFixed(1)} dBTP`
                        : "silent"}
                    </span>
                  </dd>

                  <dt>Energy</dt>
                  <dd>
                    <span className="value">{selected.analysis.energy ? `${selected.analysis.energy.level} / 10` : "Reanalyse to measure energy"}</span>
                    {libraryEnergy?.displayLevel !== null && libraryEnergy?.displayLevel !== undefined && (
                      <span className="muted">
                        library {libraryEnergy.displayLevel} / 10
                        {libraryEnergy.percentile !== null ? ` (${Math.round(libraryEnergy.percentile * 100)}th of ${libraryEnergy.sampleSize})` : ""}
                      </span>
                    )}
                    {selected.analysis.keySupport && (
                      <span className="muted">
                        bass chroma {selected.analysis.keySupport.bassName}
                        {selected.analysis.keySupport.agreed ? " agrees" : " differs"} (heuristic)
                      </span>
                    )}
                    <span className={confidenceClass(selected.analysis.energy?.confidence ?? 0)}>
                      {((selected.analysis.energy?.confidence ?? 0) * 100).toFixed(0)}%
                    </span>
                    <span className="muted">
                      {selected.analysis.energy?.contributions
                        .slice(0, 3)
                        .map((c) => `${c.name} ${(c.normalised * 100).toFixed(0)}%`)
                        .join(" Ã‚Â· ")}
                    </span>
                  </dd>

                  <dt>File</dt>
                  <dd>
                    <span className="value">
                      {[
                        selected.tags.codec,
                        selected.tags.bitrateKbps ? `${selected.tags.bitrateKbps} kbps` : null,
                        selected.tags.sampleRate ? `${selected.tags.sampleRate} Hz` : null,
                        selected.tags.album,
                        selected.tags.year?.toString(),
                      ]
                        .filter(Boolean)
                        .join(" Ã‚Â· ") || selected.name}
                    </span>
                  </dd>

                  <dt>Review</dt>
                  <dd>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await markReviewed(selected.id, selected.reviewedAt === null);
                        
                      }}
                    >
                      {selected.reviewedAt === null ? "Mark reviewed" : "Reviewed Ã¢Å“â€œ"}
                    </button>
                    <span className="muted">
                      analysis v{selected.analysis.analysisVersion}
                      {(selected.analysisVersion ?? 0) < ANALYSIS_VERSION && " Ã‚Â· stale"}
                    </span>
                  </dd>
                </dl>
              )}

              {activeGrid.grid && <label className="toggle"><input type="checkbox" checked={!!selected.gridLocked}
                onChange={async e => { await setGridLocked(selected.id, e.target.checked);  }} />Lock grid</label>}
              {activeGrid.grid && (
                <fieldset disabled={!!selected.gridLocked}><GridEditor
                  key={selected.id}
                  grid={activeGrid.grid}
                  durationSec={selected.durationSec}
                  positionSec={position}
                  isManual={activeGrid.manual}
                  onChange={(g) => void applyGrid(g)}
                  onRevert={() => void revertGrid()}
                /></fieldset>
              )}

              <div className="grid-editor">
                <h3>Verification</h3>
                {reviewReasons(selected).map(reason => <p key={reason}>{reason}</p>)}
                <label>Correct key <select aria-label="Correct key" value={key ? `${key.tonic}:${key.mode}` : ""}
                  onChange={async e => {
                    const [tonic, mode] = e.target.value.split(":");
                    await setManualKey(selected.id, Number(tonic), mode as "major" | "minor");
                    
                  }}>
                  <option value="" disabled>Choose key</option>
                  {Array.from({ length: 12 }, (_, tonic) => ["major", "minor"].map(mode =>
                    <option key={`${tonic}:${mode}`} value={`${tonic}:${mode}`}>{keyName(tonic, mode as "major" | "minor")}</option>))}
                </select></label>
                <button onClick={async () => { await setManualKey(selected.id, null, null);  }}>Revert key</button>
              </div>
              <div className="grid-editor">
                <h3>Cues</h3>
                <input aria-label="Cue name" placeholder="Cue name" value={cueName} onChange={e => setCueName(e.target.value)} />
                <button onClick={async () => {
                  try { await addCue(selected.id, position, cueName); setCueName("");  }
                  catch (error) { setNotice(String(error)); }
                }}>Add cue at playhead</button>
                {(selected.cues ?? []).map(cue => <div key={cue.id} className="transport">
                  <button onClick={() => player.seek(cue.timeSec)}>{cue.name} - {formatTime(cue.timeSec)}</button>
                  <button aria-label={`Remove cue ${cue.name}`} onClick={async () => { await removeCue(selected.id, cue.id);  }}>Remove cue</button>
                </div>)}
              </div>
              {(selected.analysis?.structure || liveBars.length > 0) && <div className="grid-editor"><h3>Energy, phrases and section suggestions</h3>
                <p className="muted">
                  Bar energy follows the effective (locked/manual) grid. Phrase
                  labels are 8/16/32-bar estimates on that grid, not a labelled
                  corpus. Section names stay rule-based energy/vocal heuristics.
                </p>
                <svg viewBox="0 0 600 80" width="100%" height="80" role="img" aria-label="Energy per bar">
                  {liveBars.map((bar, i, bars) => <rect key={i} x={i / bars.length * 600} y={80 * (1 - bar.energy)} width={600 / bars.length} height={80 * bar.energy} fill="#3f7d8c" />)}
                </svg>
                {livePhrases && livePhrases.phrases.length > 0 && (
                  <div className="transport">
                    {livePhrases.phrases.map((phrase, i) => (
                      <button key={`${phrase.startSec}-${i}`} onClick={() => player.seek(phrase.startSec)}>
                        P{i + 1} {livePhrases.lengthBars} bars: {formatTime(phrase.startSec)}
                      </button>
                    ))}
                    <span className="muted">{Math.round(livePhrases.confidence * 100)}% phrase fit (heuristic)</span>
                  </div>
                )}
                {selected.analysis?.structure?.sections.map(section => <div key={section.startSec} className="transport">
                  <button onClick={() => player.seek(section.startSec)}>{section.label}: {formatTime(section.startSec)}</button>
                  <button onClick={async () => { await addCue(selected.id, section.startSec, section.label);  }}>Save as cue</button>
                </div>)}
              </div>}
              {key && <PianoVerifier context={player.audioContext} tonic={key.tonic} mode={key.mode} />}
              <div className="grid-editor"><h3>Suggested next tracks</h3>
                <p className="muted">
                  Ranked by tempo, key, energy, opening section and vocal overlap.
                  Every reason is shown; audition before mixing.
                </p>
                {recommendations.map((item, rank) => (
                  <div className="rec" key={item.track.id}>
                    <div className="ge-row">
                      <button
                        className="ghost small"
                        onClick={async () => {
                          await logFeedback({
                            fromTrackId: selected.id,
                            toTrackId: item.track.id,
                            action: "accepted",
                            predictedScore: item.score,
                            rank,
                          });
                          setRecentIds(await recentlyPlayed());
                          setSelectedId(item.track.id);
                        }}
                      >
                        {displayName(item.track.tags, item.track.name)}
                      </button>
                      <span className={item.score >= 70 ? "conf good" : item.score >= 45 ? "conf amber" : "conf red"}>
                        {item.score}/100
                      </span>
                      <button
                        className="ghost small"
                        title="Not this one - recorded so the ranking can be judged later"
                        onClick={async () => {
                          await logFeedback({
                            fromTrackId: selected.id,
                            toTrackId: item.track.id,
                            action: "skipped",
                            predictedScore: item.score,
                            rank,
                          });
                          setRecentIds(await recentlyPlayed());
                        }}
                      >
                        Skip
                      </button>
                      {featureMixMode && <button
                        className="ghost small"
                        title="Preview a short synced crossfade in Mix Mode"
                        onClick={async () => {
                          const payload = buildAuditionPayload(selected, item, rank);
                          if (!payload) {
                            setNotice("Cannot audition: both tracks need an effective tempo and duration");
                            return;
                          }
                          await logFeedback({
                            fromTrackId: payload.fromTrackId,
                            toTrackId: payload.toTrackId,
                            action: "played",
                            predictedScore: payload.predictedScore,
                            rank: payload.rank,
                          });
                          setRecentIds(await recentlyPlayed());
                          setAudition(payload);
                          setView("mix");
                        }}
                      >
                        Audition
                      </button>}
                    </div>
                    <div className="rec-reasons">
                      {item.reasons.map(reason => (
                        <span key={reason.factor} className="muted">{reason.text}</span>
                      ))}
                    </div>
                    {item.warnings.length > 0 && (
                      <div className="rec-reasons">
                        {item.warnings.map(w => <span key={w} className="conf amber">{w}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {featureStems && <StemsPanel track={selected}
                onQueue={async options => { await schedulerRef.current?.enqueueStems(selected.id, options); }}
                onCancel={async () => { await schedulerRef.current?.cancel(`stems:${selected.id}`); }} />}

              <FileLocationPanel track={selected} />
              <MissingFilesPanel />
              <TagWritePanel track={selected} filePath={selected.filePath ?? null} />
              <SettingsPanel />

              <AnalysisHistory trackId={selected.id} />
              <ExportPanel query={query} filter={filter} sort={sort} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
