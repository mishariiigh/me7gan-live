import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabaseClient } from "@/lib/supabase/service";
import { getKickoffInstant, getScheduleDate } from "@/lib/sports/match-types";

/**
 * Automatic removal of matches some hours after kickoff.
 *
 * ## What "expired" means
 *
 * A match stores `match_date` (calendar day) and `kickoff_time` (wall-clock
 * time), both interpreted in the project timezone (Asia/Riyadh — see migration
 * 005, `public.match_timezone()`). Those two fields are the AUTHORITATIVE
 * kickoff; there is no separate timestamp column.
 *
 * Its real instant is derived with `getKickoffInstant()`, the same helper the
 * public schedule already uses to decide whether a fixture has kicked off, so
 * the cleanup can never disagree with the rest of the site about when a match
 * started.
 *
 * A match is expired when:
 *
 *     kickoffInstant + GRACE_HOURS <= now
 *
 * Equivalently `kickoff <= now - GRACE_HOURS`. Because the comparison is on the
 * derived INSTANT, the six-hour window is exact across a DST boundary or a
 * timezone change — it is not "six wall-clock hours on the same calendar day".
 *
 * ## Why the helpers are pure
 *
 * The predicate and the cutoff are pure functions of `(match, now)` so they can
 * be unit-tested (and reasoned about) without a database, and so the route
 * handler stays a thin wrapper: fetch candidates → filter → delete.
 */

/** Hours after kickoff before a match is removed. */
export const MATCH_GRACE_HOURS = 6;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The `match_date` (Asia/Riyadh) on or before which a match could possibly be
 * expired at `now`.
 *
 * Used to narrow the candidate query: a match whose Riyadh calendar day is
 * strictly after the cutoff day cannot have kicked off early enough to be
 * deleted, so it is excluded at the database level. This keeps the batch small
 * without embedding a timezone computation in the SQL.
 *
 * Returns an offset-free `YYYY-MM-DD` that PostgREST can compare against the
 * `date` column directly.
 */
export function expiredCandidateDate(now: Date = new Date()): string {
  return getScheduleDate(new Date(now.getTime() - MATCH_GRACE_HOURS * HOUR_MS));
}

/**
 * Whether a match should be deleted at `now`.
 *
 * `matchDate`/`kickoffTime` are exactly the stored columns. An unparseable pair
 * is treated as NOT expired: the cleanup only ever deletes a match it can prove
 * is past the window, so a malformed row is left alone rather than removed.
 */
export function isMatchExpired(
  match: { matchDate: string; kickoffTime: string },
  now: Date = new Date(),
): boolean {
  let kickoffMs: number;
  try {
    kickoffMs = Date.parse(getKickoffInstant(match.matchDate, match.kickoffTime));
  } catch {
    // `getKickoffInstant` throws on a malformed date/time pair. Such a row is
    // never provably expired, so it is left alone rather than removed.
    return false;
  }
  if (!Number.isFinite(kickoffMs)) return false;
  return kickoffMs + MATCH_GRACE_HOURS * HOUR_MS <= now.getTime();
}

/** Row shape needed to decide expiry. */
export type ExpirableMatch = {
  fixture_id: string;
  match_date: string;
  kickoff_time: string;
};

export type CleanupResult = {
  /** Whether the service-role client was available. */
  configured: boolean;
  /** How many candidate rows were read in this run. */
  examined: number;
  /** How many matches passed the expiry predicate. */
  expired: number;
  /** How many matches were actually deleted (should equal `expired`). */
  deleted: number;
  /** Fixture ids that were removed, for logging/observability. */
  fixtureIds: string[];
  /** Best-effort count of associated rows removed alongside the matches. */
  removedStreams: number;
  removedWatchLinks: number;
  removedImportKeys: number;
  /** True when the candidate read hit the batch cap and more may remain. */
  hasMore: boolean;
  error?: string;
};

/** Default cap on rows handled per run. Keeps each request short and bounded. */
export const CLEANUP_BATCH_SIZE = 200;

/**
 * Deletes one page of expired matches and their match-specific records.
 *
 * Ordering and safety
 * -------------------
 *   1. Read a bounded batch of candidates whose `match_date` is on/before the
 *      cutoff day (a superset of the expired set).
 *   2. Filter precisely with `isMatchExpired` — the authoritative check.
 *   3. Delete dependent rows first, then the matches. Every match-specific table
 *      keyed by `fixture_id` is covered:
 *        * `fixture_streams`      (on-site broadcaster links)
 *        * `official_watch_links` (official broadcaster links)
 *        * `fixture_import_keys`  (Excel-import bookkeeping)
 *      Without removing `fixture_import_keys`, a stale `source_key` (which is
 *      UNIQUE) would survive the match and permanently block re-importing the
 *      same fixture row. All three are per-match, so removing them leaves
 *      `teams` / `team_aliases` (shared, reusable) and every unrelated record
 *      untouched.
 *   4. Never delete a `teams` row or a stored logo: those are club identities
 *      shared by many fixtures.
 *
 * It is result-deterministic and repeatable: running it again simply finds the
 * remaining expired matches (or none). A partial failure returns a descriptive
 * `error` and reports what was removed, so the caller can retry.
 *
 * Writes use the SERVICE-ROLE client (server-only): the tables are RLS-protected
 * and there is no signed-in user in a cron context.
 */
