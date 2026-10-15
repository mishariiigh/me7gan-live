import { purgeExpiredMatches, CLEANUP_BATCH_SIZE } from "@/lib/sports/match-cleanup";
import { revalidateFixtureData } from "@/lib/sports/revalidate";
import { safeEqual } from "@/lib/analytics";

/**
 * Scheduled cleanup of matches that kicked off more than six hours ago.
 *
 * ## Scheduling
 *
 * Invoked by Vercel Cron (see `vercel.json`). The run interval — not this
 * handler — decides how prompt the deletion is; the handler itself is stateless
 * and safe to run as often as the plan allows.
 *
 * ## Authentication
 *
 * The endpoint is protected by a server-side secret, never exposed to the
 * browser. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
 * when `CRON_SECRET` is set in the project environment; the same header can be
 * sent manually (or by any scheduler) with the same value.
 *
 *   * If `CRON_SECRET` is NOT configured, the route FAILS CLOSED with 503 and
 *     does no work. An unauthenticated cleanup endpoint would let anyone delete
 *     data, so "no secret" must mean "disabled", not "open".
 *   * The comparison is constant-time (`safeEqual`) so the secret cannot be
 *     recovered by timing.
 *   * The response never echoes the secret and never returns row contents.
 *
 * ## Visitors / analytics
 *
 * This is a server-to-server call with no browser involved: the analytics beacon
 * (`<AnalyticsBeacon />`) only runs in the browser, and `/api/analytics/collect`
 * is never called from here, so a cron run is never recorded as a visitor. The
 * proxy middleware only matches `/admin/*`, so this route is not affected by it.
 *
 * ## Safety
 *
 * The deletion logic lives in `purgeExpiredMatches` and is batch-limited and
 * repeatable. Cache invalidation afterwards makes removed fixtures disappear
 * from the homepage, /upcoming, /live and any per-match page promptly.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store" } as const;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Vercel Cron issues GET; a manual operator may also use POST. Both are handled
 * identically so the check cannot be bypassed by switching methods.
 */
export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;

  // Fail closed: no configured secret means the endpoint stays disabled.
  if (!secret) {
    return json(
      { ok: false, error: "Cleanup is not configured (missing CRON_SECRET)." },
      503,
    );
  }

  // Accept `Authorization: Bearer <secret>`. Vercel Cron sets this header from
  // the CRON_SECRET env var automatically.
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  // Constant-time compare; a missing header fails the same way as a wrong one.
  if (!provided || !safeEqual(provided, secret)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  try {
    const result = await purgeExpiredMatches({ batchSize: CLEANUP_BATCH_SIZE });

    if (result.error) {
      // A configuration/query failure is reported as such; nothing was deleted
      // unless the counts say otherwise.
      console.warn("[match-cleanup] run incomplete:", result.error);
      return json({ ok: false, ...result }, result.configured ? 500 : 503);
    }

    // Removed fixtures must vanish from cached pages immediately rather than
    // after the next revalidation window.
    if (result.deleted > 0) revalidateFixtureData();

    return json({ ok: true, ...result }, 200);
  } catch (error) {
    // Never leak an exception body; report a generic failure so a retry happens.
    console.warn("[match-cleanup] run failed:", error);
    return json({ ok: false, error: "Cleanup run failed." }, 500);
  }
}
