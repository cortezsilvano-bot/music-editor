/**
 * In-app playlists (Dexie v14).
 *
 * Playlists store ordered track ids only. Opening one filters the library list
 * to those ids (missing ids are skipped). Helpers keep rename/delete/reorder
 * in one place so the UI stays thin.
 */
import { db, type LibraryDatabase } from "./library";

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

function trimName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Playlist name cannot be empty");
  if (trimmed.length > 120) throw new Error("Playlist name is too long");
  return trimmed;
}

export async function listPlaylists(database: LibraryDatabase = db): Promise<Playlist[]> {
  return database.playlists.orderBy("updatedAt").reverse().toArray();
}

export async function getPlaylist(id: string, database: LibraryDatabase = db): Promise<Playlist | undefined> {
  return database.playlists.get(id);
}

export async function createPlaylist(name: string, database: LibraryDatabase = db): Promise<Playlist> {
  const now = Date.now();
  const playlist: Playlist = {
    id: crypto.randomUUID(),
    name: trimName(name),
    trackIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await database.playlists.add(playlist);
  return playlist;
}

export async function renamePlaylist(id: string, name: string, database: LibraryDatabase = db): Promise<void> {
  const next = trimName(name);
  const existing = await database.playlists.get(id);
  if (!existing) throw new Error("Playlist not found");
  await database.playlists.update(id, { name: next, updatedAt: Date.now() });
}

export async function deletePlaylist(id: string, database: LibraryDatabase = db): Promise<void> {
  await database.playlists.delete(id);
}

export async function addTrackToPlaylist(
  playlistId: string,
  trackId: string,
  database: LibraryDatabase = db,
): Promise<void> {
  await database.transaction("rw", database.playlists, async () => {
    const playlist = await database.playlists.get(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    if (playlist.trackIds.includes(trackId)) return;
    await database.playlists.update(playlistId, {
      trackIds: [...playlist.trackIds, trackId],
      updatedAt: Date.now(),
    });
  });
}

export async function removeTrackFromPlaylist(
  playlistId: string,
  trackId: string,
  database: LibraryDatabase = db,
): Promise<void> {
  await database.transaction("rw", database.playlists, async () => {
    const playlist = await database.playlists.get(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    if (!playlist.trackIds.includes(trackId)) return;
    await database.playlists.update(playlistId, {
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      updatedAt: Date.now(),
    });
  });
}

/** Reorder by moving trackId to toIndex (clamped). No-op if missing. */
export async function reorderPlaylistTrack(
  playlistId: string,
  trackId: string,
  toIndex: number,
  database: LibraryDatabase = db,
): Promise<void> {
  await database.transaction("rw", database.playlists, async () => {
    const playlist = await database.playlists.get(playlistId);
    if (!playlist) throw new Error("Playlist not found");
    const from = playlist.trackIds.indexOf(trackId);
    if (from < 0) return;
    const next = [...playlist.trackIds];
    next.splice(from, 1);
    const clamped = Math.max(0, Math.min(next.length, Math.floor(toIndex)));
    next.splice(clamped, 0, trackId);
    await database.playlists.update(playlistId, { trackIds: next, updatedAt: Date.now() });
  });
}

/** Drop a deleted library track from every playlist (best-effort cleanup). */
export async function purgeTrackFromPlaylists(trackId: string, database: LibraryDatabase = db): Promise<void> {
  const rows = await database.playlists.toArray();
  for (const playlist of rows) {
    if (!playlist.trackIds.includes(trackId)) continue;
    await database.playlists.update(playlist.id, {
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      updatedAt: Date.now(),
    });
  }
}
