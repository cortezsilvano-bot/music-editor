/**
 * Batch missing-file scan and relocate-across-folder.
 *
 * Scans catalog rows that store an absolute filePath, checks pathStatus, lists
 * missing paths, then maps a picked folder onto them by relativePath (preferred)
 * or unique basename. Each apply still runs relocateTrackFile (hash gate).
 */
import { useCallback, useMemo, useState } from "react";
import { liveQuery } from "dexie";
import { useEffect } from "react";
import { db, type StoredTrack } from "../db/library";
import {
  isDesktop,
  pathStatus,
  pickFolder,
  readFile,
  scanFolder,
} from "../desktop/bridge";
import { proposeRelocateMatches, type MissingTrackRef } from "../desktop/batchRelocate";
import { relocateTrackFile } from "../desktop/relocate";

interface MissingRow {
  id: string;
  name: string;
  filePath: string;
  relativePath?: string;
  contentHash?: string;
}

export function MissingFilesPanel() {
  const desktop = isDesktop();
  const [withPath, setWithPath] = useState<MissingRow[]>([]);
  const [missing, setMissing] = useState<MissingRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const sub = liveQuery(async () => {
      const rows = await db.tracks
        .filter((t) => typeof t.filePath === "string" && t.filePath.length > 0)
        .toArray();
      return rows.map((t: StoredTrack) => ({
        id: t.id,
        name: t.name,
        filePath: t.filePath!,
        relativePath: t.relativePath,
        contentHash: t.contentHash,
      }));
    }).subscribe({
      next: (rows) => setWithPath(rows ?? []),
      error: (reason) => setMessage(String(reason)),
    });
    return () => sub.unsubscribe();
  }, []);

  const pathCount = withPath.length;

  const scanMissing = useCallback(async () => {
    if (!desktop) return;
    setScanning(true);
    setMessage("");
    try {
      const found: MissingRow[] = [];
      // Bound concurrency lightly so a large library does not open thousands of IPC calls at once.
      const chunk = 32;
      for (let i = 0; i < withPath.length; i += chunk) {
        const slice = withPath.slice(i, i + chunk);
        const statuses = await Promise.all(slice.map((row) => pathStatus(row.filePath)));
        slice.forEach((row, index) => {
          const status = statuses[index];
          if (!status.ok || !status.exists) found.push(row);
        });
      }
      setMissing(found);
      setMessage(
        found.length
          ? `Found ${found.length} missing path${found.length === 1 ? "" : "s"} of ${withPath.length} with a stored path.`
          : `All ${withPath.length} stored paths exist.`,
      );
    } finally {
      setScanning(false);
    }
  }, [desktop, withPath]);

  const relocateFolder = useCallback(async () => {
    if (!desktop || missing.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      const folder = await pickFolder();
      if (!folder) return;
      const scanned = await scanFolder(folder);
      if (!scanned.ok) {
        setMessage(scanned.error);
        return;
      }
      const refs: MissingTrackRef[] = missing.map((m) => ({
        id: m.id,
        filePath: m.filePath,
        relativePath: m.relativePath,
        name: m.name,
      }));
      const proposal = proposeRelocateMatches(
        refs,
        scanned.files.map((f) => ({
          path: f.path,
          relativePath: f.relativePath,
          name: f.name,
        })),
      );

      let okCount = 0;
      let hashFail = 0;
      let otherFail = 0;
      for (const match of proposal.matches) {
        const track = await db.tracks.get(match.trackId);
        if (!track) {
          otherFail++;
          continue;
        }
        const outcome = await relocateTrackFile(track, match.newPath, readFile);
        if (outcome.ok) okCount++;
        else if (outcome.reason === "hash_mismatch") hashFail++;
        else otherFail++;
      }

      const parts = [
        `Relocated ${okCount}/${proposal.matches.length} proposed match${proposal.matches.length === 1 ? "" : "es"}.`,
      ];
      if (proposal.ambiguous.length)
        parts.push(`Skipped ${proposal.ambiguous.length} ambiguous.`);
      if (proposal.unmatched.length)
        parts.push(`${proposal.unmatched.length} unmatched.`);
      if (hashFail) parts.push(`${hashFail} hash mismatch (refused).`);
      if (otherFail) parts.push(`${otherFail} other failures.`);
      parts.push("Default: relativePath when unique, else unique basename; hash must match.");
      setMessage(parts.join(" "));
      await scanMissing();
    } finally {
      setBusy(false);
    }
  }, [desktop, missing, scanMissing]);

  const list = useMemo(() => missing.slice(0, 50), [missing]);

  if (!desktop) {
    return (
      <div className="export-panel">
        <h3>Missing files</h3>
        <p className="muted">Batch path checks need the desktop app.</p>
      </div>
    );
  }

  return (
    <div className="export-panel">
      <h3>Missing files</h3>
      <p className="muted">
        Scan stored absolute paths, then Relocate folder maps unique relativePath
        or basename onto missing rows. Hash mismatches are refused.
      </p>
      <div className="ge-row">
        <button disabled={scanning || pathCount === 0} onClick={() => void scanMissing()}>
          {scanning ? "Scanning…" : `Scan library paths (${pathCount})`}
        </button>
        <button
          disabled={busy || missing.length === 0}
          onClick={() => void relocateFolder()}
        >
          {busy ? "Relocating…" : "Relocate folder…"}
        </button>
      </div>
      {missing.length > 0 && (
        <ul className="muted" style={{ maxHeight: 160, overflow: "auto", paddingLeft: 18 }}>
          {list.map((row) => (
            <li key={row.id}>
              <code>{row.filePath}</code>
            </li>
          ))}
          {missing.length > list.length && (
            <li>…and {missing.length - list.length} more</li>
          )}
        </ul>
      )}
      {message && (
        <p role="status" className="muted">
          {message}
        </p>
      )}
    </div>
  );
}
