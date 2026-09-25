import type { DBCore, DBCoreMutateRequest, Dexie } from "dexie";
import type { AnalysisResult } from "../analysis/pipeline";
import { ANALYSIS_VERSION } from "../analysis/pipeline";
import { ANALYZERS, parameterHash, staleAnalyzers } from "../analysis/registry";
import { displayName, EMPTY_TAGS } from "../metadata/tags";
import type { LibraryDatabase, StoredTrack } from "./library";
import { effectiveBpm } from "./trackValues";
import { needsReview } from "./review";

/** Metadata shared by lists, exports, recommendations and deck selectors. */
export type TrackMetadata = Omit<StoredTrack, "audio" | "peaks" | "fingerprint" | "analysis"> & {
  analysis: {
    tempo: Pick<AnalysisResult["tempo"], "bpm">;
    key: Pick<AnalysisResult["key"], "tonic" | "mode">;
    grid: AnalysisResult["grid"];
    energy?: Pick<AnalysisResult["energy"], "level" | "rawScore">;
    vocalCoverage?: number;
    structure?: { sections: Pick<NonNullable<AnalysisResult["structure"]>["sections"][number], "label">[] };
  } | null;
};
export interface CatalogTrack extends TrackMetadata {
  hasFingerprint: boolean;
}
export interface CatalogKey {
  id: string; search: string; name: string; bpm: number; addedAt: number;
  review: number; failed: number; reviewed: number; stale: number;
  /** Lowercased alphanumeric tokens for multiEntry IndexedDB search. */
  tokens: string[];
}
export interface CatalogState { id: string; version: string; after: string | null; complete: boolean; count?: number }
/** Bump projection when CatalogKey shape / indexing semantics change (forces resumable backfill). */
const VERSION = parameterHash({ projection: 3, pipeline: ANALYSIS_VERSION, analyzers: JSON.stringify(ANALYZERS) });

/** Split a lowercase search blob into unique alphanumeric tokens and adjacent bigrams. */
export function catalogSearchTokens(search: string): string[] {
  const raw = search.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => { if (!seen.has(token)) { seen.add(token); tokens.push(token); } };
  for (const part of raw) add(part);
  // Bigrams use the raw adjacency (before unigram dedupe) so "artist 1 title 1" keeps "artist 1".
  for (let i = 0; i < raw.length - 1; i++) add(`${raw[i]} ${raw[i + 1]}`);
  return tokens;
}

const SEARCH_STOP = new Set(["artist", "title", "album", "recording", "song", "track", "wav", "mp3", "flac", "aac", "m4a"]);

/** Prefer distinctive tokens: skip common metadata words, prefer digits, then length. */
export function pickSearchToken(words: string[]): string {
  return [...words].sort((a, b) => {
    const aStop = SEARCH_STOP.has(a) ? 1 : 0, bStop = SEARCH_STOP.has(b) ? 1 : 0;
    if (aStop !== bStop) return aStop - bStop;
    const aNum = /^\d+$/.test(a) ? 0 : 1, bNum = /^\d+$/.test(b) ? 0 : 1;
    if (aNum !== bNum) return aNum - bNum;
    return b.length - a.length;
  })[0];
}

