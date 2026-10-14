import { unstable_cache } from "data:text/javascript,export const unstable_cache=(fn)=>fn;export const revalidateTag=()=>{};export const revalidatePath=()=>{};export const revalidate=()=>{}";
import { createPublicSupabaseClient, createSupabaseServerClient } from "data:text/javascript,let c=globalThis.__FAKE_DB__;export async function createSupabaseServerClient(){return c?c():null}export function createPublicSupabaseClient(){return c?c():null}";
import { applyTeamLogos, loadTeamLogoIndex } from "file:///Users/M10/Desktop/developer/LiveStreamWebsite/.live-logos-test-build/src_lib_sports_team-logos-2.mjs";
import { formatKickoffTime, getKickoffInstant, getNextScheduleDate, getScheduleDate, getWeekBounds, } from "file:///Users/M10/Desktop/developer/LiveStreamWebsite/.live-logos-test-build/src_lib_sports_match-types-2.mjs";
export { MATCH_TIMEZONE, getWeekBounds } from "file:///Users/M10/Desktop/developer/LiveStreamWebsite/.live-logos-test-build/src_lib_sports_match-types-2.mjs";
/**
 * Cache tags for public fixture data.
 *
 * Every cached read is tagged so an admin mutation can invalidate exactly the
 * data it changed with `revalidateTag` — see `revalidateFixtureData`.
 */
export const FIXTURE_CACHE_TAG = "public-fixtures";
/**
 * How long public fixture data may be served before a background refresh.
 *
 * Short enough that a newly published match appears promptly even if an
 * invalidation were missed, long enough that a busy schedule is not re-queried
 * on every request. Live status is deliberately excluded from this window: the
 * /live page re-reads the stream table on its own shorter cadence.
 */
export const FIXTURE_REVALIDATE_SECONDS = 60;
/**
 * Live-status window. Deliberately much shorter than the schedule window: a
 * match going live is the one thing visitors notice immediately.
 */
export const LIVE_REVALIDATE_SECONDS = 15;
/**
 * An anonymous Supabase client for cached public reads.
 *
 * Deliberately NOT `createSupabaseServerClient()`: that reads `cookies()`,
 * which Next.js forbids inside a cache scope. Public fixture data is readable
 * by the `anon` role under the existing RLS policies, and it does not vary by
 * visitor, so an anonymous client produces exactly the right (and cacheable)
 * result. Nothing here can read private data — the anon key plus RLS is the
 * same boundary an unauthenticated browser already has.
 */
