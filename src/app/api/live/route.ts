import { getLiveMatches } from "@/lib/sports/matches";

/**
 * Public live-match feed, used by the /live page poller.
 *
 * Reads through `getLiveMatches`, which is cached and tagged, so a poll every
 * 30 seconds from many visitors collapses into far fewer Supabase queries. The
 * endpoint never touches private data and never reads the request's cookies, so
 * its response is identical for every visitor.
 *
 * The response is explicitly non-cacheable at the HTTP layer: the freshness
 * window lives in the data cache (a hard 15s, set on `getLiveMatches`), and
 * letting a CDN also cache it would make "when did this go live" unpredictable.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { matches, error } = await getLiveMatches();

  if (error) {
    // A read failure must not look like "no live matches" — that would hide
    // fixtures from a visitor because of a transient database problem.
    return Response.json(
      { error: "live_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    {
      matches: matches.map((match) => ({
        fixtureId: match.fixtureId,
        matchDate: match.matchDate,
        kickoffTime: match.kickoffTime,
        kickoffLabel: match.kickoffLabel,
        competition: match.competition,
        home: match.home,
        away: match.away,
        hasActiveStream: match.hasActiveStream,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
