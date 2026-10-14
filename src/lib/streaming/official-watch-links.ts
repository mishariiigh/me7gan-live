import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicSupabaseClient } from "@/lib/supabase/server";
import { FIXTURE_CACHE_TAG, LIVE_REVALIDATE_SECONDS } from "@/lib/sports/matches";

export type OfficialWatchLink = {
  id: string;
  fixture_id: string;
  country_region: string;
  broadcaster_name: string;
  official_watch_url: string;
};

/**
 * Official broadcaster links for one fixture.
 *
 * Cached for the same reason as the stream lookup: it is public, anonymous,
 * visitor-independent data, and it was previously re-queried on every match-page
 * request. Tagged with the fixture tag, so an admin edit invalidates it at once.
 */
export async function getOfficialWatchLinks(fixtureId: string): Promise<OfficialWatchLink[]> {
  return getCachedOfficialWatchLinks(fixtureId);
}

const getCachedOfficialWatchLinks = unstable_cache(
  async (fixtureId: string): Promise<OfficialWatchLink[]> => {
    const client = createPublicSupabaseClient();
    if (!client) return [];

    const { data, error } = await client
      .from("official_watch_links")
      .select("id, fixture_id, country_region, broadcaster_name, official_watch_url")
      .eq("fixture_id", fixtureId)
      .eq("active", true)
      .order("country_region", { ascending: true })
      .order("broadcaster_name", { ascending: true });

    if (error || !data) return [];
    return data as OfficialWatchLink[];
  },
  ["official-watch-links"],
  { revalidate: LIVE_REVALIDATE_SECONDS, tags: [FIXTURE_CACHE_TAG] },
);