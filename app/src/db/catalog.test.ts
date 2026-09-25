/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import Dexie, { liveQuery } from "dexie";
import { afterEach, beforeEach, expect, it } from "vitest";
import { analyze } from "../analysis/pipeline";
import { EMPTY_TAGS } from "../metadata/tags";
import { CatalogRepository, indexCatalogBatch, projectTrack } from "./catalog";
import { LibraryDatabase, type StoredTrack } from "./library";

let database: LibraryDatabase;
beforeEach(() => { database = new LibraryDatabase(`catalog-test-${crypto.randomUUID()}`); });
afterEach(async () => { await database.delete(); });
function track(id: string, n = 1): StoredTrack {
  return { id, name: `Song ${id}`, audio: new Blob([new Uint8Array(1024)]), peaks: new Float32Array(2000).buffer,
    mimeType: "audio/wav", sizeBytes: 1024, addedAt: n, durationSec: 120, tags: { ...EMPTY_TAGS, artist: "Artist" },
    analysis: null, analysisVersion: null, analysisError: null, manualBpm: null, manualGrid: null,
    manualKeyMode: null, manualKeyTonic: null, reviewedAt: null };
}

it("projects metadata without blobs, waveforms, fingerprints or analysis curves", () => {
  const full = { ...track("a"), analysis: analyze({ channels: [new Float32Array(512)], sampleRate: 22050 }) };
  const { metadata, key } = projectTrack(full);
  expect(metadata).not.toHaveProperty("audio"); expect(metadata).not.toHaveProperty("peaks");
  expect(metadata).not.toHaveProperty("fingerprint");
  expect(metadata.analysis).not.toHaveProperty("loudness"); expect(metadata.analysis?.energy).not.toHaveProperty("curve");
  expect(metadata.analysis?.key).not.toHaveProperty("chroma");
  expect(key.search).toContain("artist");
});

