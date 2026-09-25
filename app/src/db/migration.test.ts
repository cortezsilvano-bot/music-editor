/** @vitest-environment jsdom */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it } from "vitest";
import { LibraryDatabase } from "./library";
it("adds track identity to v11 jobs without invalidating a live lease", async () => {
  const name = `upgrade-v11-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(11).stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
    jobs: "id, status, priority, queuedAt, leaseUntil, nextAttemptAt", jobEvents: "++id, jobId, runId, at",
    analysisHistory: "id, trackId, savedAt", feedback: "id, fromTrackId, toTrackId, action, at",
    stemCache: "id, audioHash, trackId, lastUsedAt, pinned" });
  const job = { id: "track", phase: "analysis", status: "running", owner: "window", attemptId: "attempt", runId: "run", leaseUntil: Date.now() + 15000 };
  await old.table("jobs").add(job); old.close();
  const upgraded = new LibraryDatabase(name);
  try { expect(await upgraded.jobs.get("track")).toEqual({ ...job, trackId: "track" }); }
  finally { upgraded.close(); await Dexie.delete(name); }
});
it("upgrades an actual v1 database while preserving legacy analysis and manual edits", async () => {
  const name = "migration-test";
  await Dexie.delete(name);
  const old = new Dexie(name);
  old.version(1).stores({ tracks: "id, name, addedAt, analysisVersion, reviewedAt" });
  await old.table("tracks").add({ id: "legacy", name: "old.wav", manualBpm: 123,
    manualKeyTonic: 4, manualKeyMode: "minor", analysisVersion: 1,
    analysis: { analysisVersion: 1, tempo: { bpm: 120 } } });
  old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    const stored = await upgraded.tracks.get("legacy");
    expect(stored?.manualBpm).toBe(123);
    expect(stored?.manualKeyTonic).toBe(4);
    expect(stored?.analysis?.tempo.bpm).toBe(120);
    expect(stored?.manualGrid).toBeNull();
    expect(stored?.tags.title).toBeNull();
    expect(await upgraded.jobs.count()).toBe(0);
  } finally { upgraded.close(); await Dexie.delete(name); }
});

it("upgrades v9 jobs without changing audio, edits, cues, feedback or cached stems", async () => {
  const name = `upgrade-v9-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(9).stores({
    tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
    jobs: "id, status, priority, queuedAt", feedback: "id, fromTrackId, toTrackId, action, at",
    stemCache: "id, audioHash, trackId, lastUsedAt, pinned",
  });
  const track = { id: "preserved", name: "music.wav", audio: new Uint8Array([1, 2, 3]).buffer,
    peaks: new Float32Array([0.1, 0.8]).buffer, tags: { title: "My title" },
    manualBpm: 123, manualKeyTonic: 4, manualKeyMode: "minor", gridLocked: true,
    manualGrid: { anchors: [{ timeSec: 1, beatIndex: 0, bpm: 123 }] },
    cues: [{ id: "intro", name: "Intro", timeSec: 4 }], analysis: { analysisVersion: 4 }, reviewedAt: 25 };
  const cache = { id: "hash:model", trackId: track.id, audioHash: "hash", pinned: true,
    stems: [{ name: "vocals", blob: new Uint8Array([4, 5]).buffer }] };
  const feedback = { id: "feedback", fromTrackId: track.id, toTrackId: "next", action: "accepted", at: 50 };
  await old.table("tracks").add(track);
  await old.table("stemCache").add(cache);
  await old.table("feedback").add(feedback);
  await old.table("jobs").bulkAdd(["running", "cancelled", "done"].map(status => ({
    id: status, status, attempts: 1, queuedAt: 10, priority: 0, error: null,
  })));
  old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    expect(await upgraded.tracks.get(track.id)).toEqual(track);
    expect(await upgraded.stemCache.get(cache.id)).toEqual(cache);
    expect(await upgraded.feedback.get(feedback.id)).toEqual(feedback);
    const jobs = await upgraded.jobs.toArray();
    expect(jobs.map(job => job.status).sort()).toEqual(["cancelled", "done", "running"]);
    expect(new Set(jobs.map(job => job.runId)).size).toBe(3);
    expect(jobs.every(job => job.owner === null && job.leaseUntil === null && job.maxAttempts === 3)).toBe(true);
    expect(await upgraded.analysisHistory.count()).toBe(0);
    expect(await upgraded.jobEvents.count()).toBe(0);
  } finally { upgraded.close(); await Dexie.delete(name); }
});

