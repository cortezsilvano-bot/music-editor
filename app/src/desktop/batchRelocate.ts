/**
 * Propose folder-level relocate matches for missing library files.
 *
 * Default matching order:
 * 1. Unique relativePath match (POSIX) when the track stored one.
 * 2. Unique basename match (case-sensitive, path basename).
 *
 * Ambiguous basenames / relative paths are skipped (listed, not applied).
 * Hash verification still happens in relocateTrackFile — mismatches refuse.
 */

export interface MissingTrackRef {
  id: string;
  filePath: string;
  /** Original import-relative path when known (POSIX separators). */
  relativePath?: string | null;
  name: string;
}

export interface FolderFileRef {
  path: string;
  relativePath: string;
  name: string;
}

export type RelocateMatchBy = "relativePath" | "basename";

export interface RelocateProposal {
  trackId: string;
  oldPath: string;
  newPath: string;
  matchBy: RelocateMatchBy;
}

export interface RelocateMatchResult {
  matches: RelocateProposal[];
  /** Track ids skipped because more than one folder file matched the key. */
  ambiguous: string[];
  /** Track ids with no candidate in the folder. */
  unmatched: string[];
}

function basenameOf(filePath: string): string {
  const normalised = filePath.replace(/\\/g, "/");
  const parts = normalised.split("/");
  return parts[parts.length - 1] || filePath;
}

function indexUnique(keys: Array<{ key: string; file: FolderFileRef }>): {
  unique: Map<string, FolderFileRef>;
  ambiguous: Set<string>;
} {
  const counts = new Map<string, FolderFileRef[]>();
  for (const { key, file } of keys) {
    const list = counts.get(key) ?? [];
    list.push(file);
    counts.set(key, list);
  }
  const unique = new Map<string, FolderFileRef>();
  const ambiguous = new Set<string>();
  for (const [key, files] of counts) {
    if (files.length === 1) unique.set(key, files[0]!);
    else ambiguous.add(key);
  }
  return { unique, ambiguous };
}

/**
 * Map missing tracks onto files found under a picked folder.
 * Does not read bytes or update the DB — caller runs relocateTrackFile per match.
 */
export function proposeRelocateMatches(
  missing: MissingTrackRef[],
  folderFiles: FolderFileRef[],
): RelocateMatchResult {
  const byRelative = indexUnique(
    folderFiles.map((file) => ({ key: file.relativePath.replace(/\\/g, "/"), file })),
  );
  const byBasename = indexUnique(
    folderFiles.map((file) => ({ key: file.name || basenameOf(file.path), file })),
  );

  const matches: RelocateProposal[] = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  const claimedPaths = new Set<string>();

  for (const track of missing) {
    const rel = (track.relativePath ?? "").replace(/\\/g, "/").replace(/^\/+/g, "");
    let file: FolderFileRef | undefined;
    let matchBy: RelocateMatchBy | null = null;

    if (rel) {
      if (byRelative.ambiguous.has(rel)) {
        ambiguous.push(track.id);
        continue;
      }
      file = byRelative.unique.get(rel);
      if (file) matchBy = "relativePath";
    }

    if (!file) {
      const base = track.name || basenameOf(track.filePath);
      if (byBasename.ambiguous.has(base)) {
        ambiguous.push(track.id);
        continue;
      }
      file = byBasename.unique.get(base);
      if (file) matchBy = "basename";
    }

    if (!file || !matchBy) {
      unmatched.push(track.id);
      continue;
    }
    if (claimedPaths.has(file.path)) {
      ambiguous.push(track.id);
      continue;
    }
    claimedPaths.add(file.path);
    matches.push({
      trackId: track.id,
      oldPath: track.filePath,
      newPath: file.path,
      matchBy,
    });
  }

  return { matches, ambiguous, unmatched };
}
