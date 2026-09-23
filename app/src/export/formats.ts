/**
 * Export (research Phase G).
 *
 * Writes standalone files - M3U8 and Rekordbox XML. Nothing here touches the
 * user's audio or any proprietary database, which is both the brief's rule and
 * the only thing a browser could do anyway.
 *
 * Rekordbox identifies tracks by an absolute `Location` URL. A web page cannot
 * know where a file sits on disk, so the caller supplies the folder the audio
 * lives in and it is joined to each filename. Exporting with the wrong folder
 * produces an XML that imports with missing files, so the UI asks for it
 * explicitly rather than guessing.
 */
import { deriveBeatTimes, type BeatGrid } from "../dsp/beats";
import { PITCH_NAMES, type Mode } from "../dsp/key";

export interface ExportTrack {
  id: string;
  filename: string;
  relativePath?: string;
  cues?: { name: string; timeSec: number }[];
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  year: number | null;
  trackNumber: number | null;
  comment: string | null;
  durationSec: number;
  sizeBytes: number;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bpm: number | null;
  keyTonic: number | null;
  keyMode: Mode | null;
  grid: BeatGrid | null;
  /** Milliseconds since epoch. */
  addedAt: number;
}

export interface ExportOptions {
  /** Absolute folder the audio files live in, e.g. `F:\Music` or `/Users/x/Music`. */
  baseFolder: string;
  playlistName?: string;
}

