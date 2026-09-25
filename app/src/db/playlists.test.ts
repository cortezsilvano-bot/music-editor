/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryDatabase } from "./library";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  purgeTrackFromPlaylists,
  removeTrackFromPlaylist,
  renamePlaylist,
  reorderPlaylistTrack,
} from "./playlists";

let database: LibraryDatabase;

beforeEach(() => {
  database = new LibraryDatabase(`playlists-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await database.delete();
});

describe("playlists helpers", () => {
  it("creates, renames, lists and deletes", async () => {
    const created = await createPlaylist(" Warmup ", database);
    expect(created.name).toBe("Warmup");
    expect(created.trackIds).toEqual([]);
    await renamePlaylist(created.id, "Openers", database);
    const listed = await listPlaylists(database);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Openers");
    await deletePlaylist(created.id, database);
    expect(await listPlaylists(database)).toHaveLength(0);
  });

  it("rejects empty names", async () => {
    await expect(createPlaylist("   ", database)).rejects.toThrow(/empty/i);
  });

  it("adds, removes and reorders tracks without duplicating", async () => {
    const playlist = await createPlaylist("Set", database);
    await addTrackToPlaylist(playlist.id, "a", database);
    await addTrackToPlaylist(playlist.id, "b", database);
    await addTrackToPlaylist(playlist.id, "a", database);
    let row = await database.playlists.get(playlist.id);
    expect(row?.trackIds).toEqual(["a", "b"]);
    await reorderPlaylistTrack(playlist.id, "a", 2, database);
    row = await database.playlists.get(playlist.id);
    expect(row?.trackIds).toEqual(["b", "a"]);
    await removeTrackFromPlaylist(playlist.id, "b", database);
    row = await database.playlists.get(playlist.id);
    expect(row?.trackIds).toEqual(["a"]);
  });

  it("purges a deleted track from every playlist", async () => {
    const one = await createPlaylist("One", database);
    const two = await createPlaylist("Two", database);
    await addTrackToPlaylist(one.id, "gone", database);
    await addTrackToPlaylist(one.id, "keep", database);
    await addTrackToPlaylist(two.id, "gone", database);
    await purgeTrackFromPlaylists("gone", database);
    expect((await database.playlists.get(one.id))?.trackIds).toEqual(["keep"]);
    expect((await database.playlists.get(two.id))?.trackIds).toEqual([]);
  });
});
