/**
 * Transition feedback log (research Phase L).
 *
 * Records what was actually chosen after a recommendation was shown. Nothing
 * currently learns from this - the weights in `recommendations.ts` are fixed -
 * but without a record there is no way to ever check whether they are any good,
 * and the data has to be collected before it can be used.
 */
import { db } from "./library";

export type FeedbackAction = "accepted" | "skipped" | "played";

export interface FeedbackEntry {
  id: string;
  fromTrackId: string;
  toTrackId: string;
  action: FeedbackAction;
  /** Score the engine gave this pairing, so predictions can be scored later. */
  predictedScore: number;
  /** Rank it appeared at in the list, 0-based. */
  rank: number;
  at: number;
}

export async function logFeedback(entry: Omit<FeedbackEntry, "id" | "at">): Promise<void> {
  await db.feedback.add({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
  });
}

export async function recentlyPlayed(limit = 20): Promise<string[]> {
  const rows = await db.feedback
    .where("action")
    .anyOf("accepted", "played")
    .reverse()
    .sortBy("at");
  return rows.slice(0, limit).map((r) => r.toTrackId);
}

export async function feedbackFor(fromTrackId: string): Promise<FeedbackEntry[]> {
  return db.feedback.where("fromTrackId").equals(fromTrackId).toArray();
}

/**
 * How often the top suggestion was the one taken.
 *
 * The number the weights should eventually be judged against.
 */
export async function acceptanceStats(): Promise<{
  shown: number;
  accepted: number;
  topRankAccepted: number;
}> {
  const rows = await db.feedback.toArray();
  const accepted = rows.filter((r) => r.action === "accepted");
  return {
    shown: rows.length,
    accepted: accepted.length,
    topRankAccepted: accepted.filter((r) => r.rank === 0).length,
  };
}
