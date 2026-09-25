import { describe, expect, it } from "vitest";
import { proposeRelocateMatches } from "./batchRelocate";

describe("proposeRelocateMatches", () => {
  it("matches by unique basename by default", () => {
    const result = proposeRelocateMatches(
      [
        { id: "1", filePath: "F:/Old/a.mp3", name: "a.mp3" },
        { id: "2", filePath: "F:/Old/b.mp3", name: "b.mp3" },
      ],
      [
        { path: "F:/New/a.mp3", relativePath: "a.mp3", name: "a.mp3" },
        { path: "F:/New/b.mp3", relativePath: "b.mp3", name: "b.mp3" },
      ],
    );
    expect(result.matches).toEqual([
      { trackId: "1", oldPath: "F:/Old/a.mp3", newPath: "F:/New/a.mp3", matchBy: "basename" },
      { trackId: "2", oldPath: "F:/Old/b.mp3", newPath: "F:/New/b.mp3", matchBy: "basename" },
    ]);
    expect(result.ambiguous).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it("prefers unique relativePath when present", () => {
    const result = proposeRelocateMatches(
      [{ id: "1", filePath: "F:/Old/x/a.mp3", name: "a.mp3", relativePath: "x/a.mp3" }],
      [
        { path: "F:/New/x/a.mp3", relativePath: "x/a.mp3", name: "a.mp3" },
        { path: "F:/New/y/a.mp3", relativePath: "y/a.mp3", name: "a.mp3" },
      ],
    );
    expect(result.matches).toEqual([
      {
        trackId: "1",
        oldPath: "F:/Old/x/a.mp3",
        newPath: "F:/New/x/a.mp3",
        matchBy: "relativePath",
      },
    ]);
  });

  it("skips ambiguous basenames", () => {
    const result = proposeRelocateMatches(
      [{ id: "1", filePath: "F:/Old/a.mp3", name: "a.mp3" }],
      [
        { path: "F:/New/1/a.mp3", relativePath: "1/a.mp3", name: "a.mp3" },
        { path: "F:/New/2/a.mp3", relativePath: "2/a.mp3", name: "a.mp3" },
      ],
    );
    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toEqual(["1"]);
  });

  it("lists unmatched tracks", () => {
    const result = proposeRelocateMatches(
      [{ id: "1", filePath: "F:/Old/missing.mp3", name: "missing.mp3" }],
      [{ path: "F:/New/other.mp3", relativePath: "other.mp3", name: "other.mp3" }],
    );
    expect(result.unmatched).toEqual(["1"]);
  });
});