export function projectTrack(track: StoredTrack): { metadata: CatalogTrack; key: CatalogKey } {
  const a = track.analysis;
  // Whitelist fields: adding a heavy analysis field must never inflate the catalog.
  const metadata: CatalogTrack = {
    id: track.id, name: track.name, contentHash: track.contentHash, relativePath: track.relativePath,
    audioHash: track.audioHash, filePath: track.filePath, gridLocked: track.gridLocked, cues: track.cues,
    mimeType: track.mimeType, sizeBytes: track.sizeBytes, durationSec: track.durationSec, addedAt: track.addedAt ?? 0,
    tags: track.tags ?? { ...EMPTY_TAGS }, analysisVersion: track.analysisVersion ?? null,
    analysisError: track.analysisError ?? null, manualBpm: track.manualBpm ?? null, manualGrid: track.manualGrid ?? null,
    manualKeyTonic: track.manualKeyTonic ?? null, manualKeyMode: track.manualKeyMode ?? null, reviewedAt: track.reviewedAt ?? null,
    hasFingerprint: !!track.fingerprint?.byteLength,
    analysis: a?.tempo && a.key && a.grid ? {
      tempo: { bpm: a.tempo.bpm }, key: { tonic: a.key.tonic, mode: a.key.mode }, grid: a.grid,
      energy: a.energy ? { level: a.energy.level, rawScore: a.energy.rawScore } : undefined, vocalCoverage: a.vocalCoverage,
      structure: a.structure ? { sections: a.structure.sections.slice(0, 1).map(({ label }) => ({ label })) } : undefined,
    } : null,
  };
  const search = `${track.name} ${metadata.tags.artist ?? ""} ${metadata.tags.title ?? ""} ${metadata.tags.album ?? ""}`.toLocaleLowerCase();
  const key: CatalogKey = {
    id: track.id, name: displayName(metadata.tags, track.name), bpm: effectiveBpm(metadata) ?? 0,
    search, tokens: catalogSearchTokens(search), addedAt: metadata.addedAt,
    review: Number(metadata.reviewedAt === null && (!metadata.analysis || needsReview({ ...track, ...metadata, analysis: a }))),
    failed: Number(!!metadata.analysisError), reviewed: Number(metadata.reviewedAt !== null),
    stale: Number(!!a && ((track.analysisVersion ?? 0) < ANALYSIS_VERSION || staleAnalyzers(a).length > 0)),
  };
  return { metadata, key };
}

async function revisionCount(down: DBCore, trans: DBCoreMutateRequest["trans"], delta: number | "reset"): Promise<number | undefined> {
  const prior = await down.table("catalogState").get({ trans, key: "revision" }) as CatalogState | undefined;
  if (delta === "reset") return undefined;
  if (typeof prior?.count === "number") return Math.max(0, prior.count + delta);
  return undefined;
}

/** Add the projection stores to the SAME native transaction as every track write.
 * Running above Dexie's observability middleware also notifies catalog liveQuery readers.
 */
export function installCatalog(database: Dexie): void {
  database.use({ stack: "dbcore", name: "track-catalog", level: 10, create(down: DBCore): DBCore {
    if (!down.schema.tables.some(table => table.name === "trackCatalog")) return down;
    return { ...down,
      transaction(stores, mode, options) {
        return down.transaction(mode === "readwrite" && stores.includes("tracks") ?
          [...new Set([...stores, "trackCatalog", "catalogKeys", "catalogState"])] : stores, mode, options);
      },
      table(name) {
        const table = down.table(name);
        if (name !== "tracks") return table;
        return { ...table, async mutate(request) {
          const result = await table.mutate(request);
          try {
            const write = async (store: string, mutation: DBCoreMutateRequest) => {
              const response = await down.table(store).mutate(mutation);
              if (response.numFailures) throw Object.values(response.failures)[0];
            };
            let countDelta: number | "reset" = 0;
            if (request.type === "deleteRange") {
              await write("trackCatalog", request); await write("catalogKeys", request);
              countDelta = "reset";
            } else if (request.type === "delete") {
              const keys = request.keys.filter((_, index) => !result.failures[index]);
              await write("trackCatalog", { ...request, keys }); await write("catalogKeys", { ...request, keys });
              countDelta = -keys.length;
            } else {
              const keys = (result.results ?? []).filter((_, index) => !result.failures[index]);
              if (keys.length) {
                const existing = await down.table("catalogKeys").getMany({ trans: request.trans, keys });
                countDelta = existing.filter(row => !row).length;
                const rows = await table.getMany({ trans: request.trans, keys });
                const projections = rows.filter((row): row is StoredTrack => !!row).map(projectTrack);
                await write("trackCatalog", { type: "put", trans: request.trans, values: projections.map(p => p.metadata) });
                await write("catalogKeys", { type: "put", trans: request.trans, values: projections.map(p => p.key) });
              }
            }
            const count = await revisionCount(down, request.trans, countDelta);
            await write("catalogState", { type: "put", trans: request.trans,
              values: [{ id: "revision", version: crypto.randomUUID(), after: null, complete: true, ...(count !== undefined ? { count } : {}) }] });
          } catch (error) { request.trans.abort(); throw error; }
          return result;
        } };
      },
    };
  } });
}