it("upgrades v13 catalog to v14 playlists and peak pyramids without touching tracks", async () => {
  const name = `upgrade-v13-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(13).stores({
    tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
    jobs: "id, status, priority, queuedAt, leaseUntil, nextAttemptAt, trackId, phase",
    jobEvents: "++id, jobId, runId, at", analysisHistory: "id, trackId, savedAt",
    feedback: "id, fromTrackId, toTrackId, action, at",
    stemCache: "id, audioHash, trackId, lastUsedAt, pinned",
    trackCatalog: "id", catalogKeys: "id, [addedAt+id], [bpm+id], stale", catalogState: "id",
  });
  const track = { id: "keep", name: "song.wav", addedAt: 1, analysisVersion: 1, reviewedAt: null,
    contentHash: "abc", audio: new Uint8Array([1]).buffer, peaks: new Float32Array([0.2]).buffer };
  await old.table("tracks").add(track);
  await old.table("catalogKeys").add({ id: "keep", search: "song", name: "song.wav", bpm: 0, addedAt: 1, review: 0, failed: 0, reviewed: 0, stale: 0 });
  old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    expect(await upgraded.tracks.get("keep")).toEqual(track);
    expect(await upgraded.playlists.count()).toBe(0);
    expect(await upgraded.peakPyramids.count()).toBe(0);
    await upgraded.playlists.add({ id: "p1", name: "Set", trackIds: ["keep"], createdAt: 1, updatedAt: 1 });
    expect((await upgraded.playlists.get("p1"))?.trackIds).toEqual(["keep"]);
  } finally { upgraded.close(); await Dexie.delete(name); }
});

it("upgrades v14 catalogKeys to v15 token indexes and invalidates projection checkpoint", async () => {
  const name = `upgrade-v14-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(14).stores({
    tracks: "id, name, addedAt, analysisVersion, reviewedAt, &contentHash, filePath, audioHash",
    jobs: "id, status, priority, queuedAt, leaseUntil, nextAttemptAt, trackId, phase",
    jobEvents: "++id, jobId, runId, at", analysisHistory: "id, trackId, savedAt",
    feedback: "id, fromTrackId, toTrackId, action, at",
    stemCache: "id, audioHash, trackId, lastUsedAt, pinned",
    trackCatalog: "id", catalogKeys: "id, [addedAt+id], [bpm+id], stale", catalogState: "id",
    playlists: "id, name, updatedAt", peakPyramids: "id, contentHash, trackId",
  });
  const track = { id: "keep", name: "song.wav", addedAt: 1, analysisVersion: 1, reviewedAt: null,
    contentHash: "abc", audio: new Uint8Array([1]).buffer, peaks: new Float32Array([0.2]).buffer };
  await old.table("tracks").add(track);
  await old.table("catalogKeys").add({ id: "keep", search: "song artist", name: "song.wav", bpm: 0, addedAt: 1, review: 0, failed: 0, reviewed: 0, stale: 0 });
  await old.table("catalogState").put({ id: "tracks", version: "old", after: null, complete: true });
  old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    expect(await upgraded.tracks.get("keep")).toEqual(track);
    expect((await upgraded.catalogState.get("tracks"))?.complete).toBe(false);
    const { indexCatalogBatch } = await import("./catalog");
    while (!(await indexCatalogBatch(upgraded, 10))) { /* backfill tokens */ }
    expect((await upgraded.catalogKeys.get("keep"))?.tokens).toEqual(expect.arrayContaining(["song", "wav"]));
  } finally { upgraded.close(); await Dexie.delete(name); }
});
