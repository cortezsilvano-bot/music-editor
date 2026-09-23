/**
 * Tag writing (research Phase G).
 *
 * Shows every proposed change with the value it would replace, lets the user
 * tick fields individually, and refuses low-confidence values unless they
 * explicitly override. Nothing is written until "Write tags" is pressed.
 *
 * Desktop only: a browser cannot modify the user's files. On the web the panel
 * explains that instead of offering a button that cannot work.
 */
import { useEffect, useMemo, useState } from "react";
import type { StoredTrack } from "../db/library";
import { isDesktop, writeTags, type TagWriteResult } from "../desktop/bridge";
import {
  buildWritePlan,
  toWritePayload,
  type TagField,
} from "../metadata/writePlan";

interface Props {
  track: StoredTrack;
  /** Absolute path on disk; only present for folder-imported tracks. */
  filePath: string | null;
}

export function TagWritePanel({ track, filePath }: Props) {
  const [includeCamelot, setIncludeCamelot] = useState(false);
  const [includeComment, setIncludeComment] = useState(false);
  const [override, setOverride] = useState(false);
  const [selected, setSelected] = useState<Set<TagField>>(new Set());
  const [result, setResult] = useState<TagWriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(
    () =>
      buildWritePlan(track, {
        includeCamelot,
        includeComment,
        overrideLowConfidence: override,
      }),
    [track, includeCamelot, includeComment, override],
  );

  // Re-seed the ticks from the plan's own defaults whenever it changes, so a
  // newly blocked field cannot stay ticked from a previous state.
  useEffect(() => {
    setSelected(new Set(plan.changes.filter((c) => c.selected).map((c) => c.field)));
    setResult(null);
  }, [plan]);

  const desktop = isDesktop();
  const writable = plan.changes.filter((c) => c.blocked === null);
  const canWrite = desktop && filePath !== null && plan.supported && selected.size > 0 && !busy;

  const toggle = (field: TagField) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const run = async () => {
    if (!filePath) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await writeTags(filePath, toWritePayload(plan, selected)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-panel">
      <h3>Write tags to file</h3>

      {!desktop && (
        <p className="muted">
          Only the desktop app can write tags. A browser cannot modify files on
          your disk.
        </p>
      )}

      {desktop && filePath === null && (
        <p className="muted">
          This track was added by drag-and-drop, so its path on disk is unknown.
          Import the folder instead to enable tag writing.
        </p>
      )}

      {!plan.supported && <p className="conf red">{plan.unsupportedReason}</p>}

      {plan.supported && plan.changes.length === 0 && (
        <p className="muted">Nothing to write - the file already matches the analysis.</p>
      )}

      {plan.supported && plan.changes.length > 0 && (
        <table className="changes">
          <thead>
            <tr>
              <th />
              <th>Field</th>
              <th>Current</th>
              <th>New</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((change) => (
              <tr key={change.field} className={change.blocked ? "blocked" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    disabled={change.blocked !== null}
                    checked={selected.has(change.field)}
                    onChange={() => toggle(change.field)}
                  />
                </td>
                <td>{change.label}</td>
                <td className="muted">{change.current ?? "—"}</td>
                <td className="value">{change.proposed}</td>
                <td>
                  {change.source === "manual" && <span className="conf amber">manual</span>}
                  {change.blocked && <span className="conf red">{change.blocked}</span>}
                  {change.warning && <span className="conf amber">{change.warning}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ge-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeCamelot}
            onChange={(e) => setIncludeCamelot(e.target.checked)}
          />
          Camelot in comment
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeComment}
            onChange={(e) => setIncludeComment(e.target.checked)}
          />
          Analysis summary
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Allow low confidence
        </label>
      </div>

      <div className="ge-row">
        <button className="ghost small" disabled={!canWrite} onClick={() => void run()}>
          {busy ? "Writing…" : `Write ${selected.size} field${selected.size === 1 ? "" : "s"}`}
        </button>
        <span className="muted">
          {writable.length} of {plan.changes.length} writable
        </span>
      </div>

      {result && (
        <p className={result.ok ? "muted" : "conf red"}>
          {result.ok
            ? `Wrote ${result.written?.join(", ")}. ${
                result.backupCreated
                  ? "Original backed up to .music-editor-backups."
                  : "Existing backup kept."
              }`
            : result.error}
        </p>
      )}
    </div>
  );
}