/** Resumable, bounded backfill. Concurrent writers cannot be overwritten by an older snapshot. */
export async function indexCatalogBatch(database: LibraryDatabase, batchSize = 100): Promise<boolean> {
  return database.transaction("rw", database.tracks, database.trackCatalog, database.catalogKeys, database.catalogState, async () => {
    let state = await database.catalogState.get("tracks");
    if (state?.version !== VERSION) state = { id: "tracks", version: VERSION, after: null, complete: false };
    if (state.complete) return true;
    const rows = await (state.after === null ? database.tracks.orderBy(":id") : database.tracks.where(":id").above(state.after))
      .limit(Math.max(1, batchSize)).toArray();
    const projections = rows.map(projectTrack);
    await database.trackCatalog.bulkPut(projections.map(p => p.metadata));
    await database.catalogKeys.bulkPut(projections.map(p => p.key));
    const complete = rows.length < Math.max(1, batchSize);
    const count = complete ? await database.catalogKeys.count() : undefined;
    await database.catalogState.put({
      id: "revision", version: crypto.randomUUID(), after: null, complete: true,
      ...(count !== undefined ? { count } : {}),
    });
    await database.catalogState.put({ ...state, after: rows.at(-1)?.id ?? state.after, complete });
    return complete;
  });
}

export interface CatalogPage { tracks: CatalogTrack[]; total: number; offset: number }

