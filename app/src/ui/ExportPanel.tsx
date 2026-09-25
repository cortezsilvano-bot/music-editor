import type { TrackMetadata } from "../db/catalog";
/**
 * Export panel (research Phase G).
 *
 * Shows a compatibility report before anything is written, because a silent
 * partial export is how people discover at a gig that half their grids did not
 * travel. Nothing is exported until the report has been seen.
 *
 * Tracks that still need review (catalogKeys.review) are blocked from export
 * by default — mark them reviewed first.
 */
import { useEffect, useMemo, useState } from "react";
import { liveQuery } from "dexie";
import { CatalogRepository } from "../db/catalog";
import { db, effectiveBpm, effectiveGridOf, effectiveKey } from "../db/library";
import {
  buildExportReport,
  toM3u8,
  toRekordboxXml,
  type ExportTrack,
} from "../export/formats";
import { gateTracksByReview } from "../export/reviewGate";

import { useSetting } from "./settings";

interface Props {
  query: string; filter: string; sort: string;
}

function toExportTrack(track: TrackMetadata): ExportTrack {
  const key = effectiveKey(track);
  return {
    id: track.id,
    filename: track.name,
    relativePath: track.relativePath,
    cues: track.cues,
    title: track.tags.title,
    artist: track.tags.artist,
    album: track.tags.album,
    genre: track.tags.genre,
    year: track.tags.year,
    trackNumber: track.tags.trackNumber,
    comment: track.tags.comment,
    durationSec: track.durationSec,
    sizeBytes: track.sizeBytes,
    bitrateKbps: track.tags.bitrateKbps,
    sampleRate: track.tags.sampleRate,
    bpm: effectiveBpm(track),
    keyTonic: key?.tonic ?? null,
    keyMode: key?.mode ?? null,
    grid: effectiveGridOf(track).grid,
    addedAt: track.addedAt,
  };
}

function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke on the next tick; revoking immediately can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportPanel({ query, filter, sort }: Props) {
  const [tracks, setTracks] = useState<TrackMetadata[]>([]);
  const [reviewFlags, setReviewFlags] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const queryId = JSON.stringify([query, filter, sort]);
  const repository = useMemo(() => new CatalogRepository(db), []);
  useEffect(() => {
    const subscription = liveQuery(async () => {
      if (!(await db.catalogState.get("tracks"))?.complete) return null;
      return repository.matching(query, filter, sort);
    }).subscribe({ next: rows => { setTracks(rows ?? []); setLoadedQuery(rows ? queryId : ""); setError(""); }, error: reason => setError(String(reason)) });
    return () => subscription.unsubscribe();
  }, [repository, query, filter, sort, queryId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (tracks.length === 0) {
        setReviewFlags({});
        return;
      }
      const keys = await db.catalogKeys.bulkGet(tracks.map((t) => t.id));
      if (cancelled) return;
      const flags: Record<string, boolean> = {};
      tracks.forEach((t, i) => {
        flags[t.id] = keys[i]?.review === 1;
      });
      setReviewFlags(flags);
    })();
    return () => {
      cancelled = true;
    };
  }, [tracks]);

  const [baseFolder, setBaseFolder] = useSetting("exportFolder", "");
  const [playlistName, setPlaylistName] = useSetting("playlistName", "Music Editor");

  const gate = useMemo(
    () =>
      gateTracksByReview(
        tracks.map((t) => ({ id: t.id, name: t.name })),
        reviewFlags,
      ),
    [tracks, reviewFlags],
  );

  const exportableTracks = useMemo(
    () => tracks.filter((t) => !reviewFlags[t.id]),
    [tracks, reviewFlags],
  );
  const exportTracks = useMemo(() => exportableTracks.map(toExportTrack), [exportableTracks]);
  const report = useMemo(() => buildExportReport(exportTracks), [exportTracks]);
  const reviewBlocked = gate.blocked.length > 0;
  // Default: skip tracks that still need review (do not silently include them).
  // Export of the remaining reviewed/clear tracks stays available.
  const ready =
    !error &&
    loadedQuery === queryId &&
    baseFolder.trim().length > 0 &&
    exportTracks.length > 0;

  return (
    <div className="export-panel">
      <h3>Export</h3>
      {error && <p role="alert">{error}</p>}
      {loadedQuery !== queryId && <p role="status">Loading all matching tracks for export...</p>}

      <p className="muted">
        Rekordbox locates audio by absolute path, which a browser cannot know.
        Enter the parent folder of imported relative paths. For a folder import, choose the parent of the selected folder.
      </p>

      <div className="ge-row">
        <span className="ge-label">Folder</span>
        <input
          className="path"
          placeholder="F:\Music"
          aria-label="Export audio folder"
          value={baseFolder}
          onChange={(e) => setBaseFolder(e.target.value)}
        />
      </div>

      <div className="ge-row">
        <span className="ge-label">Playlist</span>
        <input
          className="path"
          value={playlistName}
          aria-label="Export playlist name"
          onChange={(e) => setPlaylistName(e.target.value)}
        />
      </div>

      {reviewBlocked && (
        <p role="status" className="conf amber">
          Skipping {gate.blocked.length} track
          {gate.blocked.length === 1 ? "" : "s"} that still need review (default:
          no override — mark reviewed to include them). Exporting {gate.allowed.length}{" "}
          clear track{gate.allowed.length === 1 ? "" : "s"}.
        </p>
      )}

      <dl className="facts compact">
        <dt>Tracks</dt>
        <dd>
          <span className="value">{report.trackCount}</span>
          {reviewBlocked && (
            <span className="conf amber">{gate.blocked.length} in review</span>
          )}
        </dd>
        <dt>With BPM</dt>
        <dd>
          <span className="value">
            {report.withBpm} / {report.trackCount}
          </span>
          {report.missingBpm.length > 0 && (
            <span className="conf amber">{report.missingBpm.length} missing</span>
          )}
        </dd>
        <dt>With key</dt>
        <dd>
          <span className="value">
            {report.withKey} / {report.trackCount}
          </span>
          {report.missingKey.length > 0 && (
            <span className="conf amber">{report.missingKey.length} missing</span>
          )}
        </dd>
        <dt>With grid</dt>
        <dd>
          <span className="value">
            {report.withGrid} / {report.trackCount}
          </span>
          {report.missingGrid.length > 0 && (
            <span className="conf amber">{report.missingGrid.length} missing</span>
          )}
        </dd>
      </dl>

      <div className="ge-row">
        <button
          className="ghost small"
          disabled={!ready}
          onClick={() =>
            download(
              `${playlistName}.xml`,
              toRekordboxXml(exportTracks, { baseFolder, playlistName }),
              "application/xml",
            )
          }
        >
          Rekordbox XML
        </button>
        <button
          className="ghost small"
          disabled={!ready}
          onClick={() =>
            download(`${playlistName}.m3u8`, toM3u8(exportTracks, { baseFolder }), "audio/x-mpegurl")
          }
        >
          M3U8
        </button>
        {!ready && (
          <span className="muted">
            {reviewBlocked && exportTracks.length === 0
              ? "All matching tracks need review"
              : "Enter a folder to enable export"}
          </span>
        )}
      </div>
    </div>
  );
}
