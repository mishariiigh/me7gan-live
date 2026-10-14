"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Polls the live-matches endpoint while the visitor is on /live and the tab is
 * visible.
 *
 * ## Why only here
 *
 * Live scores are the one place where continuous updates are worth a request:
 * a visitor watching a match expects the list to change. Everywhere else
 * (home, /upcoming, match detail, admin) the data is static enough that the
 * time-based cache handles it, and polling there would only burn bandwidth.
 *
 * ## The rules this follows
 *
 * - **Paused when the tab is hidden.** A background tab makes no requests; the
 *   interval resumes on `visibilitychange`. This is the single biggest saving
 *   for a visitor who leaves the page open.
 * - **Never overlapping.** The next tick is scheduled only *after* the current
 *   request settles, so a slow response cannot stack up requests.
 * - **Cleaned up on unmount.** Both the timer and the visibility listener are
 *   removed, so navigating away stops all work.
 * - **No render churn.** The result is stored in state and only replaced when
 *   the payload actually changed, so an unchanged poll does not re-render the
 *   list.
 * - **Failures are silent after the first.** A transient network error must not
 *   spam the console, and must not clear the fixtures already on screen.
 */

/** How often to refresh while visible. 30s is comfortably inside a live feel. */
const POLL_INTERVAL_MS = 30_000;

/** True while the document is visible; false in a background tab. */
function subscribeToVisibility(onChange: () => void) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getVisibleSnapshot() {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

/** Server snapshot: assume visible so the server render is deterministic. */
const getServerVisible = () => true;

/**
 * Polls `getLive` for fresh matches.
 *
 * @param enabled     false disables polling entirely (used off /live).
 * @param onMatches   receives each successful, *changed* payload.
 */
export function useLivePolling<T>({
  enabled,
  fetcher,
  onMatches,
}: {
  enabled: boolean;
  /** Returns the latest live matches, or throws on failure. */
  fetcher: () => Promise<T[]>;
  /** Called only when the payload differs from the previous one. */
  onMatches: (matches: T[]) => void;
}): { refreshing: boolean; failed: boolean } {
  const visible = useSyncExternalStore(subscribeToVisibility, getVisibleSnapshot, getServerVisible);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  // Refs, not state: changing these must not re-create the timer.
  const fetcherRef = useRef(fetcher);
  const onMatchesRef = useRef(onMatches);
  const previousJson = useRef<string | null>(null);
  const inFlight = useRef(false);

  // Keep the latest callbacks without restarting the effect on every render.
  useEffect(() => {
    fetcherRef.current = fetcher;
    onMatchesRef.current = onMatches;
  });

  const poll = useCallback(async () => {
    // Guard against overlap: a tick that fires while the previous request is
    // still open is dropped rather than queued.
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const matches = await fetcherRef.current();
      const json = JSON.stringify(matches);
      // Only notify when something actually changed, so an unchanged poll does
      // not cause a re-render of the whole list.
      if (json !== previousJson.current) {
        previousJson.current = json;
        onMatchesRef.current(matches);
      }
      setFailed(false);
    } catch {
      // Report the failure to the UI once; never log per attempt, which would
      // spam the console for every dropped connection.
      setFailed(true);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !visible) return;

    let timer: ReturnType<typeof setTimeout>;

    // A self-rescheduling timeout, not `setInterval`: the next tick is only
    // booked once the previous one has settled, which is what guarantees the
    // requests cannot overlap even if one takes longer than the interval.
    const scheduleNext = (delayMs: number) => {
      timer = setTimeout(async () => {
        await poll();
        scheduleNext(POLL_INTERVAL_MS);
      }, delayMs);
    };

    // The first tick is scheduled rather than awaited synchronously: calling
    // `poll()` directly here would set state during the effect, which React
    // flags. A zero-delay timeout also means becoming visible refreshes at once
    // instead of showing data that may be minutes old.
    scheduleNext(0);

    return () => clearTimeout(timer);
  }, [enabled, visible, poll]);

  return { refreshing, failed };
}
