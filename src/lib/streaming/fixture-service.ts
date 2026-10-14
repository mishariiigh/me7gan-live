import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicSupabaseClient } from "@/lib/supabase/server";
import { DatabaseFixtureStreamProvider } from "@/lib/streaming/fixture-provider";
import type { AuthorizedFixtureStreams } from "@/lib/streaming/fixture-stream-types";
import { FIXTURE_CACHE_TAG, LIVE_REVALIDATE_SECONDS } from "@/lib/sports/matches";

/**
 * The authorized sources for one fixture.
 *
 * Cached, and tagged with the same fixture tag the admin mutations already
 * revalidate. Without this the match page re-queried Supabase on every single
 * request, which is what made it measurably slower than the cached public
 * pages. A short window is used because a stream can be enabled or switched by
 * an administrator at any time, and `revalidateTag` makes that instant anyway.
 *
 * The anonymous client is used deliberately: the query reads only `active`
 * rows, which the existing RLS policy exposes to `anon`, and the result does
 * not vary by visitor — so sharing the cache entry is correct. This is the same
 * approach the public fixture loaders use.
 */
export async function getAuthorizedStream(fixtureId: string): Promise<AuthorizedFixtureStreams> {
  return getCachedAuthorizedStream(fixtureId);
}

const getCachedAuthorizedStream = unstable_cache(
  async (fixtureId: string): Promise<AuthorizedFixtureStreams> => {
    const client = createPublicSupabaseClient();
    if (!client) return { primary: null, fallbacks: [] };
    return new DatabaseFixtureStreamProvider(client).getAuthorizedStream(fixtureId);
  },
  // The fixture id is part of the key, so each match caches independently.
  ["authorized-stream"],
  { revalidate: LIVE_REVALIDATE_SECONDS, tags: [FIXTURE_CACHE_TAG] },
);