function sortKeys(rows: CatalogKey[], sort: string): CatalogKey[] {
  const collator = sort === "name" ? new Intl.Collator() : null;
  return [...rows].sort((a, b) =>
    (sort === "name" ? collator!.compare(a.name, b.name)
      : sort === "bpm" ? a.bpm - b.bpm
      : b.addedAt - a.addedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (sort === "added" ? -1 : 1));
}

function filterKeys(rows: CatalogKey[], needle: string, filter: string): CatalogKey[] {
  if (!needle && filter === "all") return rows;
  return rows.filter(row =>
    (!needle || row.search.includes(needle)) &&
    (filter === "all" || (filter === "review" ? row.review : filter === "failed" ? row.failed : row.reviewed)));
}

/** Compact search keys are loaded only for global search / locale-aware name sorting. */
export class CatalogRepository {
  private revision: string | undefined;
  private keysLoaded = false;
  private keys: CatalogKey[] = [];
  private ordered = new Map<string, CatalogKey[]>();
  private total: number | undefined;
  private cursors = new Map<string, [number, string]>();
  constructor(readonly database: LibraryDatabase) {}
  private refresh(): Promise<void> {
    // Keep read transactions on Dexie's promise chain, including cache-hit paths.
    // Native async helpers with no further IDB request can outlive the transaction.
    return this.database.catalogState.get("revision").then(state => {
      const revision = state?.version ?? "empty";
      if (revision !== this.revision) {
        this.revision = revision; this.keysLoaded = false; this.keys = [];
        this.ordered.clear(); this.cursors.clear(); this.total = undefined;
      }
      if (this.total === undefined && typeof state?.count === "number") this.total = state.count;
    });
  }
  /** Prefer token / flag indexes over a full key scan on cold queries. */
  private candidateKeys(needle: string, filter: string): Promise<CatalogKey[]> {
    if (this.keysLoaded) return Promise.resolve(this.keys);
    // Word tokens only for query planning (ignore indexed bigrams in the needle split).
    const words = needle.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      .filter((word, index, all) => all.indexOf(word) === index);
    if (words.length) {
      // Multi-word: use adjacent bigram (e.g. "artist 17") so IDB returns a tight candidate set.
      // Single-word: startsWith on the most selective token.
      if (words.length >= 2) {
        const bigram = `${words[0]} ${words[1]}`;
        return this.database.catalogKeys.where("tokens").startsWith(bigram).distinct().toArray();
      }
      const selective = pickSearchToken(words);
      return this.database.catalogKeys.where("tokens").startsWith(selective).distinct().toArray();
    }
    if (filter === "review" || filter === "failed" || filter === "reviewed") {
      return this.database.catalogKeys.where(filter).equals(1).toArray();
    }
    return this.database.catalogKeys.toArray().then(keys => {
      this.keys = keys; this.keysLoaded = true; return keys;
    });
  }
  private matchingKeys(text: string, filter: string, sort: string): Promise<CatalogKey[]> {
    return this.refresh().then(() => {
      const needle = text.trim().toLocaleLowerCase();
      const cacheKey = `${sort}|${filter}|${needle}`;
      const cached = this.ordered.get(cacheKey);
      if (cached) return cached;
      // Filter before sort so cold global search only sorts the match set.
      return this.candidateKeys(needle, filter).then(candidates => {
        const ordered = sortKeys(filterKeys(candidates, needle, filter), sort);
        this.ordered.set(cacheKey, ordered);
        return ordered;
      });
    });
  }
  /** Export the entire filtered result, never just its visible page. */
  matching(text: string, filter: string, sort: string): Promise<CatalogTrack[]> {
    return this.database.transaction("r", this.database.trackCatalog, this.database.catalogKeys, this.database.catalogState, () =>
      this.matchingKeys(text, filter, sort).then(keys => this.database.trackCatalog.bulkGet(keys.map(key => key.id)))
        .then(rows => rows.filter((row): row is CatalogTrack => !!row)));
  }
  page(text = "", filter = "all", sort = "added", offset = 0, limit = 100): Promise<CatalogPage> {
    const needle = text.trim().toLocaleLowerCase();
    const pageSize = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.database.transaction("r", this.database.trackCatalog, this.database.catalogKeys, this.database.catalogState, () => {
      let total = 0, start = Math.max(0, Math.floor(offset));
      const clamp = () => { start = Math.min(start, Math.max(0, Math.floor((total - 1) / pageSize) * pageSize)); };
      const selected = !needle && filter === "all" && sort !== "name" ?
        this.refresh().then(() => this.total ?? this.database.catalogKeys.count()).then(count => {
          total = this.total = count; clamp();
          const index = sort === "bpm" ? "[bpm+id]" : "[addedAt+id]";
          const take = Math.min(pageSize, Math.max(0, total - start));
          if (take === 0) return [] as CatalogKey[];
          const cursor = this.cursors.get(`${sort}:${start}`);
          const remember = (rows: CatalogKey[]) => {
            const last = rows.at(-1);
            if (last) this.cursors.set(`${sort}:${start + rows.length}`, [sort === "bpm" ? last.bpm : last.addedAt, last.id]);
            return rows;
          };
          if (cursor) {
            const ordered = sort === "bpm" ? this.database.catalogKeys.where(index).above(cursor) :
              this.database.catalogKeys.where(index).below(cursor).reverse();
            return ordered.limit(take).toArray().then(remember);
          }
          // Deep jump: approach from the nearer end so huge IDB offsets are avoided.
          if (start > total - start) {
            const forwardOffset = total - start - take;
            if (sort === "bpm") {
              return this.database.catalogKeys.orderBy(index).reverse().offset(forwardOffset).limit(take).toArray()
                .then(rows => remember(rows.reverse()));
            }
            return this.database.catalogKeys.orderBy(index).offset(forwardOffset).limit(take).toArray()
              .then(rows => remember(rows.reverse()));
          }
          const ordered = sort === "bpm" ? this.database.catalogKeys.orderBy(index).offset(start) :
            this.database.catalogKeys.orderBy(index).reverse().offset(start);
          return ordered.limit(take).toArray().then(remember);
        }) : this.matchingKeys(text, filter, sort).then(matches => {
          total = matches.length; clamp(); return matches.slice(start, start + pageSize);
        });
      return selected.then(keys => this.database.trackCatalog.bulkGet(keys.map(row => row.id)))
        .then(rows => ({ tracks: rows.filter((row): row is CatalogTrack => !!row), total, offset: start }));
    });
  }
}
