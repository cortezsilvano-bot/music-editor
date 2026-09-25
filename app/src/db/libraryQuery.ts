import { effectiveBpm, type StoredTrack } from "./library";
import { displayName } from "../metadata/tags";
import { needsReview } from "./review";

/** Cache derived query keys for each immutable database snapshot. */
export class LibraryQuery {
  private readonly entries;
  private readonly ordered = new Map<string, StoredTrack[]>();
  constructor(tracks: StoredTrack[]) {
    this.entries = tracks.map(track => ({ track,
      search: `${track.name} ${track.tags.artist ?? ""} ${track.tags.title ?? ""} ${track.tags.album ?? ""}`.toLocaleLowerCase(),
      name: displayName(track.tags, track.name), bpm: effectiveBpm(track) ?? 0, review: needsReview(track),
    }));
  }
  query(text: string, filter = "all", sort = "added"): StoredTrack[] {
    const needle = text.trim().toLocaleLowerCase();
    // Sort once per database snapshot rather than once per keystroke.
    let ordered = this.ordered.get(sort);
    if (!ordered) {
      const collator = new Intl.Collator();
      ordered = [...this.entries].sort((a, b) => sort === "name" ? collator.compare(a.name, b.name) :
        sort === "bpm" ? a.bpm - b.bpm : b.track.addedAt - a.track.addedAt).map(entry => entry.track);
      this.ordered.set(sort, ordered);
    }
    if (!needle && filter === "all") return ordered;
    const matches = new Set(this.entries.filter(({ track, search, review }) => search.includes(needle) &&
      (filter === "all" || (filter === "review" ? review : filter === "failed" ? !!track.analysisError : track.reviewedAt !== null)))
      .map(entry => entry.track.id));
    return ordered.filter(track => matches.has(track.id));
  }
}
