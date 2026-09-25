/**
 * In-app playlists: create / rename / delete, add or remove the selected track,
 * and open a playlist as the library filter.
 */
import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  removeTrackFromPlaylist,
  renamePlaylist,
  reorderPlaylistTrack,
  type Playlist,
} from "../db/playlists";

interface Props {
  selectedTrackId: string | null;
  activePlaylistId: string | null;
  onOpenPlaylist: (playlistId: string | null) => void;
  onNotice?: (message: string) => void;
}

export function PlaylistsPanel({
  selectedTrackId,
  activePlaylistId,
  onOpenPlaylist,
  onNotice,
}: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    const sub = liveQuery(() => listPlaylists()).subscribe({
      next: setPlaylists,
      error: (error) => onNotice?.(String(error)),
    });
    return () => sub.unsubscribe();
  }, [onNotice]);

  const active = playlists.find((p) => p.id === activePlaylistId) ?? null;

  return (
    <div className="export-panel">
      <h3>Playlists</h3>
      <p className="muted">
        Create playlists, add the selected track, then Open to filter the library list.
      </p>

      <div className="ge-row">
        <input
          aria-label="New playlist name"
          placeholder="New playlist name"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void (async () => {
                try {
                  const created = await createPlaylist(draftName);
                  setDraftName("");
                  onOpenPlaylist(created.id);
                } catch (error) {
                  onNotice?.(String(error));
                }
              })();
            }
          }}
        />
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            void (async () => {
              try {
                const created = await createPlaylist(draftName || "Playlist");
                setDraftName("");
                onOpenPlaylist(created.id);
              } catch (error) {
                onNotice?.(String(error));
              }
            })();
          }}
        >
          Create
        </button>
      </div>

      <ul aria-label="Playlists" style={{ listStyle: "none", margin: "8px 0", padding: 0 }}>
        {playlists.length === 0 && <li className="muted">No playlists yet</li>}
        {playlists.map((playlist) => {
          const isActive = playlist.id === activePlaylistId;
          return (
            <li key={playlist.id} className="ge-row" style={{ marginBottom: 6 }}>
              {renamingId === playlist.id ? (
                <input
                  aria-label="Rename playlist"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => {
                    void (async () => {
                      try {
                        await renamePlaylist(playlist.id, renameDraft);
                        setRenamingId(null);
                      } catch (error) {
                        onNotice?.(String(error));
                      }
                    })();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  autoFocus
                />
              ) : (
                <strong style={{ minWidth: 120 }}>{playlist.name}</strong>
              )}
              <span className="muted">{playlist.trackIds.length} tracks</span>
              <button
                type="button"
                className={isActive ? "ghost small active" : "ghost small"}
                onClick={() => onOpenPlaylist(isActive ? null : playlist.id)}
              >
                {isActive ? "Showing" : "Open"}
              </button>
              <button
                type="button"
                className="ghost small"
                disabled={!selectedTrackId}
                onClick={() => {
                  if (!selectedTrackId) return;
                  void addTrackToPlaylist(playlist.id, selectedTrackId).catch((error) =>
                    onNotice?.(String(error)),
                  );
                }}
              >
                Add selected
              </button>
              <button
                type="button"
                className="ghost small"
                disabled={!selectedTrackId || !playlist.trackIds.includes(selectedTrackId)}
                onClick={() => {
                  if (!selectedTrackId) return;
                  void removeTrackFromPlaylist(playlist.id, selectedTrackId).catch((error) =>
                    onNotice?.(String(error)),
                  );
                }}
              >
                Remove selected
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  setRenamingId(playlist.id);
                  setRenameDraft(playlist.name);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  void (async () => {
                    try {
                      await deletePlaylist(playlist.id);
                      if (activePlaylistId === playlist.id) onOpenPlaylist(null);
                    } catch (error) {
                      onNotice?.(String(error));
                    }
                  })();
                }}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>

      {active && active.trackIds.length > 1 && selectedTrackId && active.trackIds.includes(selectedTrackId) && (
        <div className="ge-row">
          <span className="muted">Reorder selected in &ldquo;{active.name}&rdquo;</span>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              const index = active.trackIds.indexOf(selectedTrackId);
              if (index <= 0) return;
              void reorderPlaylistTrack(active.id, selectedTrackId, index - 1).catch((error) =>
                onNotice?.(String(error)),
              );
            }}
          >
            Move up
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              const index = active.trackIds.indexOf(selectedTrackId);
              if (index < 0 || index >= active.trackIds.length - 1) return;
              void reorderPlaylistTrack(active.id, selectedTrackId, index + 1).catch((error) =>
                onNotice?.(String(error)),
              );
            }}
          >
            Move down
          </button>
        </div>
      )}

      {activePlaylistId && (
        <button type="button" className="ghost small" onClick={() => onOpenPlaylist(null)}>
          Clear playlist filter
        </button>
      )}
    </div>
  );
}
