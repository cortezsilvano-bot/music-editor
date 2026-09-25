/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { BeatGrid } from "../dsp/beats";
import { gateTracksByReview } from "./reviewGate";
import {
  toM3u8,
  toRekordboxXml,
  type ExportTrack,
} from "./formats";
import { parseM3u8, parseRekordboxXml } from "./verifyParse";

const grid: BeatGrid = {
  anchors: [{ timeSec: 0.512, beatIndex: 0, bpm: 128 }],
  beatsPerBar: 4,
  firstDownbeatSec: 0.512,
  isFixed: true,
  gridConfidence: 0.9,
  downbeatConfidence: 0.8,
};

function fixture(partial: Partial<ExportTrack> & Pick<ExportTrack, "id" | "filename">): ExportTrack {
  return {
    title: partial.title ?? partial.filename,
    artist: partial.artist ?? "Artist",
    album: "Demo",
    genre: "Latin",
    year: 2024,
    trackNumber: 1,
    comment: null,
    durationSec: 244.8,
    sizeBytes: 5_000_000,
    bitrateKbps: 320,
    sampleRate: 44100,
    bpm: 128,
    keyTonic: 9,
    keyMode: "minor",
    grid,
    cues: [{ name: "Drop", timeSec: 32.0 }],
    addedAt: Date.UTC(2026, 8, 21, 12, 0, 0),
    ...partial,
  };
}

const ready = fixture({
  id: "ready",
  filename: "Ready.mp3",
  title: "Ready Track",
  artist: "Test & Co",
  relativePath: "sets/Ready.mp3",
});

const needsReview = fixture({
  id: "review",
  filename: "NeedsReview.mp3",
  title: "Needs Review",
  bpm: 120,
  keyTonic: 0,
  keyMode: "major",
  cues: [{ name: "Intro", timeSec: 8.25 }],
});

describe("export round-trip (Rekordbox XML)", () => {
  it("preserves BPM, key, cues, and tempo grid positions", () => {
    const xml = toRekordboxXml([ready], {
      baseFolder: String.raw`F:\Music`,
      playlistName: "RoundTrip",
    });
    const parsed = parseRekordboxXml(xml);
    expect(parsed).toHaveLength(1);
    const track = parsed[0];
    expect(track.name).toBe("Ready Track");
    expect(track.artist).toBe("Test & Co");
    expect(track.averageBpm).toBe(128);
    expect(track.tonality).toBe("Am");
    expect(track.location).toContain("Ready.mp3");
    expect(track.tempos).toEqual([
      expect.objectContaining({ inizio: 0.512, bpm: 128, metro: "4/4", battito: 1 }),
    ]);
    expect(track.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Downbeat", start: 0.512 }),
        expect.objectContaining({ name: "Drop", start: 32 }),
      ]),
    );
  });

  it("round-trips multiple fixture tracks", () => {
    const second = fixture({
      id: "b",
      filename: "Other.mp3",
      title: "Other",
      bpm: 140,
      keyTonic: 0,
      keyMode: "major",
      grid: {
        ...grid,
        anchors: [{ timeSec: 1.0, beatIndex: 0, bpm: 140 }],
        firstDownbeatSec: 1.0,
      },
      cues: [{ name: "Break", timeSec: 64.5 }],
    });
    const xml = toRekordboxXml([ready, second], { baseFolder: "/m", playlistName: "Two" });
    const parsed = parseRekordboxXml(xml);
    expect(parsed.map((t) => t.averageBpm)).toEqual([128, 140]);
    expect(parsed.map((t) => t.tonality)).toEqual(["Am", "C"]);
    expect(parsed[1].marks.find((m) => m.name === "Break")?.start).toBe(64.5);
  });
});

describe("export round-trip (M3U8)", () => {
  it("preserves duration labels and paths", () => {
    const text = toM3u8([ready], { baseFolder: String.raw`F:\Music` });
    const entries = parseM3u8(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].durationSec).toBe(245);
    expect(entries[0].label).toBe("Test & Co - Ready Track");
    expect(entries[0].path.replace(/\\/g, "/")).toMatch(/Music\/sets\/Ready\.mp3$/);
  });
});

describe("review gate + export consistency", () => {
  it("skips unreviewed tracks from the written export", () => {
    const gate = gateTracksByReview(
      [
        { id: ready.id, name: ready.filename },
        { id: needsReview.id, name: needsReview.filename },
      ],
      { [ready.id]: false, [needsReview.id]: true },
    );
    expect(gate.blocked.map((t) => t.id)).toEqual([needsReview.id]);
    const allowed = [ready, needsReview].filter((t) =>
      gate.allowed.some((a) => a.id === t.id),
    );
    const xml = toRekordboxXml(allowed, { baseFolder: "/m", playlistName: "Gated" });
    const parsed = parseRekordboxXml(xml);
    expect(parsed.map((t) => t.name)).toEqual(["Ready Track"]);
    expect(parsed.some((t) => t.name === "Needs Review")).toBe(false);

    const m3u = parseM3u8(toM3u8(allowed, { baseFolder: "/m" }));
    expect(m3u.map((e) => e.label)).toEqual(["Test & Co - Ready Track"]);
  });
});
