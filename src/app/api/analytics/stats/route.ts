import { requireAdminResponse } from "@/lib/auth/require-admin";
import { createServiceSupabaseClient } from "@/lib/supabase/service";
import { ANALYTICS_TIME_ZONE, analyticsDay } from "@/lib/analytics";

/**
 * Admin-only visitor statistics for "today" (Asia/Riyadh calendar day).
 *
 * Access model
 * ------------
 *   * Authorisation is enforced HERE, server-side, by `requireAdminResponse()`
 *     (session cookie → user → `profiles.role === 'admin'`). A visitor without
 *     an admin session gets 403 and never reaches the database.
 *   * The read uses the SERVICE-ROLE client, which bypasses RLS. That key is
 *     read from `SUPABASE_SERVICE_ROLE_KEY` (no `NEXT_PUBLIC_` prefix), so it
 *     cannot be inlined into a client bundle. Nothing sensitive — no key, no
 *     visitor hashes, no IPs — is ever included in the response.
 *   * The response is `no-store` so a CDN cannot cache one admin's numbers and
 *     serve them to someone else.
 *
 * Failure behaviour
 * -----------------
 *   * Missing configuration (no service key) → 503 with `configured: false`.
 *     The dashboard renders "not configured" instead of zeros, so a missing
 *     setup is never mistaken for "zero visitors".
 *   * Query error (e.g. migration 011 not applied yet) → 503 with
 *     `configured: true` and the reason. Again: no fabricated numbers.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" } as const;

/** Recent-activity window for the "online now" figure, in minutes. */
const ONLINE_WINDOW_MINUTES = 5;

export async function GET() {
  // 1. Authorise before doing any work at all.
  const denied = await requireAdminResponse();
  if (denied) return denied;

  // 2. Fail closed when the server-only key is absent. This is the same check
  //    the collect route uses, so "record" and "read" are enabled together.
  const client = createServiceSupabaseClient();
  if (!client) {
    return Response.json(
      {
        configured: false,
        error: "Analytics is not configured (missing SUPABASE_SERVICE_ROLE_KEY).",
      },
      { status: 503, headers: NO_STORE },
    );
  }

  const day = analyticsDay();
  const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MINUTES * 60 * 1000).toISOString();

  try {
    // 3. Two narrow queries instead of one aggregate view: they are cheap with
    //    `site_visits_day_idx`, and keep the schema reviewable (see migration).
    //    Admin traffic is excluded so the owner's own browsing never inflates
    //    the figures — matching the `is_admin` flag written by the collect route.
    const [visitorsResult, viewsResult, onlineResult] = await Promise.all([
      // Unique visitors = distinct daily hashes. `head: true` + count avoids
      // transferring rows at all.
      client
        .from("site_visits")
        .select("visitor_hash", { count: "exact", head: true })
        .eq("visited_on", day)
        .eq("is_admin", false),
      // Page views = sum of per-row view counts. The column is NOT the row count,
      // because repeat visits to the same path increment `view_count`.
      client.from("site_visits").select("view_count").eq("visited_on", day).eq("is_admin", false),
      // "Online now" = distinct hashes seen inside the recent window.
      client
        .from("site_visits")
        .select("visitor_hash", { count: "exact", head: true })
        .eq("visited_on", day)
        .eq("is_admin", false)
        .gte("last_seen_at", onlineSince),
    ]);

    const error = visitorsResult.error ?? viewsResult.error ?? onlineResult.error;
    if (error) {
      // Most commonly: migration 011 has not been applied, so the table (or the
      // `record_site_visit` RPC) does not exist yet.
      console.warn("[analytics] stats query failed:", error.message);
      return Response.json(
        {
          configured: true,
          available: false,
          error: "Analytics tables are not available yet.",
          detail: error.message,
        },
        { status: 503, headers: NO_STORE },
      );
    }

    const pageViews = (viewsResult.data ?? []).reduce(
      (total, row) => total + (row.view_count ?? 0),
      0,
    );

    // NOTE on "unique visitors": the count above is the number of distinct
    // daily hashes, i.e. distinct (user-agent, IP) pairs for the day. It is an
    // approximation — see the limitations note in the admin UI.
    return Response.json(
      {
        configured: true,
        available: true,
        day,
        timeZone: ANALYTICS_TIME_ZONE,
        uniqueVisitors: visitorsResult.count ?? 0,
        pageViews,
        onlineNow: onlineResult.count ?? 0,
        onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    // Never leak an exception to the client; report "unavailable", not zeros.
    console.warn("[analytics] stats failed:", error);
    return Response.json(
      { configured: true, available: false, error: "Analytics request failed." },
      { status: 503, headers: NO_STORE },
    );
  }
}
