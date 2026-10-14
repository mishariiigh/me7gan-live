"use client";

import { useCallback, useState } from "react";
import MatchesListing from "@/components/matches-listing";
import { useLivePolling } from "@/components/use-live-polling";
import type { getPublicFixtureSchedule } from "@/lib/sports/matches";
import type { PublicMatch } from "@/lib/sports/match-types";

type Schedule = Awaited<ReturnType<typeof getPublicFixtureSchedule>>;

/**
 * The /live listing with periodic refresh.
 *
 * Polling is **only** enabled on this page. Everywhere else the time-based data
 * cache keeps fixtures fresh enough without a timer, so mounting this component
 * is what opts a route into continuous updates. See `use-live-polling` for the
 * visibility, overlap and cleanup guarantees.
 */
export default function LiveMatches({
  fixtureSchedule,
  initialMatches,
}: {
  fixtureSchedule: Schedule;
  initialMatches: PublicMatch[];
}) {
  // Seeded from the server render, so the first paint already has fixtures and
  // the first poll only replaces them if something actually changed.
  const [matches, setMatches] = useState<PublicMatch[]>(initialMatches);

  const fetcher = useCallback(async (): Promise<PublicMatch[]> => {
    const res = await fetch("/api/live", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`live feed ${res.status}`);
    const body = (await res.json()) as { matches?: PublicMatch[] };
    return body.matches ?? [];
  }, []);

  const { failed } = useLivePolling({ enabled: true, fetcher, onMatches: setMatches });

  return (
    <>
      {/* A refresh failure must be visible but must not remove the fixtures
          already on screen — they remain the best information available. */}
      {failed && (
        <p className="live-refresh-note" role="status">
          تعذّر تحديث البث الآن. المحتوى المعروض قد يكون غير محدّث.
        </p>
      )}
      <MatchesListing fixtureSchedule={fixtureSchedule} matches={matches} mode="live" />
    </>
  );
}
