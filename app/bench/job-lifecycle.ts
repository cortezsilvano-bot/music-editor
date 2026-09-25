import { AnalysisScheduler } from "../src/analysis/scheduler";
import { LibraryDatabase } from "../src/db/library";
import { analyze, type AnalysisResult } from "../src/analysis/pipeline";
import { EMPTY_TAGS } from "../src/metadata/tags";

let database: LibraryDatabase;
let scheduler: AnalysisScheduler;
let calls = 0, cancellations = 0;
const pending = new Map<string, (result: AnalysisResult) => void>();
const result = analyze({ channels: [new Float32Array(512)], sampleRate: 22050 });
Object.assign(globalThis, { jobLifecycle: {
  async init(name: string) {
    database = new LibraryDatabase(name);
    scheduler = new AnalysisScheduler(track => {
      calls++;
      return { result: new Promise(resolve => pending.set(track.id, resolve)), cancel: () => { cancellations++; } };
    }, () => {}, () => {}, database, 30_000, { leaseMs: 3000, heartbeatMs: 500, pollMs: 100 });
    await scheduler.start();
    return scheduler.ownerId;
  },
  async enqueue(id: string) {
    await database.tracks.put({ id, name: `${id}.wav`, audio: new Blob(["fixture"]), mimeType: "audio/wav",
      sizeBytes: 7, durationSec: 10, addedAt: Date.now(), peaks: null, tags: { ...EMPTY_TAGS },
      analysis: null, analysisVersion: null, analysisError: null, manualBpm: 123, manualGrid: null,
      manualKeyTonic: 4, manualKeyMode: "minor", reviewedAt: null, cues: [{ id: "cue", name: "Preserved", timeSec: 2 }] });
    await scheduler.enqueue(id);
  },
  async state(id: string) { return { job: await database.jobs.get(id), calls, cancellations,
    track: await database.tracks.get(id), historyCount: await database.analysisHistory.where("trackId").equals(id).count() }; },
  resolve(id: string) { pending.get(id)?.(result); },
  cancel(id: string) { return scheduler.cancel(id); },
  async dispose() { await scheduler.dispose(); database.close(); },
} });
