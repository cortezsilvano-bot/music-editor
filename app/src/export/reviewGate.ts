/**
 * Export / tag-write gate based on review state.
 *
 * Default: block any track the catalog marks as needing review
 * (unreviewed with review reasons). No silent partial export.
 */

export interface ReviewGateTrack {
  id: string;
  name: string;
}

export interface ReviewGateResult {
  allowed: ReviewGateTrack[];
  blocked: ReviewGateTrack[];
}

/**
 * Split tracks into exportable vs blocked using a needs-review map
 * (typically catalogKeys.review === 1).
 */
export function gateTracksByReview(
  tracks: ReviewGateTrack[],
  needsReviewById: ReadonlyMap<string, boolean> | Record<string, boolean>,
): ReviewGateResult {
  const lookup = (id: string): boolean => {
    if (needsReviewById instanceof Map) return needsReviewById.get(id) === true;
    return Object.prototype.hasOwnProperty.call(needsReviewById, id)
      ? (needsReviewById as Record<string, boolean>)[id] === true
      : false;
  };

  const allowed: ReviewGateTrack[] = [];
  const blocked: ReviewGateTrack[] = [];
  for (const track of tracks) {
    if (lookup(track.id)) blocked.push(track);
    else allowed.push(track);
  }
  return { allowed, blocked };
}

/** True when every track is clear for export. */
export function canExportAll(
  tracks: ReviewGateTrack[],
  needsReviewById: ReadonlyMap<string, boolean> | Record<string, boolean>,
): boolean {
  return gateTracksByReview(tracks, needsReviewById).blocked.length === 0;
}
