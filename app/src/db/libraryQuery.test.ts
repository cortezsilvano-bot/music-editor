import { expect, it } from "vitest";
import { LibraryQuery } from "./libraryQuery";
import type { StoredTrack } from "./library";
import { EMPTY_TAGS } from "../metadata/tags";
function track(id: string, name: string, bpm: number, reviewedAt: number | null): StoredTrack {
  return { id, name, addedAt: Number(id), tags: { ...EMPTY_TAGS, artist: "Årtist", album: "Live" },
    analysis: null, analysisError: null, manualBpm: bpm, reviewedAt } as StoredTrack;
}
it("preserves case-insensitive metadata search, manual tempo sorting and review filters", () => {
  const tracks = [track("1", "Zulu.wav", 130, null), track("2", "Alpha.wav", 100, 1)];
  const query = new LibraryQuery(tracks);
  expect(query.query(" ÅRTIST ", "all", "name").map(t => t.id)).toEqual(["2", "1"]);
  expect(query.query("live", "all", "bpm").map(t => t.manualBpm)).toEqual([100, 130]);
  expect(query.query("", "review").map(t => t.id)).toEqual(["1"]);
  expect(query.query("", "reviewed").map(t => t.id)).toEqual(["2"]);
  expect(query.query("", "failed")).toEqual([]);
  expect(query.query("missing")).toEqual([]);
  expect(tracks.map(t => t.id)).toEqual(["1", "2"]);
});
it("rebuilds query keys from a new database snapshot after user edits", () => {
  const original = track("1", "Zulu.wav", 130, null);
  const updated = { ...original, manualBpm: 95, analysisError: "Decode failed" };
  const query = new LibraryQuery([updated, track("2", "Other.wav", 100, null)]);
  expect(query.query("", "all", "bpm")[0]).toBe(updated);
  expect(query.query("", "failed")).toEqual([updated]);
});
