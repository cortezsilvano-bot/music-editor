/**
 * Duplicate review (research Phase N).
 *
 * Proposes groups and ranks the copies; it never deletes anything. Removal is
 * one explicit click per track, and the suggested keeper is only a suggestion -
 * the comparison table is there so the decision is the user's.
 */
import { useCallback, useMemo, useState } from "react";
import {
  findDuplicateGroups,
  planMerge,
  rankCopies,
  type DuplicateGroup,
  type MergeableEdits,
  type QualityFacts,
} from "../analysis/fingerprint";
import { applyMerge, effectiveBpm, removeTrack, type StoredTrack } from "../db/library";
import type { BeatGrid } from "../dsp/beats";
import { displayName } from "../metadata/tags";

interface Props {
  tracks: StoredTrack[];
  onChanged: () => void;
}

const LEVEL_LABEL: Record<DuplicateGroup["level"], string> = {
  "exact-file": "Identical files",
  "same-audio": "Same audio, different file",
  "similar-audio": "Likely same recording",
};

function manualEditCount(track: StoredTrack): number {
  let count = 0;
  if (track.manualBpm !== null) count++;
  if (track.manualGrid) count++;
  if (track.manualKeyTonic !== null) count++;
  if ((track.cues?.length ?? 0) > 0) count++;
  return count;
}

function toFacts(track: StoredTrack): QualityFacts {
  return {
    id: track.id,
    bitrateKbps: track.tags.bitrateKbps,
    sampleRate: track.tags.sampleRate,
    sizeBytes: track.sizeBytes,
    lossless: track.tags.lossless,
    hasAnalysis: track.analysis !== null,
    manualEdits: manualEditCount(track),
  };
}

function toEdits(track: StoredTrack): MergeableEdits {
  return {
    manualBpm: track.manualBpm,
    manualKeyTonic: track.manualKeyTonic,
    manualKeyMode: track.manualKeyMode,
    manualGrid: track.manualGrid ?? null,
    cues: track.cues ?? [],
    reviewedAt: track.reviewedAt,
  };
}

function formatSize(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}

/** One-line description of what a merge would actually move. */
function mergeSummary(keeper: StoredTrack, donor: StoredTrack): string {
  const plan = planMerge(toEdits(keeper), toEdits(donor));
  const parts = [...plan.fields];
  if (plan.cues.length > 0) parts.push(`${plan.cues.length} cue(s)`);
  return parts.length > 0 ? `Moves ${parts.join(", ")} onto the keeper` : "";
}

export function DuplicatesPanel({ tracks, onChanged }: Props) {
  const [scanned, setScanned] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);

  const groups = useMemo(() => {
    if (!scanned) return [];
    return findDuplicateGroups(
      tracks.map((t) => ({
        id: t.id,
        contentHash: t.contentHash,
        audioHash: t.audioHash,
        fingerprint: t.fingerprint ? new Uint32Array(t.fingerprint) : undefined,
      })),
    );
  }, [tracks, scanned]);

  /**
   * Move the donor's hand-made work onto the keeper before removing it.
   *
   * Without this, removing the wrong copy quietly destroys grid corrections and
   * cue points, which is the most expensive thing in the library to redo.
   */
  const mergeAndRemove = useCallback(
    async (keeper: StoredTrack, donor: StoredTrack) => {
      setBusyId(donor.id);
      try {
        const plan = planMerge(toEdits(keeper), toEdits(donor));
        if (plan.fields.length > 0 || plan.cues.length > 0) {
          await applyMerge(keeper.id, {
            ...plan.result,
            manualGrid: (plan.result.manualGrid as BeatGrid | null) ?? null,
          });
        }
        await removeTrack(donor.id);
        onChanged();
      } finally {
        setBusyId(null);
      }
    },
    [onChanged],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await removeTrack(id);
        onChanged();
      } finally {
        setBusyId(null);
      }
    },
    [onChanged],
  );

  const withFingerprints = tracks.filter((t) => t.fingerprint).length;

  return (
    <div className="export-panel">
      <h3>Duplicates</h3>

      <div className="ge-row">
        <button className="ghost small" onClick={() => setScanned(true)}>
          Scan {tracks.length} tracks
        </button>
        <span className="muted">
          {withFingerprints} of {tracks.length} fingerprinted
          {withFingerprints < tracks.length && " — re-analyse the rest to catch re-encodes"}
        </span>
      </div>

      {scanned && groups.length === 0 && <p className="muted">No duplicates found.</p>}

      {groups.map((group, index) => {
        const members = group.members
          .map((m) => byId.get(m.id))
          .filter((t): t is StoredTrack => t !== undefined);
        if (members.length < 2) return null;
        const ranked = rankCopies(members.map(toFacts));
        const keeperId = ranked[0]?.id;
        const keeper = members.find((m) => m.id === keeperId);

        return (
          <div key={index} className="dup-group">
            <div className="ge-row">
              <span className="conf amber">{LEVEL_LABEL[group.level]}</span>
              <span className="muted">
                {group.level === "similar-audio" &&
                  `${(Math.min(...group.members.map((m) => m.confidence)) * 100).toFixed(0)}% match`}
              </span>
            </div>

            <table className="changes">
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Format</th>
                  <th>Size</th>
                  <th>BPM</th>
                  <th>Edits</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((track) => (
                  <tr key={track.id}>
                    <td>
                      {displayName(track.tags, track.name)}
                      {track.id === keeperId && <span className="conf good"> keep</span>}
                    </td>
                    <td className="muted">
                      {[
                        track.tags.codec,
                        track.tags.lossless ? "lossless" : null,
                        track.tags.bitrateKbps ? `${track.tags.bitrateKbps} kbps` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "unknown"}
                    </td>
                    <td className="muted">{formatSize(track.sizeBytes)}</td>
                    <td className="muted">{effectiveBpm(track)?.toFixed(1) ?? "—"}</td>
                    <td className="muted">{manualEditCount(track) || "—"}</td>
                    <td>
                      {track.id !== keeperId && keeper && (
                        <button
                          className="ghost small"
                          disabled={busyId === track.id}
                          title={
                            mergeSummary(keeper, track) ||
                            "Nothing to merge; this copy has no edits the keeper lacks"
                          }
                          onClick={() => void mergeAndRemove(keeper, track)}
                        >
                          Merge → keeper
                        </button>
                      )}
                      <button
                        className="ghost small"
                        disabled={busyId === track.id}
                        onClick={() => void remove(track.id)}
                      >
                        {busyId === track.id ? "Removing…" : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {scanned && groups.length > 0 && (
        <p className="muted">
          Nothing is deleted automatically. "Remove" takes the track out of this
          library only; the file on disk is untouched.
        </p>
      )}
    </div>
  );
}
