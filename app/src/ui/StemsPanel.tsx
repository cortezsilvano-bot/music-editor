import { useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { db, type AnalysisJob, type StoredTrack } from "../db/library";
import { allCached, cacheSize, DEFAULT_CACHE_LIMIT_BYTES, removeCached, setPinned, type CachedStem, type StemCacheEntry } from "../db/stems";
import { checkService, stemColour, type ServiceStatus } from "../stems/service";
import {
  isDesktop,
  pickStemsServerRoot,
  startStemsService,
  stemsServiceStatus,
  stopStemsService,
  type StemsServiceStatus,
} from "../desktop/bridge";
interface Props {
  track: StoredTrack;
  onQueue: (options: NonNullable<AnalysisJob["stemOptions"]>) => Promise<void>;
  onCancel: () => Promise<void>;
}
function bytes(value: number) { return `${(value / 1024 ** 2).toFixed(1)} MB`; }

function StemPreview({ stem, solo, onSolo, mutedBySolo }: {
  stem: CachedStem; solo: boolean; onSolo: () => void; mutedBySolo: boolean;
}) {
  const [url, setUrl] = useState("");
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const next = URL.createObjectURL(stem.blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [stem.blob]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  return <tr><td><span className="stem-dot" style={{ background: stemColour(stem.type) }} />{stem.type}</td>
    <td>{bytes(stem.blob.size)}</td><td><audio ref={audio} controls preload="none" src={url} muted={muted || mutedBySolo} /></td>
    <td><button aria-pressed={muted} onClick={() => setMuted(!muted)}>Mute {stem.type}</button>
      <button aria-pressed={solo} onClick={onSolo}>Solo {stem.type}</button>
      <input type="range" aria-label={`${stem.type} volume`} min="0" max="1" step="0.01" value={volume} onChange={event => setVolume(Number(event.target.value))} />
      <a href={url} download={stem.name}>Save</a></td></tr>;
}

/** Durable queue state is independent of panel selection and service availability. */
export function StemsPanel({ track, onQueue, onCancel }: Props) {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [managed, setManaged] = useState(false);
  const [layout, setLayout] = useState<Pick<StemsServiceStatus, "serverRoot" | "serverPresent" | "python">>({});
  const [entries, setEntries] = useState<StemCacheEntry[]>([]);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [job, setJob] = useState<AnalysisJob>();
  const [quality, setQuality] = useState<"balanced" | "high">("balanced");
  const [error, setError] = useState("");
  const [solo, setSolo] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [usage, setUsage] = useState({ bytes: 0, entries: 0, pinned: 0 });
  const [serviceBusy, setServiceBusy] = useState(false);
  const running = job?.status === "running" || job?.status === "queued";
  const entry = entries.find(row => row.id === entryId) ?? entries[0];
  const desktop = isDesktop();

  function applyManaged(managedStatus: StemsServiceStatus) {
    setManaged(!!managedStatus.managed);
    setLayout({
      serverRoot: managedStatus.serverRoot ?? null,
      serverPresent: managedStatus.serverPresent,
      python: managedStatus.python ?? null,
    });
  }

  async function refreshStatus() {
    const http = await checkService();
    setStatus(http);
    if (desktop && typeof window.desktop?.stemsServiceStatus === "function") {
      const managedStatus = await stemsServiceStatus();
      applyManaged(managedStatus);
    } else {
      setManaged(false);
      setLayout({});
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      const http = await checkService();
      if (!alive) return;
      setStatus(http);
      if (isDesktop() && typeof window.desktop?.stemsServiceStatus === "function") {
        const managedStatus = await stemsServiceStatus();
        if (alive) applyManaged(managedStatus);
      }
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    setEntries([]); setEntryId(null); setError(""); setSolo(null); setJob(undefined);
    const subscription = liveQuery(async () => ({
      entries: track.audioHash ? await db.stemCache.where("audioHash").equals(track.audioHash).toArray() : await db.stemCache.where("trackId").equals(track.id).toArray(),
      job: await db.jobs.get(`stems:${track.id}`),
    })).subscribe({ next: value => { setEntries(value.entries.filter(row => !row.sourceHash || !track.contentHash || row.sourceHash === track.contentHash)
      .sort((a, b) => b.createdAt - a.createdAt)); setJob(value.job); }, error: value => setError(String(value)) });
    return () => subscription.unsubscribe();
  }, [track.id, track.audioHash, track.contentHash]);
  useEffect(() => { const subscription = liveQuery(cacheSize).subscribe({ next: setUsage, error: value => setError(String(value)) }); return () => subscription.unsubscribe(); }, []);
  useEffect(() => {
    if (!running) return;
    const started = job?.startedAt ?? job?.queuedAt ?? Date.now();
    const timer = setInterval(() => setElapsed(Math.max(0, Date.now() - started) / 1000), 500);
    return () => clearInterval(timer);
  }, [running, job?.startedAt, job?.queuedAt]);
  async function perform(action: () => Promise<unknown>) { setError(""); try { await action(); } catch (value) { setError(String(value)); } }

  async function startService() {
    setServiceBusy(true); setError("");
    try {
      const result = await startStemsService();
      if (result.ok === false) setError(result.error || "Could not start the stem service.");
      else if (result.serverPresent === false) {
        setError(result.error || "Stem server folder is missing.");
      }
      await refreshStatus();
    } finally { setServiceBusy(false); }
  }

  async function stopService() {
    setServiceBusy(true); setError("");
    try {
      await stopStemsService();
      await refreshStatus();
    } finally { setServiceBusy(false); }
  }

  async function chooseServerFolder() {
    setServiceBusy(true); setError("");
    try {
      const result = await pickStemsServerRoot();
      if (result.cancelled) return;
      if (result.ok === false) setError(result.error || "Could not set the server folder.");
      await refreshStatus();
    } finally { setServiceBusy(false); }
  }

  const missingServer = desktop && layout.serverPresent === false;

  return <div className="export-panel"><h3>Stems</h3>
    {!status && <p className="muted">Checking separation service...</p>}
    {status && (!status.reachable || status.jobProtocol !== 2) && <p className="conf amber">
      {status.reachable ? "Restart the updated separation service to enable durable jobs." : status.error}
      <button onClick={() => void perform(refreshStatus)}>Check again</button></p>}
    {desktop && (
      <div className="ge-row">
        <span className="muted">
          Service: {status?.reachable ? "reachable" : "offline"}
          {managed ? " (started by app)" : status?.reachable ? " (external)" : ""}
        </span>
        <button disabled={serviceBusy || !!status?.reachable} onClick={() => void startService()}>Start service</button>
        <button disabled={serviceBusy || !managed} onClick={() => void stopService()}>Stop service</button>
        <button disabled={serviceBusy} onClick={() => void chooseServerFolder()}>Choose server folder…</button>
      </div>
    )}
    {desktop && (
      <p className="muted">
        Server: {layout.serverRoot ?? "(resolving…)"}
        {layout.serverPresent === false ? " — missing app.py" : layout.serverPresent ? "" : ""}
        {layout.python ? ` · Python: ${layout.python}` : ""}
      </p>
    )}
    {missingServer && (
      <p role="alert" className="conf red">
        Stem server source not found. Packaged installs include resources/server
        (no venv / no Demucs weights). Install system Python, then
        `pip install -r requirements.txt` in that folder, or choose a checkout
        server/ folder. Env: MUSIC_EDITOR_SERVER_ROOT.
      </p>
    )}
    <p className="muted">The app never auto-starts the Python service. Start here, or run `server/run.ps1` yourself. Demucs weights are not bundled.</p>
    <div className="ge-row"><span>Engine: {status?.backend === "demucs" ? `Demucs (${status.model})` : "DSP fallback"}</span>
      <label><input type="checkbox" checked={quality === "high"} disabled={running} onChange={event => setQuality(event.target.checked ? "high" : "balanced")} />Higher quality</label>
      <button disabled={running || job?.remoteCancelPending || !track.audioHash || !status?.reachable || status.jobProtocol !== 2}
        onClick={() => void perform(() => onQueue({ backend: status!.backend ?? "dsp", quality, stems: "basic" }))}>{entry ? "Separate again" : "Separate"}</button>
      {running && <><span>{job?.stage ?? job?.status} ({elapsed.toFixed(0)}s)</span><button onClick={() => void perform(onCancel)}>Cancel separation</button></>}
    </div>
    <p className="muted">Work continues when you select another track. Reopening the app reconnects to the same server job. Stages are shown without an estimated percentage.</p>
    {job?.remoteCancelPending && <p className="conf amber">Cancellation saved. Waiting for the service to acknowledge it.</p>}
    {(error || job?.error) && <p role="alert" className="conf red">{error || job?.error}</p>}
    {entries.length > 1 && <label>Cached result <select value={entry?.id ?? ""} onChange={event => { setEntryId(event.target.value); setSolo(null); }}>
      {entries.map(row => <option key={row.id} value={row.id}>{row.model} {row.quality ?? "legacy"} - {new Date(row.createdAt).toLocaleString()}</option>)}
    </select></label>}
    {entry && <><p className="muted">Cached {bytes(entry.sizeBytes)} - {entry.model} {entry.modelVersion ?? "legacy version"} - {entry.device ?? "device not recorded"}</p>
      {entry.fallbackReason && <p className="conf amber">CPU fallback: {entry.fallbackReason}</p>}
      <table className="changes"><tbody>{entry.stems.map(stem => <StemPreview key={`${entry.id}:${stem.name}`} stem={stem} solo={solo === stem.name}
        mutedBySolo={solo !== null && solo !== stem.name} onSolo={() => setSolo(solo === stem.name ? null : stem.name)} />)}</tbody></table>
      <div className="ge-row"><label><input type="checkbox" checked={entry.pinned} onChange={event => void perform(() => setPinned(entry.id, event.target.checked))} />Keep (never evict)</label>
        <button onClick={() => void perform(() => removeCached(entry.id))}>Delete stems</button></div></>}
    <p className="muted">Cache: {bytes(usage.bytes)} / {bytes(DEFAULT_CACHE_LIMIT_BYTES)}; {usage.entries} results, {usage.pinned} kept.
      <button onClick={() => void perform(async () => { for (const row of await allCached()) if (!row.pinned) await removeCached(row.id); })}>Clear unkept</button></p>
  </div>;
}
