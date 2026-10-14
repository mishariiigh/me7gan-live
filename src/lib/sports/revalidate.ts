import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";
import { FIXTURE_CACHE_TAG } from "@/lib/sports/matches";

/**
 * Targeted cache invalidation after an admin mutation.
 *
 * ## Why this exists
 *
 * Public fixture data is served from a cache (see `matches.ts`). A successful
 * admin save must not leave a stale public page behind, so every mutation path
 * calls one of the helpers below.
 *
 * ## Why it is server-only and not an endpoint
 *
 * There is deliberately **no** HTTP route that triggers revalidation. A public
 * "revalidate" URL would let any anonymous visitor flush the cache at will.
 * Instead these functions are imported directly by the authenticated route
 * handlers, which have already passed `checkAdminRequest()` — so invalidation
 * can only happen as a side effect of an authorized write.
 *
 * ## Ordering
 *
 * `revalidateTag` is called *after* the database write resolves. Invalidating
 * first would let a concurrent request re-populate the cache from the
 * pre-write state, which is exactly the stale-page bug this is meant to avoid.
 */

/**
 * Invalidates every cached read of public fixture data.
 *
 * One tag covers the schedule and the live list, because both are derived from
 * the same `matches` / `fixture_streams` tables — a change to either can affect
 * both. `revalidatePath("/")` is included because the homepage renders the
 * schedule directly.
 *
 * Call this after any change to: a match, a fixture stream / broadcaster link,
 * or a team logo. It is cheap and idempotent.
 */
export function revalidateFixtureData(): void {
  // `{ expire: 0 }` means stale content is never served: the next request
  // blocks and re-renders from fresh data. That is the correct choice here —
  // an administrator who just saved a fixture expects to see it immediately,
  // not within some stale window.
  revalidateTag(FIXTURE_CACHE_TAG, { expire: 0 });
  // The pages that render fixture data. `revalidatePath` with a layout/page
  // type is not used: the tag already covers the data, and these calls only
  // ensure the route-level output is regenerated too.
  revalidatePath("/");
  revalidatePath("/upcoming");
  revalidatePath("/live");
}

/**
 * Invalidates fixture data **and** a specific match detail page.
 *
 * `fixtureId` is the internal identifier used in `/match/<id>`. Passing it
 * avoids clearing every match page when only one fixture changed.
 */
export function revalidateMatch(fixtureId?: string): void {
  revalidateFixtureData();
  if (fixtureId) revalidatePath(`/match/${fixtureId}`);
}
