import { describe, expect, it } from "vitest";
import { canExportAll, gateTracksByReview } from "./reviewGate";

const tracks = [
  { id: "a", name: "Ready.mp3" },
  { id: "b", name: "Needs.mp3" },
  { id: "c", name: "Also.mp3" },
];

describe("gateTracksByReview", () => {
  it("blocks tracks flagged for review and allows the rest", () => {
    const result = gateTracksByReview(tracks, { a: false, b: true, c: false });
    expect(result.blocked).toEqual([{ id: "b", name: "Needs.mp3" }]);
    expect(result.allowed.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("accepts a Map", () => {
    const map = new Map<string, boolean>([
      ["a", true],
      ["b", false],
    ]);
    const result = gateTracksByReview(tracks, map);
    expect(result.blocked.map((t) => t.id)).toEqual(["a"]);
    expect(canExportAll(tracks, map)).toBe(false);
  });

  it("allows export when nothing needs review", () => {
    expect(canExportAll(tracks, {})).toBe(true);
  });
});
