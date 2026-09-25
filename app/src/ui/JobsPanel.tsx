import { liveQuery } from "dexie";
import { db, type AnalysisJob } from "../db/library";
import { useEffect, useMemo, useState } from "react";
import { displayName } from "../metadata/tags";
interface Props {
  jobs: AnalysisJob[];
  onCancel: (id: string) => void; onRetry: (id: string) => void;
}
export function JobsPanel({ jobs, onCancel, onRetry }: Props) {
  const [names, setNames] = useState(new Map<string, string>());
  const ordered = useMemo(() => [...jobs].sort((a, b) => (b.updatedAt ?? b.queuedAt) - (a.updatedAt ?? a.queuedAt)), [jobs]);
  useEffect(() => {
    const subscription = liveQuery(() => db.trackCatalog.bulkGet(ordered.slice(0, 50).map(job => job.trackId ?? job.id)))
      .subscribe(rows => setNames(new Map(rows.filter(row => !!row).map(row => [row.id, displayName(row.tags, row.name)]))));
    return () => subscription.unsubscribe();
  }, [ordered]);
  return <details className="grid-editor"><summary>Background jobs ({jobs.length})</summary>
    <p className="muted">Interrupted work recovers automatically. Worker crashes and timeouts retry up to the attempt limit; invalid audio needs manual attention.</p>
    {ordered.slice(0, 50).map(job => <div className="ge-row" key={job.id}>
      <strong>{names.get(job.trackId ?? job.id) ?? "Removed track"}</strong>
      <span>{job.phase ?? "analysis"}: {job.status} - {job.stage ?? job.status} {job.phase !== "stems" && `${Math.round((job.progress ?? 0) * 100)}%`}</span>
      <span>Attempt {job.attempts}/{job.maxAttempts ?? 3}</span>
      {job.error && <span className="error">{job.error}</span>}
      {job.status === "queued" || job.status === "running" ?
        <button onClick={() => onCancel(job.id)}>Cancel</button> :
        <button disabled={job.remoteCancelPending} onClick={() => onRetry(job.id)}>{job.remoteCancelPending ? "Waiting for service cancellation" : job.status === "done" ? "Run again" : "Retry"}</button>}
    </div>)}
    {jobs.length > 50 && <p className="muted">Showing the 50 most recently updated jobs.</p>}
  </details>;
}
