"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Fire-and-forget page-view beacon.
 *
 * Why a client component
 * ----------------------
 * The site's pages are statically generated and cached; counting views in a
 * server component would force every page dynamic and hurt the caching the
 * rest of the site depends on. So the page view is reported from the browser,
 * after mount, to `/api/analytics/collect`.
 *
 * Not double-counting
 * -------------------
 * Three separate guards keep one real navigation to exactly one beacon:
 *   1. React Strict Mode (dev) mounts effects twice — the `lastSentRef` guard
 *      makes the second run a no-op for the same path.
 *   2. A re-render that does not change the path sends nothing, because the
 *      effect only fires when `pathname` changes.
 *   3. A browser refresh / back-forward restore of the *same* path within a
 *      short window is suppressed, so a reload does not inflate the count.
 *
 * Privacy
 * -------
 * Only the pathname is sent. No cookies, no identifiers, no query string. The
 * server derives a daily, rotating pseudonym from headers it already sees. The
 * response is ignored, and every failure — offline, 503, missing configuration
 * — is swallowed so analytics can never break a page or surface an error.
 */

/** Suppress a repeat beacon for the same path within this window (ms). */
const DEDUPE_WINDOW_MS = 3000;

export default function AnalyticsBeacon() {
  const pathname = usePathname();
  const lastSentRef = useRef<{ path: string; at: number } | null>(null);

  useEffect(() => {
    if (!pathname) return;

    const now = Date.now();
    const last = lastSentRef.current;
    // Same path fired again within the dedupe window → almost certainly a
    // Strict Mode double-invoke or a quick refresh. Skip it.
    if (last && last.path === pathname && now - last.at < DEDUPE_WINDOW_MS) return;
    lastSentRef.current = { path: pathname, at: now };

    const body = JSON.stringify({ path: pathname });

    // `keepalive` lets the request survive a navigation that starts immediately
    // after it (common when a visitor clicks away quickly).
    void fetch("/api/analytics/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      // Explicitly ignore credentials: the server reads the admin session from
      // cookies itself, and we never want to attach anything client-side.
      credentials: "same-origin",
    }).catch(() => {
      /* Analytics is best-effort; a failure must never affect the page. */
    });
  }, [pathname]);

  return null;
}