export async function purgeExpiredMatches(
  options: { now?: Date; batchSize?: number; client?: SupabaseClient | null } = {},
): Promise<CleanupResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? CLEANUP_BATCH_SIZE;

  const base: CleanupResult = {
    configured: false,
    examined: 0,
    expired: 0,
    deleted: 0,
    fixtureIds: [],
    removedStreams: 0,
    removedWatchLinks: 0,
    removedImportKeys: 0,
    hasMore: false,
  };

  const client = options.client ?? createServiceSupabaseClient();
  if (!client) {
    return { ...base, error: "Cleanup is not configured (missing SUPABASE_SERVICE_ROLE_KEY)." };
  }

  const cutoffDate = expiredCandidateDate(now);

  // Superset read: only the fixture id and the two kickoff fields are needed.
  // `.range` is bounded by `batchSize` so a large backlog is drained over
  // successive runs instead of in one long transaction.
  const { data, error } = await client
    .from("matches")
    .select("fixture_id, match_date, kickoff_time")
    .lte("match_date", cutoffDate)
    .order("match_date", { ascending: true })
    .order("kickoff_time", { ascending: true })
    .range(0, batchSize - 1);

  if (error) {
    return { ...base, configured: true, error: `Could not read matches: ${error.message}` };
  }

  const candidates = (data ?? []) as ExpirableMatch[];
  const expired = candidates.filter((row) =>
    isMatchExpired({ matchDate: row.match_date, kickoffTime: row.kickoff_time }, now),
  );
  const fixtureIds = expired.map((row) => row.fixture_id);

  // Hit the cap and every candidate expired: there may be more waiting, so the
  // caller can run again immediately. A partial page means the backlog is done.
  const hasMore = candidates.length === batchSize && candidates.length === expired.length;

  if (fixtureIds.length === 0) {
    return { ...base, configured: true, examined: candidates.length, hasMore: false };
  }

  // Dependent rows first. Each delete is scoped by the fixture ids in this batch,
  // so nothing outside the batch is touched. Rows removed are counted from the
  // returned data for observability.
  const streams = await client
    .from("fixture_streams")
    .delete()
    .in("fixture_id", fixtureIds)
    .select("id");
  if (streams.error) {
    return {
      ...base,
      configured: true,
      examined: candidates.length,
      expired: expired.length,
      error: `Could not delete fixture streams: ${streams.error.message}`,
    };
  }

  const watchLinks = await client
    .from("official_watch_links")
    .delete()
    .in("fixture_id", fixtureIds)
    .select("id");
  if (watchLinks.error) {
    return {
      ...base,
      configured: true,
      examined: candidates.length,
      expired: expired.length,
      removedStreams: streams.data?.length ?? 0,
      error: `Could not delete official watch links: ${watchLinks.error.message}`,
    };
  }

  // Import bookkeeping is match-specific too. `source_key` is UNIQUE, so a
  // leftover row would block re-importing that fixture later. Removed here so
  // the match leaves no trace behind it.
  const importKeys = await client
    .from("fixture_import_keys")
    .delete()
    .in("fixture_id", fixtureIds)
    .select("id");
  if (importKeys.error) {
    return {
      ...base,
      configured: true,
      examined: candidates.length,
      expired: expired.length,
      removedStreams: streams.data?.length ?? 0,
      removedWatchLinks: watchLinks.data?.length ?? 0,
      error: `Could not delete fixture import keys: ${importKeys.error.message}`,
    };
  }

  const matches = await client
    .from("matches")
    .delete()
    .in("fixture_id", fixtureIds)
    .select("fixture_id");
  if (matches.error) {
    return {
      ...base,
      configured: true,
      examined: candidates.length,
      expired: expired.length,
      removedStreams: streams.data?.length ?? 0,
      removedWatchLinks: watchLinks.data?.length ?? 0,
      removedImportKeys: importKeys.data?.length ?? 0,
      error: `Could not delete matches: ${matches.error.message}`,
    };
  }

  return {
    configured: true,
    examined: candidates.length,
    expired: expired.length,
    deleted: matches.data?.length ?? 0,
    fixtureIds,
    removedStreams: streams.data?.length ?? 0,
    removedWatchLinks: watchLinks.data?.length ?? 0,
    removedImportKeys: importKeys.data?.length ?? 0,
    hasMore,
  };
}
