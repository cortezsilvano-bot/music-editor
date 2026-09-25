import { LibraryDatabase, type StoredTrack, effectiveBpm } from "../src/db/library";
import { EMPTY_TAGS, displayName } from "../src/metadata/tags";
import { needsReview } from "../src/db/review";
import { analyze } from "../src/analysis/pipeline";
import { LibraryQuery } from "../src/db/libraryQuery";

export async function runLibraryBenchmark(sizes = [10_000, 50_000, 100_000]) {
  const database = new LibraryDatabase(`music-editor-benchmark-${crypto.randomUUID()}`);
  const analysis = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
  const audio = new Blob([new Uint8Array(44)], { type: "audio/wav" });
  const report: unknown[] = [];
  let seeded = 0;
  const rounded = (n: number) => Math.round(n * 100) / 100;
  const measure = (fn: () => unknown) => {
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    return { medianMs: rounded(samples[3]), p95Ms: rounded(samples[6]) };
  };
  try {
    for (const size of sizes) {
      const seedAt = performance.now();
      while (seeded < size) {
        const rows: StoredTrack[] = [];
        for (let n = seeded; n < Math.min(seeded + 500, size); n++) rows.push({
          id: `track-${n}`, name: `Recording ${n}.wav`, audio, mimeType: "audio/wav", sizeBytes: 8_000_000,
          durationSec: 180 + n % 240, addedAt: n, peaks: new Float32Array(2000).buffer,
          tags: { ...EMPTY_TAGS, title: `Title ${n}`, artist: `Artist ${n % 400}`, album: `Album ${n % 2000}` },
          analysis: { ...analysis, tempo: { ...analysis.tempo, bpm: 80 + n % 100 } }, analysisVersion: analysis.analysisVersion,
          analysisError: null, manualBpm: null, manualKeyTonic: null, manualKeyMode: null, manualGrid: null, reviewedAt: n % 4 ? null : n,
        });
        await database.tracks.bulkAdd(rows); seeded += rows.length;
      }
      const seedMs = performance.now() - seedAt;
      const loadAt = performance.now();
      const rows = await database.tracks.orderBy("addedAt").reverse().toArray();
      const loadAllMs = performance.now() - loadAt;
      const search = measure(() => rows.filter(t => `${t.name} ${t.tags.artist ?? ""} ${t.tags.title ?? ""} ${t.tags.album ?? ""}`.toLocaleLowerCase().includes("artist 17")));
      const filter = measure(() => rows.filter(needsReview));
      const sortName = measure(() => [...rows].sort((a, b) => displayName(a.tags, a.name).localeCompare(displayName(b.tags, b.name))));
      const sortBpm = measure(() => [...rows].sort((a, b) => (effectiveBpm(a) ?? 0) - (effectiveBpm(b) ?? 0)));
      const prepareAt = performance.now();
      const queries = new LibraryQuery(rows);
      const queryPreparationMs = performance.now() - prepareAt;
      const coldSortAt = performance.now(); queries.query("", "all", "name");
      const coldNameSortMs = performance.now() - coldSortAt;
      const optimizedSearch = measure(() => queries.query("artist 17", "all", "name"));
      const optimizedFilter = measure(() => queries.query("", "review", "name"));
      const pageAt = performance.now();
      await database.tracks.orderBy("addedAt").reverse().limit(100).toArray();
      const indexedPageMs = performance.now() - pageAt;
      const result = { count: size, seedMs: rounded(seedMs), loadAllMs: rounded(loadAllMs), indexedPageMs: rounded(indexedPageMs), search, filter, sortName, sortBpm,
        interactiveQueryGatePassed: [search, filter, sortName, sortBpm].every(m => m.p95Ms < 200),
        waveformBytes: size * 8000,
        optimized: { queryPreparationMs: rounded(queryPreparationMs), coldNameSortMs: rounded(coldNameSortMs), search: optimizedSearch, filter: optimizedFilter },
        limits: "Synthetic full track records: real IndexedDB, 2000-float peaks, analysis objects, 44-byte audio placeholders. No real media I/O, DOM/React rendering, scroll, or decoder throughput measurement." };
      report.push(result); console.log("LIBRARY_BENCHMARK " + JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return report;
  } finally { await database.delete(); }
}
Object.assign(globalThis, { runLibraryBenchmark });
