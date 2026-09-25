import Dexie from "dexie";
import { LibraryDatabase, type StoredTrack } from "../src/db/library";
import { CatalogRepository, indexCatalogBatch } from "../src/db/catalog";
import { EMPTY_TAGS } from "../src/metadata/tags";
import { analyze } from "../src/analysis/pipeline";

export async function runCatalogBenchmark(sizes?: number[]) {
  const benchSizes = sizes?.length ? sizes : [10_000, 50_000, 100_000];
  const report: unknown[] = [];
  const analysis = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
  const audio = new Blob([new Uint8Array(44)], { type: "audio/wav" });
  const rounded = (n: number) => Math.round(n * 100) / 100;
  for (const size of benchSizes) {
    const name = `music-editor-catalog-benchmark-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(12).stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
      jobs: "id, status, priority, queuedAt, leaseUntil, nextAttemptAt, trackId, phase", jobEvents: "++id, jobId, runId, at",
      analysisHistory: "id, trackId, savedAt", feedback: "id, fromTrackId, toTrackId, action, at", stemCache: "id, audioHash, trackId, lastUsedAt, pinned" });
    let database: LibraryDatabase | undefined;
    try {
      const seedAt = performance.now();
      for (let seeded = 0; seeded < size; seeded += 500) {
        const rows: StoredTrack[] = [];
        for (let n = seeded; n < Math.min(seeded + 500, size); n++) rows.push({
          id: `track-${n.toString().padStart(6, "0")}`, name: `Recording ${n}.wav`, audio, mimeType: "audio/wav", sizeBytes: 8_000_000,
          durationSec: 180 + n % 240, addedAt: n, peaks: new Float32Array(2000).buffer,
          tags: { ...EMPTY_TAGS, title: `Title ${n}`, artist: `Artist ${n % 400}`, album: `Album ${n % 2000}` },
          analysis: { ...analysis, tempo: { ...analysis.tempo, bpm: 80 + n % 100 } }, analysisVersion: analysis.analysisVersion,
          analysisError: null, manualBpm: null, manualKeyTonic: null, manualKeyMode: null, manualGrid: null, reviewedAt: n % 4 ? null : n,
        });
        await legacy.table("tracks").bulkAdd(rows);
      }
      const seedMs = performance.now() - seedAt;
      legacy.close(); database = new LibraryDatabase(name);
      const indexAt = performance.now();
      let batches = 0;
      while (!(await indexCatalogBatch(database))) { batches++; if (batches % 100 === 0) console.log(`CATALOG_PROGRESS ${size}: ${batches * 100} indexed`); }
      const backfillMs = performance.now() - indexAt;
      database.close(); database = new LibraryDatabase(name);
      let fullTrackReads = 0;
      database.use({ stack: "dbcore", name: "count-full-reads", level: 20, create: down => ({ ...down, table(tableName) {
        const table = down.table(tableName);
        return tableName !== "tracks" ? table : { ...table,
          get: req => { fullTrackReads++; return table.get(req); },
          getMany: req => { fullTrackReads += req.keys.length; return table.getMany(req); },
          query: req => { fullTrackReads++; return table.query(req); },
        };
      } }) });
      const repository = new CatalogRepository(database);
      const firstAt = performance.now(); const first = await repository.page(); const firstPageMs = performance.now() - firstAt;
      const nextAt = performance.now(); await repository.page("", "all", "added", 100); const nextPageMs = performance.now() - nextAt;
      const coldSearchAt = performance.now(); await repository.page("artist 17", "all", "name"); const coldSearchMs = performance.now() - coldSearchAt;
      const measure = async (fn: () => Promise<unknown>) => {
        const samples: number[] = [];
        for (let i = 0; i < 7; i++) { const at = performance.now(); await fn(); samples.push(performance.now() - at); }
        samples.sort((a, b) => a - b); return { medianMs: rounded(samples[3]), p95Ms: rounded(samples[6]) };
      };
      const search = await measure(() => repository.page("artist 17", "all", "name"));
      const review = await measure(() => repository.page("", "review", "name"));
      const namePage = await measure(() => repository.page("", "all", "name"));
      const bpmPage = await measure(() => repository.page("", "all", "bpm"));
      const deepAt = performance.now(); await repository.page("", "all", "added", size - 100); const lastPageMs = performance.now() - deepAt;
      const queryFullTrackReads = fullTrackReads;
      const detailAt = performance.now(); await database.tracks.get(first.tracks[0].id); const selectedDetailMs = performance.now() - detailAt;
      const result = { count: size, seedMs: rounded(seedMs), oneTimeBackfillMs: rounded(backfillMs), firstPageMs: rounded(firstPageMs),
        nextPageMs: rounded(nextPageMs), coldSearchMs: rounded(coldSearchMs), search, review, namePage, bpmPage, lastPageMs: rounded(lastPageMs),
        queryFullTrackReads, selectedDetailMs: rounded(selectedDetailMs), selectedDetailReads: fullTrackReads - queryFullTrackReads,
        pageRows: first.tracks.length, firstPageJsonBytes: new Blob([JSON.stringify(first.tracks)]).size,
        limits: "Real Chromium IndexedDB with synthetic analysis, 2000-float peaks and 44-byte placeholder audio. First page includes reopened DB startup. Cold search reads compact keys once. Seven warm samples; p95 is the maximum. No real-media decode, DOM paint, physical audio devices or disk-cold OS cache measurement." };
      report.push(result); console.log("CATALOG_BENCHMARK " + JSON.stringify(result));
    } finally { legacy.close(); database?.close(); await Dexie.delete(name); }
  }
  return report;
}
Object.assign(globalThis, { runCatalogBenchmark });
