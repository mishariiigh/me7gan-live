"use client";

import { CalendarDays, Radio } from "lucide-react";
import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import { useLocale } from "@/components/locale-provider";
import { CompetitionBadge, TeamDisplay } from "@/components/ui/primitives";
import { getKickoffInstant, type PublicMatch } from "@/lib/sports/match-types";

/**
 * Compact "next match" panel shown on the homepage when nothing is live.
 *
 * Replaces the large empty "Live now" block, so the page does not reserve
 * vertical space for content that does not exist.
 *
 * Two things are deliberate:
 *
 * 1. **The clock lives here, on the client, not on the server.** Which fixture
 *    is "next" depends on the current time; deciding it during the server render
 *    would make the page uncacheable and is flagged by the React purity rule.
 * 2. **The countdown is derived from the real kickoff instant** — never
 *    invented. If a kickoff cannot be parsed, the countdown is omitted rather
 *    than guessed at.
 */

/* ── A ticking clock, as an external store ────────────────────────────────
 * The current time is external state, not component state. Modelling it with
 * `useSyncExternalStore` gives a server snapshot of `null` (so the server and
 * the first client render agree — no hydration mismatch) and an interval-driven
 * client snapshot, without setting state inside an effect. */

const TICK_MS = 30_000;
let currentTime: number | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
const tickListeners = new Set<() => void>();

function subscribeToClock(onChange: () => void) {
  tickListeners.add(onChange);
  if (intervalId === null) {
    // One shared timer for every subscriber, not one per component.
    intervalId = setInterval(() => {
      currentTime = Date.now();
      for (const listener of tickListeners) listener();
    }, TICK_MS);
  }
  return () => {
    tickListeners.delete(onChange);
    if (tickListeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
      currentTime = null;
    }
  };
}

function getClientTime(): number | null {
  if (currentTime === null) currentTime = Date.now();
  return currentTime;
}

/** Server snapshot: no time, so nothing countdown-related renders on the server. */
const getServerTime = () => null;

/** Whole minutes until `targetIso`, or null when it cannot be determined. */
function minutesUntil(targetIso: string, nowMs: number): number | null {
  const target = Date.parse(targetIso);
  if (Number.isNaN(target)) return null;
  return Math.floor((target - nowMs) / 60_000);
}

/** Human countdown, e.g. "2h 15m". Minutes only beyond 24h. */
function formatCountdown(totalMinutes: number, isArabic: boolean): string | null {
  if (totalMinutes < 0) return null;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (isArabic) {
    if (days > 0) return `${days} يوم و ${hours} س`;
    if (hours > 0) return `${hours} س ${minutes} د`;
    return `${minutes} د`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function NextMatchPanel({ matches }: { matches: PublicMatch[] }) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";
  const now = useSyncExternalStore(subscribeToClock, getClientTime, getServerTime);

  // `now` is null on the server and on the first client render, so this is null
  // there too — the server renders the panel without a countdown.
  const match = useMemo(() => {
    if (now === null) return null;
    return (
      matches.find((candidate) => {
        const kickoff = Date.parse(getKickoffInstant(candidate.matchDate, candidate.kickoffTime));
        return Number.isFinite(kickoff) && kickoff > now;
      }) ?? null
    );
  }, [matches, now]);

  // No upcoming fixture at all (not merely "not yet known"): a compact empty
  // state rather than reserved space for nothing.
  if (matches.length === 0) {
    return (
      <section className="content-section page-width">
        <div className="next-match next-match-empty">
          <span className="eyebrow">
            <CalendarDays size={13} aria-hidden="true" />
            {isArabic ? "المباراة القادمة" : "NEXT MATCH"}
          </span>
          <p>
            {isArabic
              ? "لا توجد مباريات قادمة في هذا الأسبوع. تابع الجدول لاحقاً."
              : "No upcoming fixtures this week. Check the schedule again soon."}
          </p>
          <Link className="text-action" href="/upcoming">
            {isArabic ? "عرض الجدول" : "View schedule"}
          </Link>
        </div>
      </section>
    );
  }

  // Fixtures exist but all have kicked off: nothing to count down to. Omit the
  // panel entirely rather than count down to a past kickoff.
  if (!match) return null;

  const remaining = minutesUntil(getKickoffInstant(match.matchDate, match.kickoffTime), now ?? 0);
  const countdown = remaining === null ? null : formatCountdown(remaining, isArabic);

  return (
    <section className="content-section page-width">
      <div className="next-match">
        <div className="next-match-head">
          <span className="eyebrow">
            <CalendarDays size={13} aria-hidden="true" />
            {isArabic ? "المباراة القادمة" : "NEXT MATCH"}
          </span>
          {countdown && (
            <span className="next-match-countdown" role="status" aria-live="polite">
              <Radio size={13} aria-hidden="true" />
              {isArabic ? `تبدأ بعد ${countdown}` : `Starts in ${countdown}`}
            </span>
          )}
        </div>

        <Link className="next-match-body" href={`/match/${match.fixtureId}`}>
          <div className="next-match-team">
            <TeamDisplay name={match.home.name} logo={match.home.logo} size="md" />
          </div>
          <div className="next-match-meta">
            <CompetitionBadge competition={match.competition} />
            <span className="next-match-kickoff">
              <span className="ltr">{match.kickoffLabel}</span>
              <span className="next-match-date">
                {new Intl.DateTimeFormat(isArabic ? "ar-SA" : "en-GB", {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(new Date(`${match.matchDate}T00:00:00Z`))}
              </span>
            </span>
          </div>
          <div className="next-match-team">
            <TeamDisplay name={match.away.name} logo={match.away.logo} size="md" />
          </div>
        </Link>
      </div>
    </section>
  );
}