/** Rekordbox writes classic notation - "Am", "F#", not Camelot. */
export function tonalityLabel(tonic: number | null, mode: Mode | null): string {
  if (tonic === null || mode === null) return "";
  return `${PITCH_NAMES[tonic]}${mode === "minor" ? "m" : ""}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the `file://localhost/...` URL Rekordbox expects.
 *
 * Windows drive letters and backslashes are normalised, and each path segment
 * is percent-encoded so spaces and accents survive the round trip.
 */
export function locationUrl(baseFolder: string, filename: string): string {
  const normalised = baseFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  const withLeadingSlash = /^[A-Za-z]:/.test(normalised) ? `/${normalised}` : normalised;
  const full = `${withLeadingSlash}/${filename}`;
  const encoded = full
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `file://localhost${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * TEMPO elements describing the grid.
 *
 * `Battito` is the beat's position in its bar, 1-4. Getting it wrong makes
 * Rekordbox draw the downbeat in the wrong place even when the tempo is right.
 */
function tempoElements(track: ExportTrack): string {
  const grid = track.grid;
  if (!grid || grid.anchors.length === 0) return "";

  const beats = deriveBeatTimes(grid, track.durationSec);
  let downbeatIndex = 0;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] >= grid.firstDownbeatSec - 1e-6) {
      downbeatIndex = i;
      break;
    }
  }

  return grid.anchors
    .map((anchor) => {
      // Which beat of the bar does this anchor land on?
      let nearest = 0;
      let best = Infinity;
      for (let i = 0; i < beats.length; i++) {
        const distance = Math.abs(beats[i] - anchor.timeSec);
        if (distance < best) {
          best = distance;
          nearest = i;
        }
      }
      const offset = ((nearest - downbeatIndex) % grid.beatsPerBar + grid.beatsPerBar) %
        grid.beatsPerBar;
      const battito = offset + 1;
      return `      <TEMPO Inizio="${anchor.timeSec.toFixed(3)}" Bpm="${anchor.bpm.toFixed(2)}" Metro="${grid.beatsPerBar}/4" Battito="${battito}"/>`;
    })
    .join("\n");
}

/** A memory cue on the first downbeat, so the grid is visible on import. */
function positionMarks(track: ExportTrack): string {
  const cues = [...(track.cues ?? [])];
  if (track.grid && track.grid.firstDownbeatSec >= 0) cues.unshift({ name: "Downbeat", timeSec: track.grid.firstDownbeatSec });
  return cues.filter(c => Number.isFinite(c.timeSec) && c.timeSec >= 0 && c.timeSec < track.durationSec)
    .map(c => `      <POSITION_MARK Name="${escapeXml(c.name)}" Type="0" Start="${c.timeSec.toFixed(3)}" Num="-1"/>`).join("\n");
}

export function toRekordboxXml(tracks: ExportTrack[], options: ExportOptions): string {
  const playlistName = options.playlistName ?? "Music Editor";

  const entries = tracks
    .map((track, index) => {
      const id = index + 1;
      const attributes = [
        `TrackID="${id}"`,
        `Name="${escapeXml(track.title ?? track.filename)}"`,
        `Artist="${escapeXml(track.artist ?? "")}"`,
        `Composer=""`,
        `Album="${escapeXml(track.album ?? "")}"`,
        `Grouping=""`,
        `Genre="${escapeXml(track.genre ?? "")}"`,
        `Kind="${escapeXml(track.filename.split(".").pop()?.toUpperCase() ?? "")} File"`,
        `Size="${track.sizeBytes}"`,
        `TotalTime="${Math.round(track.durationSec)}"`,
        `DiscNumber="0"`,
        `TrackNumber="${track.trackNumber ?? 0}"`,
        `Year="${track.year ?? 0}"`,
        `AverageBpm="${track.bpm !== null ? track.bpm.toFixed(2) : "0.00"}"`,
        `DateAdded="${formatDate(track.addedAt)}"`,
        `BitRate="${track.bitrateKbps ?? 0}"`,
        `SampleRate="${track.sampleRate ?? 0}"`,
        `Comments="${escapeXml(track.comment ?? "")}"`,
        `PlayCount="0"`,
        `Rating="0"`,
        `Location="${escapeXml(locationUrl(options.baseFolder, track.relativePath ?? track.filename))}"`,
        `Remixer=""`,
        `Tonality="${tonalityLabel(track.keyTonic, track.keyMode)}"`,
        `Label=""`,
        `Mix=""`,
      ].join(" ");

      const children = [tempoElements(track), positionMarks(track)]
        .filter((s) => s.length > 0)
        .join("\n");

      return children.length > 0
        ? `    <TRACK ${attributes}>\n${children}\n    </TRACK>`
        : `    <TRACK ${attributes}/>`;
    })
    .join("\n");

  const playlistEntries = tracks.map((_, index) => `        <TRACK Key="${index + 1}"/>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Music Editor" Version="0.1.0" Company="Music Editor"/>
  <COLLECTION Entries="${tracks.length}">
${entries}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${escapeXml(playlistName)}" Type="1" KeyType="0" Entries="${tracks.length}">
${playlistEntries}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
}

export function toM3u8(tracks: ExportTrack[], options: ExportOptions): string {
  const base = options.baseFolder.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  const lines = ["#EXTM3U"];
  for (const track of tracks) {
    const label = track.artist && track.title ? `${track.artist} - ${track.title}` : track.filename;
    lines.push(`#EXTINF:${Math.round(track.durationSec)},${label}`);
    lines.push(`${base}${separator}${(track.relativePath ?? track.filename).replace(/[\\/]/g, separator)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Report what an export will and will not carry.
 *
 * Shown before the file is written, because a silent partial export is how
 * people discover at a gig that half their cue points did not travel.
 */
export interface ExportReport {
  trackCount: number;
  withBpm: number;
  withKey: number;
  withGrid: number;
  missingBpm: string[];
  missingKey: string[];
  missingGrid: string[];
}

export function buildExportReport(tracks: ExportTrack[]): ExportReport {
  const missingBpm: string[] = [];
  const missingKey: string[] = [];
  const missingGrid: string[] = [];
  for (const track of tracks) {
    if (track.bpm === null) missingBpm.push(track.filename);
    if (track.keyTonic === null) missingKey.push(track.filename);
    if (!track.grid) missingGrid.push(track.filename);
  }
  return {
    trackCount: tracks.length,
    withBpm: tracks.length - missingBpm.length,
    withKey: tracks.length - missingKey.length,
    withGrid: tracks.length - missingGrid.length,
    missingBpm,
    missingKey,
    missingGrid,
  };
}
