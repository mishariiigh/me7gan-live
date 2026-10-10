import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applyTeamLogos, loadTeamLogoIndex } from "@/lib/sports/team-logos";
import type { Competition } from "@/lib/sports/competitions";
import {
  formatKickoffTime,
  getNextScheduleDate,
  getScheduleDate,
  getWeekBounds,
  type PublicFixtureSchedule,
  type PublicMatch,
} from "@/lib/sports/match-types";

export type { PublicFixtureSchedule, PublicMatch } from "@/lib/sports/match-types";
export { MATCH_TIMEZONE, getWeekBounds } from "@/lib/sports/match-types";

export type MatchRow = {
  id: string;
  fixture_id: string;
  match_date: string;
  kickoff_time: string;
  competition: Competition;
  home_team: string;
  away_team: string;
  home_team_logo: string | null;
  away_team_logo: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
};

const MATCH_COLUMNS =
  "id, fixture_id, match_date, kickoff_time, competition, home_team, away_team, home_team_logo, away_team_logo, published, created_at, updated_at";

/** Today's calendar date in the project timezone. Never hard-coded. */
export function getTodayScheduleDate() {
  return getScheduleDate();
}

/** Tomorrow's calendar date in the project timezone. Never hard-coded. */
export function getTomorrowScheduleDate() {
  return getNextScheduleDate(getTodayScheduleDate());
}

function mapMatch(row: MatchRow, options: { hasActiveStream?: boolean } = {}): PublicMatch {
  return {
    fixtureId: row.fixture_id,
    matchDate: row.match_date,
    kickoffTime: row.kickoff_time,
    kickoffLabel: formatKickoffTime(row.kickoff_time),
    competition: row.competition,
    home: { name: row.home_team, logo: row.home_team_logo },
    away: { name: row.away_team, logo: row.away_team_logo },
    hasActiveStream: options.hasActiveStream ?? false,
  };
}

async function withActiveStreamFlag(rows: MatchRow[]): Promise<PublicMatch[]> {
  if (rows.length === 0) return [];
  const client = await createSupabaseServerClient();
  // Stored club crests are resolved once for the whole page, then applied to
  // every fixture. This is what makes a logo uploaded once appear on all past
  // and future matches involving that club.
  const logoIndex = await loadTeamLogoIndex(client);

  if (!client) return rows.map((row) => applyTeamLogos(mapMatch(row), logoIndex));

  const fixtureIds = rows.map((row) => row.fixture_id);
  const { data, error } = await client
    .from("fixture_streams")
    .select("fixture_id")
    .in("fixture_id", fixtureIds)
    .eq("active", true);

  if (error || !data) return rows.map((row) => applyTeamLogos(mapMatch(row), logoIndex));
  const streamed = new Set((data as { fixture_id: string }[]).map((row) => row.fixture_id));
  return rows.map((row) =>
    applyTeamLogos(mapMatch(row, { hasActiveStream: streamed.has(row.fixture_id) }), logoIndex),
  );
}

/**
 * Public schedule for the homepage and /upcoming.
 *
 * Reads published matches from Supabase for the Monday..Sunday week containing
 * the current date in the project timezone. `today` and `tomorrow` are derived
 * from that window, so a single query serves the homepage's Today, Tomorrow and
 * This Week filters without extra requests. Matches outside the week remain
 * available in Admin → Schedule.
 */
