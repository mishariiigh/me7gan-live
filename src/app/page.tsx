import HomePage from "@/components/home-page";
import { getLiveMatches, getPublicFixtureSchedule } from "@/lib/sports/matches";

// Cached via the tag-invalidated loaders in `lib/sports/matches.ts`. An admin
// save calls `revalidateFixtureData()`, so this page is never stale for long
// without being re-rendered on every request.
//
// Deliberately no clock read here: `Date.now()` during render would make the
// output non-cacheable and is flagged by the React purity rule. Which fixture
// is "next" is decided on the client instead, from the same cached schedule.

export default async function Home() {
  const [fixtureSchedule, live] = await Promise.all([
    getPublicFixtureSchedule(),
    getLiveMatches(),
  ]);
  return (
    <HomePage fixtureSchedule={fixtureSchedule} liveMatches={live.matches} />
  );
}