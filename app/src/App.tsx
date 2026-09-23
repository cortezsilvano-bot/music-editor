/**
 * Music Editor.
 *
 * Every control on this screen is wired to real behaviour: audio really plays,
 * the beat click really comes from the detected grid, overrides really persist,
 * and the library really survives a reload. Nothing here is a placeholder.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANALYSIS_VERSION } from "./analysis/pipeline";
import { Player, type PlayerState } from "./audio/player";
import {
  addTrack,
  setAudioHash,
  trackByFilePath,
  addCue,
  removeCue,
  setGridLocked,
  setManualKey,
  allTracks,
  bpmIsManual,
  effectiveBpm,
  effectiveGridOf,
  effectiveKey,
  markReviewed,
  removeTrack,
  db,
  setManualBpm,
  setManualGrid,
  type StoredTrack,
} from "./db/library";
import { deriveBeatTimes, type BeatGrid } from "./dsp/beats";
import { camelotLabel, keyName, openKeyLabel } from "./dsp/key";
import { needsReview, reviewReasons } from "./db/review";
import { useSetting } from "./ui/settings";
import { displayName, readTags } from "./metadata/tags";
import { isDesktop, pickFolder, readFile, scanFolder } from "./desktop/bridge";
import { computeAudioHash } from "./analysis/fingerprint";
import { DuplicatesPanel } from "./ui/DuplicatesPanel";
import { ExportPanel } from "./ui/ExportPanel";
import { MixMode } from "./ui/MixMode";
import { StemsPanel } from "./ui/StemsPanel";
import { TagWritePanel } from "./ui/TagWritePanel";
import { GridEditor } from "./ui/GridEditor";
import { WaveformView } from "./ui/WaveformView";
import { recommend } from "./analysis/recommendations";
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

export function App() {
  const [tracks, setTracks] = useState<StoredTrack[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [playerState, setPlayerState] = useState<PlayerState>("stopped");
  const [position, setPosition] = useState(0);
  const [clickOn, setClickOn] = useState(false);
  const [volume, setVolume] = useSetting("volume", 0.8);
  const [view, setView] = useState<"library" | "mix" | "duplicates">("library");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useSetting("filter", "all");
  const [sort, setSort] = useSetting("sort", "added");
  const [cueName, setCueName] = useState("");
  const [bpmDraft, setBpmDraft] = useState("");

  const playerRef = useRef<Player | null>(null);
  const schedulerRef = useRef<AnalysisScheduler | null>(null);
  const [notice, setNotice] = useState("");
  const decodedRef = useRef(new Map<string, AudioBuffer>());

  if (playerRef.current === null) playerRef.current = new Player();
  const player = playerRef.current;

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([allTracks(), db.jobs.toArray()]).then(([rows, storedJobs]) => {
        if (!alive) return;
        setTracks(rows);
        setJobs(current => Object.fromEntries(storedJobs
          .filter(j => j.status === "running" || j.status === "queued")
          .map(j => [j.id, current[j.id] ?? { stage: j.status, progress: 0 }])));
      }).catch(error => { if (alive) setNotice(String(error)); });
    };
    const scheduler = new AnalysisScheduler(workerRunner(player.audioContext), refresh,
      (id, stage, progress) => {
        if (alive) setJobs(current => ({ ...current, [id]: { stage, progress } }));
      });
    schedulerRef.current = scheduler;
    void scheduler.start().catch(error => setNotice(String(error)));
    return () => { alive = false; scheduler.dispose(); schedulerRef.current = null; };
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

  useEffect(() => {
    player.setVolume(volume);
  }, [player, volume]);

  const selected = useMemo(
    () => tracks.find((t) => t.id === selectedId) ?? null,
    [tracks, selectedId],
  );

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

  // Only a selection change loads audio. Refreshing analysis or edits must not seek.
  useEffect(() => {
    player.stop();
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      let buffer = decodedRef.current.get(selectedId);
      if (!buffer) {
        const track = await db.tracks.get(selectedId);
        if (!track || cancelled) return;
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
        );
        decodedRef.current.set(stored.id, buffer);
        setTracks(await allTracks());
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
    setNotice(`Scanning ${scan.files.length} file(s) from ${folder}…`);
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
    else void player.play();
  }, [player]);

  // Space toggles transport, as it does in every DJ tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
      if (event.code === "Space") {
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
    setTracks(await allTracks());
  }, [selected, bpmDraft]);

  const applyGrid = useCallback(
    async (grid: BeatGrid) => {
      if (!selected) return;
      try { await setManualGrid(selected.id, grid); }
      catch (error) { setNotice(String(error)); return; }
      setTracks(await allTracks());
    },
    [selected],
  );

  const revertGrid = useCallback(async () => {
    if (!selected) return;
    await setManualGrid(selected.id, null);
    setTracks(await allTracks());
  }, [selected]);

  const revertBpm = useCallback(async () => {
    if (!selected) return;
    await setManualBpm(selected.id, null);
    setTracks(await allTracks());
  }, [selected]);

  const visibleTracks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const rows = tracks.filter(t =>
      `${t.name} ${t.tags.artist ?? ""} ${t.tags.title ?? ""} ${t.tags.album ?? ""}`.toLocaleLowerCase().includes(needle) &&
      (filter === "all" || (filter === "review" ? needsReview(t) : filter === "failed" ? !!t.analysisError : t.reviewedAt !== null)));
    return rows.sort((a, b) => sort === "name" ? displayName(a.tags, a.name).localeCompare(displayName(b.tags, b.name)) :
      sort === "bpm" ? (effectiveBpm(a) ?? 0) - (effectiveBpm(b) ?? 0) : b.addedAt - a.addedAt);
  }, [tracks, query, filter, sort]);

  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    void recentlyPlayed().then(setRecentIds);
  }, [tracks]);

  const recommendations = useMemo(
    () => (selected ? recommend(selected, tracks, { recentIds }) : []),
    [selected, tracks, recentIds],
  );

  const key = selected ? effectiveKey(selected) : null;
  const job = selectedId ? jobs[selectedId] : undefined;
  const staleCount = tracks.filter(
    (t) => t.analysis !== null && (t.analysisVersion ?? 0) < ANALYSIS_VERSION,
  ).length;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
      }}
    >
      <header>
        <h1>Music Editor</h1>
        <div className="head-right">
          {staleCount > 0 && <span className="conf amber">{staleCount} stale</span>}
          <span className="muted">{tracks.length} tracks</span>
          <div className="views">
            {(["library", "mix", "duplicates"] as const).map((v) => (
              <button
                key={v}
                className={view === v ? "ghost active" : "ghost"}
                onClick={() => setView(v)}
              >
                {v === "library" ? "Library" : v === "mix" ? "Mix" : "Duplicates"}
              </button>
            ))}
          </div>
          {/* Desktop only: a browser cannot read a folder by path. */}
          {isDesktop() && (
            <button className="import" onClick={() => void importFolder()}>
              Import folder
            </button>
          )}
          <label className="import">
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

      <div className="transport">
        <input aria-label="Search library" placeholder="Search title, artist, album or filename" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="Filter library" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All tracks</option><option value="review">Needs verification</option>
          <option value="failed">Failed analysis</option><option value="reviewed">Reviewed</option>
        </select>
        <select aria-label="Sort library" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="added">Newest first</option><option value="name">Name</option><option value="bpm">BPM</option>
        </select>
        <label className="import">Add folder<input type="file" multiple
          ref={input => { input?.setAttribute("webkitdirectory", ""); }}
          onChange={e => { if (e.target.files) void addFiles(Array.from(e.target.files).filter(f => /\.(mp3|wav|flac|aiff?|m4a|aac|ogg|opus)$/i.test(f.name))); e.target.value = ""; }} /></label>
        <span>{visibleTracks.length} shown</span>
      </div>
      {notice && <p role="alert" className="error">{notice} <button onClick={() => setNotice("")}>Dismiss</button></p>}
      {view === "mix" && (
        <MixMode
          tracks={tracks}
          decoded={decodedRef.current}
          onNeedDecode={async (track) => {
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

      {view === "duplicates" && (
        <div className="inspector">
          <DuplicatesPanel
            tracks={tracks}
            onChanged={() => void allTracks().then(setTracks)}
          />
        </div>
      )}

      <div className="body" style={view === "library" ? undefined : { display: "none" }}>
        <ul className="library">
          {tracks.length === 0 && <li className="empty">Drop audio files here</li>}
          {visibleTracks.map((track) => {
            const running = jobs[track.id];
            const bpm = effectiveBpm(track);
            const trackKey = effectiveKey(track);
            return (
              <li
                key={track.id}
                className={track.id === selectedId ? "row selected" : "row"}
                onClick={() => setSelectedId(track.id)}
              >
                <span className="name">{displayName(track.tags, track.name)}</span>
                <span className="meta">
                  {track.analysisError ? (
                    <span className="conf red">failed</span>
                  ) : running ? (
                    <span>
                      {running.stage} {Math.round(running.progress * 100)}%
                    </span>
                  ) : (
                    <>
                      <span>
                        {bpm !== null ? `${bpm.toFixed(1)} BPM` : "—"}
                        {bpmIsManual(track) && <em className="manual"> manual</em>}
                      </span>
                      <span>{trackKey ? camelotLabel(trackKey.tonic, trackKey.mode) : "—"}</span>
                      <span>{formatTime(track.durationSec)}</span>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        <section className="inspector">
          {!selected && <p className="empty">Select a track</p>}
          {selected && (
            <>
              <div className="title-row">
                <h2>{displayName(selected.tags, selected.name)}</h2>
                <button
                  className="ghost"
                  onClick={async () => {
                    await schedulerRef.current?.cancel(selected.id);
                    await removeTrack(selected.id);
                    decodedRef.current.delete(selected.id);
                    setSelectedId(null);
                    setTracks(await allTracks());
                  }}
                >
                  Remove
                </button>
              </div>

              {selected.analysisError && <p className="error">{selected.analysisError}</p>}

              {peaks && (
                <WaveformView
                  peaks={peaks}
                  durationSec={selected.durationSec}
                  beats={beats}
                  firstDownbeatSec={activeGrid.grid?.firstDownbeatSec ?? null}
                  beatsPerBar={activeGrid.grid?.beatsPerBar ?? 4}
                  positionSec={position}
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

              <div className="transport">
                <button disabled={!!job} onClick={() => {
                  void schedulerRef.current?.enqueue(selected.id, 1).catch(error => setNotice(String(error)));
                }}>{selected.analysisError ? "Retry analysis" : "Reanalyse"}</button>
                {job && <button onClick={() => { void schedulerRef.current?.cancel(selected.id).catch(error => setNotice(String(error))); }}>Cancel analysis</button>}
              </div>
              {job && (
                <p className="muted">
                  Analysing — {job.stage} {Math.round(job.progress * 100)}%
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
                      {key && `${keyName(key.tonic, key.mode)} · ${camelotLabel(key.tonic, key.mode)} · ${openKeyLabel(key.tonic, key.mode)}`}
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
                      {selected.analysis.grid.isFixed ? "fixed" : "dynamic"} ·{" "}
                      {selected.analysis.grid.anchors.length} anchor(s) · offset{" "}
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
                        ? `${selected.analysis.loudness.integratedLufs.toFixed(1)} LUFS · range ${selected.analysis.loudness.rangeLu.toFixed(1)} LU · peak ${selected.analysis.loudness.samplePeakDbfs.toFixed(1)} dBFS ? true peak ${selected.analysis.loudness.truePeakDbtp.toFixed(1)} dBTP`
                        : "silent"}
                    </span>
                  </dd>

                  <dt>Energy</dt>
                  <dd>
                    <span className="value">{selected.analysis.energy ? `${selected.analysis.energy.level} / 10` : "Reanalyse to measure energy"}</span>
                    <span className={confidenceClass(selected.analysis.energy?.confidence ?? 0)}>
                      {((selected.analysis.energy?.confidence ?? 0) * 100).toFixed(0)}%
                    </span>
                    <span className="muted">
                      {selected.analysis.energy?.contributions
                        .slice(0, 3)
                        .map((c) => `${c.name} ${(c.normalised * 100).toFixed(0)}%`)
                        .join(" · ")}
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
                        .join(" · ") || selected.name}
                    </span>
                  </dd>

                  <dt>Review</dt>
                  <dd>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await markReviewed(selected.id, selected.reviewedAt === null);
                        setTracks(await allTracks());
                      }}
                    >
                      {selected.reviewedAt === null ? "Mark reviewed" : "Reviewed ✓"}
                    </button>
                    <span className="muted">
                      analysis v{selected.analysis.analysisVersion}
                      {(selected.analysisVersion ?? 0) < ANALYSIS_VERSION && " · stale"}
                    </span>
                  </dd>
                </dl>
              )}

              {activeGrid.grid && <label className="toggle"><input type="checkbox" checked={!!selected.gridLocked}
                onChange={async e => { await setGridLocked(selected.id, e.target.checked); setTracks(await allTracks()); }} />Lock grid</label>}
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
                    setTracks(await allTracks());
                  }}>
                  <option value="" disabled>Choose key</option>
                  {Array.from({ length: 12 }, (_, tonic) => ["major", "minor"].map(mode =>
                    <option key={`${tonic}:${mode}`} value={`${tonic}:${mode}`}>{keyName(tonic, mode as "major" | "minor")}</option>))}
                </select></label>
                <button onClick={async () => { await setManualKey(selected.id, null, null); setTracks(await allTracks()); }}>Revert key</button>
              </div>
              <div className="grid-editor">
                <h3>Cues</h3>
                <input aria-label="Cue name" placeholder="Cue name" value={cueName} onChange={e => setCueName(e.target.value)} />
                <button onClick={async () => {
                  try { await addCue(selected.id, position, cueName); setCueName(""); setTracks(await allTracks()); }
                  catch (error) { setNotice(String(error)); }
                }}>Add cue at playhead</button>
                {(selected.cues ?? []).map(cue => <div key={cue.id} className="transport">
                  <button onClick={() => player.seek(cue.timeSec)}>{cue.name} - {formatTime(cue.timeSec)}</button>
                  <button aria-label={`Remove cue ${cue.name}`} onClick={async () => { await removeCue(selected.id, cue.id); setTracks(await allTracks()); }}>Remove cue</button>
                </div>)}
              </div>
              {selected.analysis?.structure && <div className="grid-editor"><h3>Energy and section suggestions</h3>
                <p className="muted">
                  Bar energy with rule-based section labels. Boundaries come from
                  energy change on bar lines; labels are heuristics over energy and
                  vocal activity, not a model of song form.
                </p>
                <svg viewBox="0 0 600 80" width="100%" height="80" role="img" aria-label="Energy per bar">
                  {selected.analysis.structure.bars.map((bar, i, bars) => <rect key={i} x={i / bars.length * 600} y={80 * (1 - bar.energy)} width={600 / bars.length} height={80 * bar.energy} fill="#3f7d8c" />)}
                </svg>
                {selected.analysis.structure.sections.map(section => <div key={section.startSec} className="transport">
                  <button onClick={() => player.seek(section.startSec)}>{section.label}: {formatTime(section.startSec)}</button>
                  <button onClick={async () => { await addCue(selected.id, section.startSec, section.label); setTracks(await allTracks()); }}>Save as cue</button>
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
              <StemsPanel track={selected} />

              <TagWritePanel track={selected} filePath={selected.filePath ?? null} />

              <ExportPanel tracks={visibleTracks} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