export async function getPublicFixtureSchedule(): Promise<PublicFixtureSchedule> {
  const todayDate = getTodayScheduleDate();
  const tomorrowDate = getTomorrowScheduleDate();
  const { weekStartDate, weekEndDate } = getWeekBounds(todayDate);
  const queryEndDate =
    tomorrowDate > weekEndDate ? tomorrowDate : weekEndDate;

  const empty = {
    today: [],
    tomorrow: [],
    week: [],
    todayDate,
    tomorrowDate,
    weekStartDate,
    weekEndDate,
    error: false,
  };

  const client = await createSupabaseServerClient();
  if (!client) return empty;

  // One query covers all three homepage filters. "This Week" is the whole
  // Monday..Sunday range; today and tomorrow are subsets of it, so widening the
  // window costs nothing extra and keeps every filter on identical data.
  //
  // `.range` is explicit for the same reason every other multi-row query in this
  // module sets it: PostgREST applies a server-side row cap, and without an
  // explicit window a busy week would be silently truncated — matches would go
  // missing from "This Week" with no error anywhere.
  const { data, error } = await client
    .from("matches")
    .select(MATCH_COLUMNS)
    .eq("published", true)
    .gte("match_date", weekStartDate)
    .lte("match_date", queryEndDate)
    .order("match_date", { ascending: true })
    .order("kickoff_time", { ascending: true })
    .order("created_at", { ascending: true })
    .range(0, 999);

  if (error) return { ...empty, error: true };

  const rows = (data ?? []) as MatchRow[];
  const withStreams = await withActiveStreamFlag(rows);
  return {
    today: withStreams.filter((match) => match.matchDate === todayDate),
    tomorrow: withStreams.filter((match) => match.matchDate === tomorrowDate),
    // The week window is a superset of today+tomorrow, so it is filtered from
    // the same rows: no second query, and no chance of the two disagreeing.
    week: withStreams.filter(
      (match) =>
        match.matchDate >= weekStartDate &&
        match.matchDate <= weekEndDate,
    ),
    weekStartDate,
    weekEndDate,
    todayDate,
    tomorrowDate,
    error: false,
  };
}

/**
 * Published matches available to watch now.
 *
 * Includes matches with an active playable stream (hls/embed) **and** matches
 * with an active official external link, so an external-only match stays visible
 * on /live and is labelled as an official broadcast on its card.
 *
 * `hasActiveStream` is only true for a playable on-site source; an external link
 * alone leaves it false so the UI labels the match correctly.
 */
export async function getLiveMatches(): Promise<{ matches: PublicMatch[]; error: boolean }> {
  const client = await createSupabaseServerClient();
  if (!client) return { matches: [], error: false };

  const { data: streamRows, error: streamError } = await client
    .from("fixture_streams")
    .select("fixture_id, stream_type")
    .eq("active", true)
    .range(0, 999);
  if (streamError) return { matches: [], error: true };

  const rows = (streamRows ?? []) as { fixture_id: string; stream_type: string }[];
  const fixtureIds = [...new Set(rows.map((row) => row.fixture_id))];
  if (fixtureIds.length === 0) return { matches: [], error: false };

  const playable = new Set(
    rows.filter((row) => row.stream_type === "hls" || row.stream_type === "embed").map((row) => row.fixture_id),
  );

  const { data, error } = await client
    .from("matches")
    .select(MATCH_COLUMNS)
    .eq("published", true)
    .in("fixture_id", fixtureIds)
    .order("match_date", { ascending: true })
    .order("kickoff_time", { ascending: true });
  if (error) return { matches: [], error: true };

  return {
    matches: (data as MatchRow[]).map((row) =>
      mapMatch(row, { hasActiveStream: playable.has(row.fixture_id) }),
    ),
    error: false,
  };
}

/**
 * A single published match, resolved by its internal fixture ID.
 *
 * The saved club crests are applied here too. This loader is reached directly
 * by the match detail page, which does not pass through the schedule path, so
 * without this the detail page rendered logos from the match row only — leaving
 * a crest that had been uploaded once in the admin Team Logo Manager missing.
 * Resolving through the same shared helper keeps both pages identical.
 */
export async function getPublicMatchByFixtureId(fixtureId: string): Promise<PublicMatch | null> {
  const client = await createSupabaseServerClient();
  if (!client) return null;
  const { data, error } = await client
    .from("matches")
    .select(MATCH_COLUMNS)
    .eq("fixture_id", fixtureId)
    .eq("published", true)
    .maybeSingle();
  if (error || !data) return null;

  const logoIndex = await loadTeamLogoIndex(client);
  return applyTeamLogos(mapMatch(data as MatchRow), logoIndex);
}