import { useEffect, useMemo, useState } from "react";
import { liveQuery } from "dexie";
import { db, type StoredTrack } from "../db/library";
import { CatalogRepository, indexCatalogBatch, type CatalogPage, type CatalogTrack } from "../db/catalog";

const repository = new CatalogRepository(db);
export function useCatalog(query: string, filter: string, sort: string, page: number, needAll: boolean, onError: (message: string) => void) {
  const [result, setResult] = useState<CatalogPage>({ tracks: [], total: 0, offset: 0 });
  const request = JSON.stringify([query, filter, sort, page]);
  const [loadedRequest, setLoadedRequest] = useState("");
  const [all, setAll] = useState<CatalogTrack[]>([]);
  const [stats, setStats] = useState({ total: 0, indexed: 0, stale: 0, complete: false });
  useEffect(() => {
    let alive = true;
    void (async () => {
      while (alive && !(await indexCatalogBatch(db))) await new Promise(resolve => setTimeout(resolve, 0));
    })().catch(error => { if (alive) onError(`Library indexing failed: ${String(error)}`); });
    const subscription = liveQuery(async () => ({ total: await db.tracks.count(), indexed: await db.catalogKeys.count(),
      stale: await db.catalogKeys.where("stale").equals(1).count(), complete: (await db.catalogState.get("tracks"))?.complete ?? false,
    })).subscribe({ next: setStats, error: error => onError(String(error)) });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [onError]);
  useEffect(() => {
    const subscription = liveQuery(() => repository.page(query, filter, sort, page * 100))
      .subscribe({ next: rows => { setResult(rows); setLoadedRequest(request); }, error: error => onError(String(error)) });
    return () => subscription.unsubscribe();
  }, [query, filter, sort, page, onError, request]);
  useEffect(() => {
    if (!needAll) { setAll([]); return; }
    const subscription = liveQuery(() => db.trackCatalog.toArray())
      .subscribe({ next: setAll, error: error => onError(String(error)) });
    return () => subscription.unsubscribe();
  }, [needAll, onError]);
  return { result, all, stats, loading: loadedRequest !== request };
}

export function useTrackDetail(id: string | null, onError: (message: string) => void): StoredTrack | null {
  const [track, setTrack] = useState<StoredTrack | null>(null);
  useEffect(() => {
    if (!id) { setTrack(null); return; }
    const subscription = liveQuery(() => db.tracks.get(id)).subscribe({ next: row => setTrack(row ?? null), error: error => onError(String(error)) });
    return () => subscription.unsubscribe();
  }, [id, onError]);
  return useMemo(() => track?.id === id ? track : null, [track, id]);
}
