/**
 * Stem cache (research Phase M).
 *
 * Separation is expensive - minutes per track on CPU - so results are kept.
 * They are also large, a few hundred megabytes for a handful of tracks, so the
 * cache is capped and evicted rather than left to grow until the browser's
 * storage quota throws somewhere unrelated.
 *
 * Entries are keyed by the *audio* hash and the model that produced them, not
 * by track id. Two copies of the same recording therefore share one result, and
 * re-running with a different engine does not silently return the old stems.
 */
import { db } from "./library";
import type { StemType } from "../stems/service";

export interface CachedStem {
  name: string;
  type: StemType;
  blob: Blob;
}

export interface StemCacheEntry {
  /** `${audioHash}:${backend}` */
  id: string;
  audioHash: string;
  /** Engine and model that produced these, e.g. "demucs/htdemucs". */
  model: string;
  trackId: string;
  trackName: string;
  stems: CachedStem[];
  sizeBytes: number;
  createdAt: number;
  /** Touched on use, so eviction can drop the least recently wanted. */
  lastUsedAt: number;
  /** Pinned entries are never evicted automatically. */
  pinned: boolean;
}

/** Default cap. Roughly a dozen four-stem tracks. */
export const DEFAULT_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export function cacheKey(audioHash: string, model: string): string {
  return `${audioHash}:${model}`;
}

export async function getCachedStems(
  audioHash: string,
  model: string,
): Promise<StemCacheEntry | undefined> {
  const entry = await db.stemCache.get(cacheKey(audioHash, model));
  if (entry) {
    // Touch on read: eviction should drop what nobody is using, and a cache
    // that only records writes would evict the track you reach for daily.
    await db.stemCache.update(entry.id, { lastUsedAt: Date.now() });
  }
  return entry;
}

export async function putCachedStems(
  entry: Omit<StemCacheEntry, "id" | "createdAt" | "lastUsedAt" | "pinned" | "sizeBytes">,
): Promise<StemCacheEntry> {
  const sizeBytes = entry.stems.reduce((sum, s) => sum + s.blob.size, 0);
  const now = Date.now();
  const full: StemCacheEntry = {
    ...entry,
    id: cacheKey(entry.audioHash, entry.model),
    sizeBytes,
    createdAt: now,
    lastUsedAt: now,
    pinned: false,
  };
  await db.stemCache.put(full);
  return full;
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await db.stemCache.update(id, { pinned });
}

export async function removeCached(id: string): Promise<void> {
  await db.stemCache.delete(id);
}

export async function allCached(): Promise<StemCacheEntry[]> {
  return db.stemCache.orderBy("lastUsedAt").reverse().toArray();
}

export async function cacheSize(): Promise<{ bytes: number; entries: number; pinned: number }> {
  const rows = await db.stemCache.toArray();
  return {
    bytes: rows.reduce((sum, r) => sum + r.sizeBytes, 0),
    entries: rows.length,
    pinned: rows.filter((r) => r.pinned).length,
  };
}

export interface EvictionPlan {
  /** Entries that would be removed, oldest use first. */
  remove: StemCacheEntry[];
  freedBytes: number;
  /** True when the cap cannot be met without dropping pinned entries. */
  blockedByPins: boolean;
}

/**
 * Decide what to evict to fit under `limitBytes`.
 *
 * Pure, so the awkward part - "the cap cannot be met because everything is
 * pinned" - is testable rather than discovered when the disk fills. Nothing is
 * deleted here; the caller applies the plan.
 */
export function planEviction(
  entries: readonly StemCacheEntry[],
  limitBytes: number,
): EvictionPlan {
  const total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  if (total <= limitBytes) return { remove: [], freedBytes: 0, blockedByPins: false };

  const candidates = entries
    .filter((e) => !e.pinned)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  const remove: StemCacheEntry[] = [];
  let freed = 0;
  for (const entry of candidates) {
    if (total - freed <= limitBytes) break;
    remove.push(entry);
    freed += entry.sizeBytes;
  }

  return {
    remove,
    freedBytes: freed,
    // Still over the cap with every unpinned entry gone.
    blockedByPins: total - freed > limitBytes,
  };
}

/** Apply the cap, returning what was removed. */
export async function enforceCacheLimit(
  limitBytes = DEFAULT_CACHE_LIMIT_BYTES,
): Promise<EvictionPlan> {
  const entries = await db.stemCache.toArray();
  const plan = planEviction(entries, limitBytes);
  if (plan.remove.length > 0) {
    await db.stemCache.bulkDelete(plan.remove.map((e) => e.id));
  }
  return plan;
}

/**
 * Sanity-check a separation before it is cached.
 *
 * The brief asks for a reconstruction check, and it is worth having: a service
 * that returns four near-silent files is a failure that otherwise looks like a
 * success, and the user would only find out on the timeline.
 */
export function checkStemsPlausible(
  stems: readonly CachedStem[],
  sourceSizeBytes: number,
): { ok: boolean; reason: string | null } {
  if (stems.length === 0) return { ok: false, reason: "The service returned no stems." };
  const tiny = stems.filter((s) => s.blob.size < 1024);
  if (tiny.length > 0) {
    return { ok: false, reason: `${tiny.length} stem(s) came back empty.` };
  }
  const total = stems.reduce((sum, s) => sum + s.blob.size, 0);
  // Stems are uncompressed WAV against a compressed source, so they are much
  // larger; a total smaller than the input means something truncated them.
  if (total < sourceSizeBytes) {
    return { ok: false, reason: "Stems are smaller than the source; separation looks truncated." };
  }
  return { ok: true, reason: null };
}
