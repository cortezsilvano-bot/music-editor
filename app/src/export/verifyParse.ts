/**
 * Minimal export parsers for round-trip verification (tests / shared verify).
 *
 * Not a full Rekordbox/Serato importer — only enough to assert that BPM, key,
 * cue labels/times, and tempo anchors survive Music Editor's writers.
 */

export interface ParsedRekordboxTrack {
  trackId: string;
  name: string;
  artist: string;
  averageBpm: number | null;
  tonality: string;
  location: string;
  tempos: { inizio: number; bpm: number; metro: string; battito: number }[];
  marks: { name: string; type: string; start: number; num: string }[];
}

export interface ParsedM3uEntry {
  durationSec: number;
  label: string;
  path: string;
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'") : "";
}

/** Collection TRACK elements only (excludes playlist Key refs). */
export function parseRekordboxXml(xml: string): ParsedRekordboxTrack[] {
  const tracks: ParsedRekordboxTrack[] = [];
  const collection = xml.match(/<COLLECTION\b[^>]*>([\s\S]*?)<\/COLLECTION>/i);
  if (!collection) return tracks;
  const body = collection[1];
  const trackRe = /<TRACK\b([^>]*)(?:\/>|>([\s\S]*?)<\/TRACK>)/gi;
  let match: RegExpExecArray | null;
  while ((match = trackRe.exec(body))) {
    const openAttrs = match[1];
    const inner = match[2] ?? "";
    const tempos: ParsedRekordboxTrack["tempos"] = [];
    const tempoRe = /<TEMPO\b([^>]*)\/?>/gi;
    let t: RegExpExecArray | null;
    while ((t = tempoRe.exec(inner))) {
      tempos.push({
        inizio: Number(attr(t[1], "Inizio")),
        bpm: Number(attr(t[1], "Bpm")),
        metro: attr(t[1], "Metro"),
        battito: Number(attr(t[1], "Battito")),
      });
    }
    const marks: ParsedRekordboxTrack["marks"] = [];
    const markRe = /<POSITION_MARK\b([^>]*)\/?>/gi;
    let m: RegExpExecArray | null;
    while ((m = markRe.exec(inner))) {
      marks.push({
        name: attr(m[1], "Name"),
        type: attr(m[1], "Type"),
        start: Number(attr(m[1], "Start")),
        num: attr(m[1], "Num"),
      });
    }
    const bpmRaw = attr(openAttrs, "AverageBpm");
    tracks.push({
      trackId: attr(openAttrs, "TrackID"),
      name: attr(openAttrs, "Name"),
      artist: attr(openAttrs, "Artist"),
      averageBpm: bpmRaw === "" || bpmRaw === "0.00" ? (bpmRaw === "0.00" ? 0 : null) : Number(bpmRaw),
      tonality: attr(openAttrs, "Tonality"),
      location: attr(openAttrs, "Location"),
      tempos,
      marks,
    });
  }
  return tracks;
}

export function parseM3u8(text: string): ParsedM3uEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ParsedM3uEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF:")) continue;
    const meta = line.slice("#EXTINF:".length);
    const comma = meta.indexOf(",");
    const durationSec = Number(comma >= 0 ? meta.slice(0, comma) : meta);
    const label = comma >= 0 ? meta.slice(comma + 1) : "";
    const pathLine = lines[i + 1] ?? "";
    if (!pathLine || pathLine.startsWith("#")) continue;
    entries.push({ durationSec, label, path: pathLine });
    i += 1;
  }
  return entries;
}
