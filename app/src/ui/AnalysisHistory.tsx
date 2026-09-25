import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { db, type AnalysisSnapshot } from "../db/library";
export function AnalysisHistory({ trackId }: { trackId: string }) {
  const [history, setHistory] = useState<AnalysisSnapshot[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setHistory([]); setError("");
    const subscription = liveQuery(() => db.analysisHistory.where("trackId").equals(trackId).toArray())
      .subscribe({ next: setHistory, error: error => setError(String(error)) });
    return () => subscription.unsubscribe();
  }, [trackId]);
  return <details className="grid-editor"><summary>Analysis history ({history.length})</summary>
    <p className="muted">Previous automatic results remain traceable. Manual corrections and cues are stored separately and remain authoritative.</p>
    {error && <p className="error">{error}</p>}
    {[...history].sort((a, b) => b.savedAt - a.savedAt).map(snapshot => <details key={snapshot.id}>
      <summary>{new Date(snapshot.savedAt).toLocaleString()} - analysis v{snapshot.result.analysisVersion} - {snapshot.result.tempo.bpm.toFixed(2)} BPM</summary>
      {snapshot.result.provenance ? <table><thead><tr><th>Analyzer</th><th>Version</th><th>Parameters</th><th>Confidence</th></tr></thead><tbody>
        {Object.values(snapshot.result.provenance).map(run => run && <tr key={run.id}><td>{run.id}</td><td>{run.version}</td><td>{run.paramsHash}</td><td>{run.confidence === null ? "Not estimated" : `${Math.round(run.confidence * 100)}%`}</td></tr>)}
      </tbody></table> : <p className="muted">Legacy result: individual analyzer versions were not recorded.</p>}
    </details>)}
  </details>;
}
