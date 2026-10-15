import { createServiceSupabaseClient } from "@/lib/supabase/service";
import { createSupabaseServerClient, getServerUser } from "@/lib/supabase/server";
import { analyticsDay, looksLikeBot, normalizePath, safeEqual, visitorHash } from "@/lib/analytics";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Records one page view.
 *
 * Called by the `<AnalyticsBeacon />` client component on navigation. It is
 * deliberately tiny, fire-and-forget and FAIL-SAFE: the beacon ignores the
 * response, and this handler returns 204 even when recording fails, so a
 * broken analytics setup can never surface an error to a visitor or slow a
 * page down.
 *
 * Security / privacy notes
 * ------------------------
 *   * Runs on the server. The browser never sees the service-role key, and the
 *     visitor's IP is read from the connection headers here — it is used to
 *     derive the daily hash and for rate limiting, then discarded. It is NOT
 *     written to the database.
 *   * The request body is validated and bounded. Only a path string is read
 *     from it; nothing from the body is trusted as an identifier.
 *   * Admin sessions are recorded but flagged `is_admin = true`, and the stats
 *     endpoint excludes them, so the owner's own browsing does not inflate the
 *     visitor count.
 */

const NO_CONTENT = { "cache-control": "no-store" } as const;

/** Statuses the beacon may receive; all are swallowed client-side. */
function noContent() {
  return new Response(null, { status: 204, headers: NO_CONTENT });
}

/**
 * True when the request carries the scheduled-cleanup secret.
 *
 * Compared in constant time so the secret cannot be probed via this route. If
 * `CRON_SECRET` is unset, no request can match and the check is a no-op.
 */
function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return provided.length > 0 && safeEqual(provided, secret);
}

export async function POST(request: Request) {
  // Everything below is wrapped so an unexpected throw still yields 204. An
  // analytics failure must be invisible to the visitor.
  try {
    // Scheduled/server-to-server callers must never be counted as visitors. A
    // cron invocation (or any operator replay of it) carries the cleanup secret
    // in `Authorization`. If that value matches the configured secret, this is
    // unmistakably automation, not a browser, so it is dropped. This is a
    // belt-and-braces guard: the cron endpoint never calls this route, and a
    // cron client sends no browser user-agent, which `looksLikeBot` already
    // rejects.
    if (isCronRequest(request)) return noContent();

    const userAgent = request.headers.get("user-agent") ?? "";
    if (looksLikeBot(userAgent)) return noContent();

    // Identify the client for the daily hash and the rate limiter. These
    // headers are set by the platform edge; the values are never persisted.
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = request.headers.get("x-real-ip") ?? forwarded ?? "unknown";

    // Bound the write rate per IP so a scripted client cannot flood the table
    // even if it forges a browser-like user-agent. 120/min is far above any
    // human navigation pattern. A limited request is silently dropped.
    const limit = await checkRateLimit(ip, "analytics-collect", 120, 60);
    if (!limit.success) return noContent();

    const client = createServiceSupabaseClient();
    // No service key configured → analytics is simply off. Still 204 so the
    // site behaves identically with or without the feature.
    if (!client) return noContent();

    const body = await request.json().catch(() => null);
    const path = normalizePath(body?.path);

    // Admin detection: a valid admin session must be excluded from visitor
    // counts. This is the authoritative check (server-side session + role),
    // not a client hint, so it cannot be spoofed by the browser.
    let isAdmin = false;
    const sessionClient = await createSupabaseServerClient();
    if (sessionClient) {
      const { user } = await getServerUser(sessionClient);
      if (user) {
        const { data: profile } = await sessionClient
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();
        isAdmin = profile?.role === "admin";
      }
    }

    const day = analyticsDay();
    const hash = visitorHash({ day, userAgent, ip });

    // Upsert on the unique (visitor_hash, visited_on, path) index: a refresh or
    // repeat navigation increments `view_count` on the same row instead of
    // inserting a duplicate. This is what makes "one visitor per day" hold even
    // if the beacon fires more than once.
    const { error } = await client.rpc("record_site_visit", {
      p_visitor_hash: hash,
      p_visited_on: day,
      p_path: path,
      p_is_admin: isAdmin,
    });

    if (error) {
      // Table missing or RPC absent → feature not provisioned. Log once at a
      // low volume and keep the site unaffected.
      console.warn("[analytics] visit not recorded:", error.message);
    }
  } catch (error) {
    console.warn("[analytics] collect failed:", error);
  }
  return noContent();
}
