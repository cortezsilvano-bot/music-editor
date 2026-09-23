/**
 * Export panel (research Phase G).
 *
 * Shows a compatibility report before anything is written, because a silent
 * partial export is how people discover at a gig that half their grids did not
 * travel. Nothing is exported until the report has been seen.
 */
import { useMemo } from "react";
import { effectiveBpm, effectiveGridOf, effectiveKey, type StoredTrack } from "../db/library";
import {
  buildExportReport,
  toM3u8,
  toRekordboxXml,
  type ExportTrack,
} from "../export/formats";

import { useSetting } from "./settings";

interface Props {
  tracks: StoredTrack[];
}

function toExportTrack(track: StoredTrack): ExportTrack {
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

export function ExportPanel({ tracks }: Props) {
  const [baseFolder, setBaseFolder] = useSetting("exportFolder", "");
  const [playlistName, setPlaylistName] = useSetting("playlistName", "Music Editor");

  const exportTracks = useMemo(() => tracks.map(toExportTrack), [tracks]);
  const report = useMemo(() => buildExportReport(exportTracks), [exportTracks]);
  const ready = baseFolder.trim().length > 0 && exportTracks.length > 0;

  return (
    <div className="export-panel">
      <h3>Export</h3>

      <p className="muted">
        Rekordbox locates audio by absolute path, which a browser cannot know.
        Enter the parent folder of imported relative paths. For a folder import, choose the parent of the selected folder.
      </p>

      <div className="ge-row">
        <span className="ge-label">Folder</span>
        <input
          className="path"
          placeholder="F:\Music"
          value={baseFolder}
          onChange={(e) => setBaseFolder(e.target.value)}
        />
      </div>

      <div className="ge-row">
        <span className="ge-label">Playlist</span>
        <input
          className="path"
          value={playlistName}
          onChange={(e) => setPlaylistName(e.target.value)}
        />
      </div>

      <dl className="facts compact">
        <dt>Tracks</dt>
        <dd>
          <span className="value">{report.trackCount}</span>
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
        {!ready && <span className="muted">Enter a folder to enable export</span>}
      </div>
    </div>
  );
}
