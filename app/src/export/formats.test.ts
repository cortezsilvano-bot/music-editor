/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { BeatGrid } from "../dsp/beats";
import {
  buildExportReport,
  locationUrl,
  toM3u8,
  toRekordboxXml,
  tonalityLabel,
  type ExportTrack,
} from "./formats";

const grid: BeatGrid = {
  anchors: [{ timeSec: 0.512, beatIndex: 0, bpm: 128 }],
  beatsPerBar: 4,
  firstDownbeatSec: 0.512,
  isFixed: true,
  gridConfidence: 0.9,
  downbeatConfidence: 0.8,
};

const track: ExportTrack = {
  id: "a",
  filename: "La Revoltoza.mp3",
  title: "La Revoltoza",
  artist: "Test & Co",
  album: "Demo",
  genre: "Latin",
  year: 2024,
  trackNumber: 3,
  comment: null,
  durationSec: 244.8,
  sizeBytes: 5875820,
  bitrateKbps: 192,
  sampleRate: 48000,
  bpm: 128,
  keyTonic: 9,
  keyMode: "minor",
  grid,
  addedAt: Date.UTC(2026, 8, 21, 12, 0, 0),
};

describe("tonalityLabel", () => {
  it("writes classic notation, not Camelot", () => {
    expect(tonalityLabel(9, "minor")).toBe("Am");
    expect(tonalityLabel(0, "major")).toBe("C");
    expect(tonalityLabel(6, "minor")).toBe("F#m");
  });

  it("is empty when the key is unknown", () => {
    expect(tonalityLabel(null, null)).toBe("");
  });
});

describe("locationUrl", () => {
  it("builds a file URL from a Windows path", () => {
    expect(locationUrl(String.raw`F:\Music`, "a b.mp3")).toBe("file://localhost/F:/Music/a%20b.mp3");
  });

  it("builds a file URL from a POSIX path", () => {
    expect(locationUrl("/home/x/Music", "a.mp3")).toBe("file://localhost/home/x/Music/a.mp3");
  });

  it("tolerates a trailing separator", () => {
    expect(locationUrl(String.raw`F:\Music` + "\\", "a.mp3")).toBe("file://localhost/F:/Music/a.mp3");
  });

  it("percent-encodes accents and symbols", () => {
    expect(locationUrl("/m", "Peña & Co.mp3")).toBe("file://localhost/m/Pe%C3%B1a%20%26%20Co.mp3");
  });
});

describe("toRekordboxXml", () => {
  const xml = toRekordboxXml([track], { baseFolder: String.raw`F:\Music`, playlistName: "Set" });

  it("declares the entry count", () => {
    expect(xml).toContain('<COLLECTION Entries="1">');
    expect(xml).toContain('Entries="1"');
  });

  it("escapes XML-significant characters in tags", () => {
    expect(xml).toContain('Artist="Test &amp; Co"');
    expect(xml).not.toMatch(/Artist="Test & Co"/);
  });

  it("writes tempo as a grid anchor, not just a number", () => {
    expect(xml).toContain('<TEMPO Inizio="0.512" Bpm="128.00" Metro="4/4" Battito="1"/>');
  });

  it("writes the key in Rekordbox's notation", () => {
    expect(xml).toContain('Tonality="Am"');
  });

  it("writes BPM to two decimals", () => {
    expect(xml).toContain('AverageBpm="128.00"');
  });

  it("emits a memory cue on the downbeat", () => {
    expect(xml).toContain('<POSITION_MARK Name="Downbeat" Type="0" Start="0.512" Num="-1"/>');
  });

  it("references each track from the playlist node", () => {
    expect(xml).toContain('<TRACK Key="1"/>');
    expect(xml).toContain('<NODE Name="Set" Type="1" KeyType="0" Entries="1">');
  });

  it("is well-formed XML", () => {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
    expect(parsed.getElementsByTagName("TRACK")).toHaveLength(2); // collection + playlist ref
  });

  it("writes a self-closing track when there is no grid", () => {
    const bare = toRekordboxXml([{ ...track, grid: null }], { baseFolder: "/m" });
    expect(bare).toMatch(/<TRACK [^>]*\/>/);
    expect(bare).not.toContain("<TEMPO");
  });

  it("emits one TEMPO per anchor for a dynamic grid", () => {
    const dynamic: BeatGrid = {
      ...grid,
      isFixed: false,
      anchors: [
        { timeSec: 0.5, beatIndex: 0, bpm: 120 },
        { timeSec: 16.5, beatIndex: 32, bpm: 126 },
      ],
    };
    const out = toRekordboxXml([{ ...track, grid: dynamic }], { baseFolder: "/m" });
    expect(out.match(/<TEMPO /g)).toHaveLength(2);
  });

  it("handles an empty collection", () => {
    const empty = toRekordboxXml([], { baseFolder: "/m" });
    expect(empty).toContain('<COLLECTION Entries="0">');
    const parsed = new DOMParser().parseFromString(empty, "application/xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);
  });
});

describe("toM3u8", () => {
  it("starts with the header", () => {
    expect(toM3u8([track], { baseFolder: "/m" }).startsWith("#EXTM3U\n")).toBe(true);
  });

  it("writes duration and label", () => {
    expect(toM3u8([track], { baseFolder: "/m" })).toContain("#EXTINF:245,Test & Co - La Revoltoza");
  });

  it("uses the platform separator implied by the base folder", () => {
    expect(toM3u8([track], { baseFolder: String.raw`F:\Music` })).toContain(String.raw`F:\Music\La Revoltoza.mp3`);
    expect(toM3u8([track], { baseFolder: "/m" })).toContain("/m/La Revoltoza.mp3");
  });

  it("falls back to the filename with no tags", () => {
    const bare = toM3u8([{ ...track, artist: null, title: null }], { baseFolder: "/m" });
    expect(bare).toContain("#EXTINF:245,La Revoltoza.mp3");
  });
});

describe("buildExportReport", () => {
  it("counts what will travel", () => {
    const report = buildExportReport([track, { ...track, bpm: null, grid: null, keyTonic: null }]);
    expect(report.trackCount).toBe(2);
    expect(report.withBpm).toBe(1);
    expect(report.withKey).toBe(1);
    expect(report.withGrid).toBe(1);
    expect(report.missingBpm).toEqual(["La Revoltoza.mp3"]);
  });

  it("reports an empty selection cleanly", () => {
    expect(buildExportReport([])).toMatchObject({ trackCount: 0, withBpm: 0 });
  });
});