it("keeps edits and projections atomic, including collection modifications, deletes and clears", async () => {
  await database.tracks.bulkAdd([track("a"), track("b"), track("c")]);
  await database.tracks.update("a", { manualBpm: 128, "tags.title": "Updated" });
  expect(await database.catalogKeys.get("a")).toMatchObject({ bpm: 128, name: "Artist \u2014 Updated" });
  await database.tracks.where(":id").between("b", "d").modify({ reviewedAt: 100 });
  expect((await database.catalogKeys.get("b"))?.reviewed).toBe(1);
  await expect(database.transaction("rw", database.tracks, async () => {
    await database.tracks.update("a", { manualBpm: 90 }); throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await database.catalogKeys.get("a"))?.bpm).toBe(128);
  await database.tracks.where(":id").between("b", "d").delete();
  expect(await database.trackCatalog.toCollection().primaryKeys()).toEqual(["a"]);
  await database.tracks.clear();
  expect(await database.trackCatalog.count()).toBe(0); expect(await database.catalogKeys.count()).toBe(0);
});

it("projects only successful operations from a partially failed bulk add", async () => {
  await database.tracks.add({ ...track("a"), contentHash: "same" });
  await expect(database.tracks.bulkAdd([{ ...track("b"), contentHash: "same" }, track("c")])).rejects.toThrow();
  expect(await database.trackCatalog.toCollection().primaryKeys()).toEqual(["a", "c"]);
  expect(await database.catalogKeys.toCollection().primaryKeys()).toEqual(["a", "c"]);
});

it("aborts the track write if storing its projection fails", async () => {
  database.use({ stack: "dbcore", name: "fail-projection", level: 9, create: down => ({ ...down, table(name) {
    const table = down.table(name);
    return name === "trackCatalog" ? { ...table, mutate: async () => { throw new Error("Disk full"); } } : table;
  } }) });
  await expect(database.tracks.add(track("a"))).rejects.toThrow();
  expect(await database.tracks.count()).toBe(0); expect(await database.catalogKeys.count()).toBe(0);
});

it("paginates global matches, clamps a deleted last page, and exports every match", async () => {
  await database.tracks.bulkAdd(Array.from({ length: 205 }, (_, n) => track(`id-${n.toString().padStart(3, "0")}`, n)));
  const repository = new CatalogRepository(database);
  const first = await repository.page(); const last = await repository.page("", "all", "added", 200);
  expect(first.tracks).toHaveLength(100); expect(first.tracks[0].id).toBe("id-204");
  expect(last.tracks).toHaveLength(5);
  expect((await repository.page("id-001")).tracks.map(row => row.id)).toEqual(["id-001"]);
  expect(await repository.matching("Artist", "all", "name")).toHaveLength(205);
  await database.tracks.where(":id").below("id-006").delete();
  expect((await repository.page("", "all", "added", 200)).offset).toBe(100);
  expect((await repository.page("id-001")).total).toBe(0);
});

it("invalidates cached search keys and live queries after another connection edits a track", async () => {
  await database.tracks.add(track("a"));
  const repository = new CatalogRepository(database);
  await repository.page("Song");
  const other = new LibraryDatabase(database.name);
  let subscription: ReturnType<ReturnType<typeof liveQuery>['subscribe']> | undefined;
  try {
    const observed = new Promise<void>((resolve, reject) => {
      subscription = liveQuery(() => repository.page("Renamed")).subscribe({ next: result => {
        if (result.total === 1) resolve();
      }, error: reject });
    });
    await other.tracks.update("a", { name: "Renamed" });
    await observed;
    expect((await repository.page("Song")).total).toBe(0);
  } finally { subscription?.unsubscribe(); other.close(); }
});

it("seeks successive pages with tied sort values and invalidates counts after writes", async () => {
  await database.tracks.bulkAdd(Array.from({ length: 205 }, (_, n) => track(n.toString().padStart(3, "0"), 1)));
  const repository = new CatalogRepository(database);
  for (const sort of ["added", "bpm"]) {
    const pages = await Promise.all([0, 100, 200].map(offset => repository.page("", "all", sort, offset)));
    const ids = pages.flatMap(page => page.tracks.map(row => row.id));
    expect(new Set(ids).size).toBe(205);
    expect((await repository.page("", "all", sort, 100)).tracks.map(row => row.id)).toEqual(ids.slice(100, 200));
    expect((await repository.page("Song", "all", sort, 100)).tracks.map(row => row.id)).toEqual(ids.slice(100, 200));
  }
  await database.tracks.add(track("new", 2));
  const page = await repository.page();
  expect(page.total).toBe(206); expect(page.tracks[0].id).toBe("new");
});

it("backfills an upgraded library in resumable batches without losing intervening edits", async () => {
  const name = database.name;
  database.close();
  const legacy = new Dexie(name);
  legacy.version(12).stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash" });
  await legacy.table("tracks").bulkAdd([track("a"), track("b"), track("c")]); legacy.close();
  database = new LibraryDatabase(name);
  expect(await database.trackCatalog.count()).toBe(0);
  expect(await indexCatalogBatch(database, 1)).toBe(false);
  expect((await database.catalogState.get("tracks"))?.after).toBe("a");
  database.close(); database = new LibraryDatabase(name);
  await database.tracks.update("a", { manualBpm: 133 });
  await database.tracks.delete("b");
  await database.tracks.add(track("0")); // inserted behind the checkpoint, indexed by the write itself
  while (!(await indexCatalogBatch(database, 1))) { /* bounded test library */ }
  expect(await database.trackCatalog.toCollection().primaryKeys()).toEqual(["0", "a", "c"]);
  expect((await database.catalogKeys.get("a"))?.bpm).toBe(133);
  expect((await database.catalogState.get("tracks"))?.complete).toBe(true);
});

it("token search matches full-scan includes semantics for the same queries", async () => {
  const { catalogSearchTokens } = await import("./catalog");
  expect(catalogSearchTokens("Artist 17 — Title")).toEqual(["artist", "17", "title", "artist 17", "17 title"]);
  await database.tracks.bulkAdd(Array.from({ length: 40 }, (_, n) => ({
    ...track(`id-${n.toString().padStart(2, "0")}`, n),
    name: `Recording ${n}.wav`,
    tags: { ...EMPTY_TAGS, title: `Title ${n}`, artist: `Artist ${n % 10}`, album: `Album ${n % 5}` },
  })));
  const repository = new CatalogRepository(database);
  for (const query of ["artist 1", "title 12", "recording 3", "album 0"]) {
    const page = await repository.page(query, "all", "name");
    const all = await database.catalogKeys.toArray();
    const needle = query.toLocaleLowerCase();
    const expected = all.filter(row => row.search.includes(needle)).map(row => row.id).sort();
    expect(page.tracks.map(row => row.id).sort()).toEqual(expected);
    expect(page.total).toBe(expected.length);
  }
});

it("deep last-page jump returns the oldest added tracks without scanning from the head", async () => {
  await database.tracks.bulkAdd(Array.from({ length: 250 }, (_, n) => track(`id-${n.toString().padStart(3, "0")}`, n)));
  const repository = new CatalogRepository(database);
  const last = await repository.page("", "all", "added", 200);
  expect(last.tracks).toHaveLength(50);
  expect(last.tracks.map(row => row.id)).toEqual(
    Array.from({ length: 50 }, (_, n) => `id-${n.toString().padStart(3, "0")}`).reverse(),
  );
});
