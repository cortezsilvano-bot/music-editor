/**
 * Desktop file-path status and relocate control.
 *
 * Folder-imported tracks store an absolute filePath. After a move on disk the
 * path goes missing; Relocate picks a new file and keeps analysis when the
 * SHA-256 still matches.
 */
import { useCallback, useEffect, useState } from "react";
import type { StoredTrack } from "../db/library";
import {
  isDesktop,
  pathStatus,
  pickAudioFile,
  readFile,
} from "../desktop/bridge";
import { relocateTrackFile } from "../desktop/relocate";

interface Props {
  track: StoredTrack;
}

export function FileLocationPanel({ track }: Props) {
  const desktop = isDesktop();
  const filePath = track.filePath ?? null;
  const [exists, setExists] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!desktop || !filePath) {
      setExists(null);
      return;
    }
    const status = await pathStatus(filePath);
    setExists(status.ok ? !!status.exists : false);
    if (!status.ok && status.error) setMessage(status.error);
  }, [desktop, filePath]);

  useEffect(() => {
    setMessage("");
    void refresh();
  }, [refresh, track.id, filePath]);

  const relocate = async () => {
    if (!desktop) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await pickAudioFile();
      if (!next) return;
      const outcome = await relocateTrackFile(track, next, readFile);
      if (outcome.ok) {
        setMessage(`Path updated to ${outcome.filePath}`);
        setExists(true);
      } else {
        setMessage(outcome.error);
      }
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  if (!desktop) {
    return (
      <div className="export-panel">
        <h3>Source file</h3>
        <p className="muted">Path checks and relocate need the desktop app.</p>
      </div>
    );
  }

  return (
    <div className="export-panel">
      <h3>Source file</h3>
      {!filePath && (
        <p className="muted">
          No absolute path is stored for this track (drag-and-drop import).
          Use Relocate to attach a file on disk, or Import folder next time.
        </p>
      )}
      {filePath && (
        <p className={exists === false ? "conf red" : "muted"}>
          {exists === false ? "Missing: " : exists === true ? "Found: " : "Path: "}
          <code>{filePath}</code>
        </p>
      )}
      <div className="ge-row">
        <button disabled={busy || !filePath} onClick={() => void refresh()}>
          Check path
        </button>
        <button disabled={busy} onClick={() => void relocate()}>
          Relocate…
        </button>
      </div>
      {message && <p role="status" className="muted">{message}</p>}
    </div>
  );
}