const createPublicClient = createPublicSupabaseClient;
const MATCH_COLUMNS = "id, fixture_id, match_date, kickoff_time, competition, home_team, away_team, home_team_logo, away_team_logo, published, created_at, updated_at";
/** Today's calendar date in the project timezone. Never hard-coded. */
export function getTodayScheduleDate() {
    return getScheduleDate();
}
/** Tomorrow's calendar date in the project timezone. Never hard-coded. */
export function getTomorrowScheduleDate() {
    return getNextScheduleDate(getTodayScheduleDate());
}
function mapMatch(row, options = {}) {
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
async function withActiveStreamFlag(rows, client) {
    if (rows.length === 0)
        return [];
    // Stored club crests are resolved once for the whole page, then applied to
    // every fixture. This is what makes a logo uploaded once appear on all past
    // and future matches involving that club.
    const logoIndex = await loadTeamLogoIndex(client);
    if (!client)
        return rows.map((row) => applyTeamLogos(mapMatch(row), logoIndex));
    const fixtureIds = rows.map((row) => row.fixture_id);
    const { data, error } = await client
        .from("fixture_streams")
        .select("fixture_id")
        .in("fixture_id", fixtureIds)
        .eq("active", true);
    if (error || !data)
        return rows.map((row) => applyTeamLogos(mapMatch(row), logoIndex));
    const streamed = new Set(data.map((row) => row.fixture_id));
    return rows.map((row) => applyTeamLogos(mapMatch(row, { hasActiveStream: streamed.has(row.fixture_id) }), logoIndex));
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
export async function getPublicFixtureSchedule() {
    return getCachedFixtureSchedule();
}
/**
 * The cached schedule read.
 *
 * Wrapped in `unstable_cache` rather than relying on route-level static
 * generation, because the Supabase client reads cookies (for auth) and would
 * otherwise make every page request-rendered. Caching here means the homepage,
 * /upcoming and the competition pages all share ONE query result per minute
 * instead of one per request.
 *
 * Tagged with `FIXTURE_CACHE_TAG`, so an admin save can drop it immediately via
 * `revalidateTag` rather than waiting for the window to elapse.
 *
 * The function takes no arguments on purpose. `unstable_cache` serialises its
 * arguments to build the cache key, and the Supabase client contains circular
 * references — passing one in threw "Converting circular structure to JSON".
 * Creating the client inside the cached scope is fine here because only public,
 * anonymous data is read: an anonymous client is used regardless of who is
 * signed in, so the result does not vary per visitor.
 */
const getCachedFixtureSchedule = unstable_cache(async () => {
    const todayDate = getTodayScheduleDate();
    const tomorrowDate = getTomorrowScheduleDate();
    const { weekStartDate, weekEndDate } = getWeekBounds(todayDate);
    const queryEndDate = tomorrowDate > weekEndDate ? tomorrowDate : weekEndDate;
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
    // A plain anonymous client. Public fixture data is readable by `anon` under
    // the existing RLS policies, and creating the client here avoids touching
    // `cookies()`, which is not allowed inside a cache scope. The result is
    // therefore identical for every visitor, which is what makes sharing the
    // cache entry correct.
    const client = createPublicClient();
    if (!client)
        return empty;
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
    if (error)
        return { ...empty, error: true };
    const rows = (data ?? []);
    const withStreams = await withActiveStreamFlag(rows, client);
    return {
        today: withStreams.filter((match) => match.matchDate === todayDate),
        tomorrow: withStreams.filter((match) => match.matchDate === tomorrowDate),
        // The week window is a superset of today+tomorrow, so it is filtered from
        // the same rows: no second query, and no chance of the two disagreeing.
        week: withStreams.filter((match) => match.matchDate >= weekStartDate &&
            match.matchDate <= weekEndDate),
        weekStartDate,
        weekEndDate,
        todayDate,
        tomorrowDate,
        error: false,
    };
}, 
// The cache key includes the date because the window is computed from today:
// without it, the entry cached just before midnight would be reused into the
// next day and show the previous week.
["public-fixture-schedule", getTodayScheduleDate()], { revalidate: FIXTURE_REVALIDATE_SECONDS, tags: [FIXTURE_CACHE_TAG] });
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
export async function getLiveMatches() {
    return getCachedLiveMatches();
}
/**
 * Live matches, cached for a much shorter window than the schedule.
 *
 * Going live is time-sensitive, so the revalidate window is deliberately brief —
 * long enough to collapse the burst of requests a popular page gets, short
 * enough that a stream starting is visible almost immediately. Tagged with the
 * fixture tag so an admin change invalidates it too.
 *
 * Takes no arguments, for the same reason as `getCachedFixtureSchedule`: the
 * cache key is built by serialising the arguments, and a Supabase client is not
 * serialisable. The data read is public and anonymous, so it is identical for
 * every visitor and safe to share across requests.
 */
const getCachedLiveMatches = unstable_cache(async () => {
    const client = createPublicClient();
    if (!client)
        return { matches: [], error: false };
    const { data: streamRows, error: streamError } = await client
        .from("fixture_streams")
        .select("fixture_id, stream_type")
        .eq("active", true)
        .range(0, 999);
    if (streamError)
        return { matches: [], error: true };
    const rows = (streamRows ?? []);
    const fixtureIds = [...new Set(rows.map((row) => row.fixture_id))];
    if (fixtureIds.length === 0)
        return { matches: [], error: false };
    const playable = new Set(rows.filter((row) => row.stream_type === "hls" || row.stream_type === "embed").map((row) => row.fixture_id));
    const { data, error } = await client
        .from("matches")
        .select(MATCH_COLUMNS)
        .eq("published", true)
        .in("fixture_id", fixtureIds)
        .order("match_date", { ascending: true })
        .order("kickoff_time", { ascending: true });
    if (error)
        return { matches: [], error: true };
    // Saved club crests must be resolved here exactly as the schedule and
    // detail loaders do. This is the only path that requires an active
    // broadcaster link to reach a match, so without it every match on /live
    // lost both team logos the moment a link was added — the logo only ever
    // came from the match row, never from the `teams` table.
    const logoIndex = await loadTeamLogoIndex(client);
    return {
        matches: data.map((row) => applyTeamLogos(mapMatch(row, { hasActiveStream: playable.has(row.fixture_id) }), logoIndex)),
        error: false,
    };
}, ["public-live-matches"], { revalidate: LIVE_REVALIDATE_SECONDS, tags: [FIXTURE_CACHE_TAG] });
/**
 * A single published match, resolved by its internal fixture ID.
 *
 * The saved club crests are applied here too. This loader is reached directly
 * by the match detail page, which does not pass through the schedule path, so
 * without this the detail page rendered logos from the match row only — leaving
 * a crest that had been uploaded once in the admin Team Logo Manager missing.
 * Resolving through the same shared helper keeps both pages identical.
 */ export async function getPublicMatchByFixtureId(fixtureId) {
    const client = await createSupabaseServerClient();
    if (!client)
        return null;
    const { data, error } = await client
        .from("matches")
        .select(MATCH_COLUMNS)
        .eq("fixture_id", fixtureId)
        .eq("published", true)
        .maybeSingle();
    if (error || !data)
        return null;
    const logoIndex = await loadTeamLogoIndex(client);
    return applyTeamLogos(mapMatch(data), logoIndex);
}
/**
 * The soonest published fixture that has not kicked off yet.
 *
 * Computed on the server so the homepage does not have to call `Date.now()`
 * during render. The comparison is against the real kickoff instant in the
 * project timezone (`getKickoffInstant`), so a fixture stored as a local date
 * and time is compared correctly.
 *
 * Accepts an already-loaded schedule rather than querying again: the homepage
 * has the whole week in hand, so this is pure selection over that data and
 * costs no extra Supabase request.
 *
 * Returns `null` when nothing in the window is still ahead — the caller then
 * renders an empty state rather than inventing a fixture.
 */
/**
 * The soonest published fixture that has not kicked off yet, given an explicit
 * `nowMs`.
 *
 * Kept as a pure helper for testing and for callers that already know the time.
 * The homepage does **not** call this during render — reading the clock while
 * rendering would make the page uncacheable — it decides "next" on the client
 * inside `NextMatchPanel` instead.
 *
 * The comparison uses the real kickoff instant in the project timezone
 * (`getKickoffInstant`), so a fixture stored as a local date and time is
 * compared correctly. Returns `null` when nothing in the window is ahead.
 */
export function findNextUpcomingMatch(schedule, nowMs) {
    const seen = new Set();
    for (const match of [...schedule.today, ...schedule.week]) {
        if (seen.has(match.fixtureId))
            continue;
        seen.add(match.fixtureId);
        const kickoff = Date.parse(getKickoffInstant(match.matchDate, match.kickoffTime));
        if (Number.isFinite(kickoff) && kickoff > nowMs)
            return match;
    }
    return null;
}
/**
 * Every published fixture for one competition.
 *
 * Reads from the **same cached schedule** rather than issuing a competition-
 * scoped query: the week's fixtures are already in memory, so filtering them
 * costs nothing and guarantees a competition page can never disagree with the
 * homepage about what is scheduled.
 *
 * The window is the current Monday..Sunday week, which is the same window the
 * schedule uses. Matches outside it are not included — the page says so rather
 * than implying a complete season archive that does not exist.
 */
export async function getCompetitionFixtures(competition) {
    const schedule = await getPublicFixtureSchedule();
    const matches = [...schedule.today, ...schedule.tomorrow, ...schedule.week]
        // A fixture can appear in more than one window (today is inside week), so
        // de-duplicate by fixture id — a competition page must not list a match twice.
        .filter((match, index, all) => all.findIndex((other) => other.fixtureId === match.fixtureId) === index)
        .filter((match) => match.competition === competition)
        .sort((a, b) => a.matchDate === b.matchDate
        ? a.kickoffTime.localeCompare(b.kickoffTime)
        : a.matchDate.localeCompare(b.matchDate));
    return { matches, schedule };
}
