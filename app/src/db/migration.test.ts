/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";
import { LibraryDatabase } from "./library";
it("upgrades an actual v1 database while preserving legacy analysis and manual edits", async () => {
  const name = "migration-test";
  await Dexie.delete(name);
  const old = new Dexie(name);
  old.version(1).stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt" });
  await old.table("tracks").add({ id: "legacy", name: "old.wav", manualBpm: 123,
    manualKeyTonic: 4, manualKeyMode: "minor", analysisVersion: 1,
    analysis: { analysisVersion: 1, tempo: { bpm: 120 } } });
  old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    const stored = await upgraded.tracks.get("legacy");
    expect(stored?.manualBpm).toBe(123);
    expect(stored?.manualKeyTonic).toBe(4);
    expect(stored?.analysis?.tempo.bpm).toBe(120);
    expect(stored?.manualGrid).toBeNull();
    expect(stored?.tags.title).toBeNull();
    expect(await upgraded.jobs.count()).toBe(0);
  } finally { upgraded.close(); await Dexie.delete(name); }
});
