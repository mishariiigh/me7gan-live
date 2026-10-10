"use client";

import Link from "next/link";
import { ArrowLeft, CalendarDays, Radio, Tv } from "lucide-react";
import { useMemo, useState } from "react";
import AdSlot from "@/components/ad-slot";
import MatchCard from "@/components/match-card";
import { useLocale } from "@/components/locale-provider";
import { EmptyState } from "@/components/ui/primitives";
import type { getPublicFixtureSchedule } from "@/lib/sports/matches";
import type { PublicMatch } from "@/lib/sports/match-types";
import { BRAND } from "@/lib/brand";

type Schedule = Awaited<ReturnType<typeof getPublicFixtureSchedule>>;
type Tab = "all" | "stream" | "external";
/** Date-range filter: the primary way a visitor narrows the schedule. */
type Range = "today" | "tomorrow" | "week";

/**
 * Homepage.
 *
 * Renders only real data from Supabase. The hero features the first available
 * match (live first, then today, then tomorrow); when there is nothing to show,
 * an empty state is rendered instead of a fabricated match.
 */
export default function HomePage({
  fixtureSchedule,
  liveMatches,
}: {
  fixtureSchedule: Schedule;
  liveMatches: PublicMatch[];
}) {
  const { locale } = useLocale();
  const [tab, setTab] = useState<Tab>("all");
  const [range, setRange] = useState<Range>("week");

  const featured = liveMatches[0] ?? fixtureSchedule.today[0] ?? fixtureSchedule.tomorrow[0] ?? null;

  // "This Week" is the whole Monday..Sunday window; today and tomorrow are
  // subsets of it, so all three read the same already-loaded rows. No filter
  // triggers a request, so switching is instant and cannot disagree with the
  // server about a date boundary.
  const rangeMatches = useMemo(() => {
    if (range === "today") return fixtureSchedule.today;
    if (range === "tomorrow") return fixtureSchedule.tomorrow;
    return fixtureSchedule.week;
  }, [range, fixtureSchedule.today, fixtureSchedule.tomorrow, fixtureSchedule.week]);

  const visible = useMemo(() => {
    if (tab === "stream") return rangeMatches.filter((match) => match.hasActiveStream);
    if (tab === "external") return rangeMatches.filter((match) => !match.hasActiveStream);
    return rangeMatches;
  }, [rangeMatches, tab]);

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: locale === "ar" ? "اليوم" : "Today" },
    { id: "tomorrow", label: locale === "ar" ? "الغد" : "Tomorrow" },
    { id: "week", label: locale === "ar" ? "هذا الأسبوع" : "This week" },
  ];

  const tabs: { id: Tab; label: string }[] = [
    { id: "all", label: locale === "ar" ? "الكل" : "All" },
    { id: "stream", label: locale === "ar" ? "بث داخل الموقع" : "On-site stream" },
    { id: "external", label: locale === "ar" ? "بث رسمي" : "Official broadcast" },
  ];

  /** The week's fixtures grouped by date, Monday first, for the group headings. */
  const weekGroups = useMemo(() => {
    const byDate = new Map<string, PublicMatch[]>();
    for (const match of visible) {
      const list = byDate.get(match.matchDate) ?? [];
      list.push(match);
      byDate.set(match.matchDate, list);
    }
    // Sorted by the date string, which is already ISO-ordered, so no date
    // parsing (and no timezone conversion) is involved.
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  return (
    <main id="main-content">
      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="page-width hero-grid">
          <div className="reveal">
            <span className="hero-kicker">
              <Radio size={14} aria-hidden="true" />
              {locale === "ar" ? "كرة القدم، مباشرة" : "Football, live"}
            </span>
            <h1 className="hero-title">
              {locale === "ar" ? "جدول المباريات والبثوث المتاحة" : "Matches and available broadcasts"}
            </h1>
            <p className="hero-copy">
              {locale === "ar"
                ? `${BRAND.ar} منصة لمتابعة مباريات كرة القدم: المواعيد، البث داخل الموقع، والروابط الرسمية للناقلين.`
                : `${BRAND.en} follows football matches: fixtures, on-site streams, and official broadcaster links.`}
            </p>
            <div className="hero-actions">
              <Link className="primary-action" href="/upcoming">
                <CalendarDays size={16} aria-hidden="true" />
                {locale === "ar" ? "جدول المباريات" : "Match schedule"}
              </Link>
              <Link className="secondary-action" href="/live">
                <Radio size={16} aria-hidden="true" />
                {locale === "ar" ? "مباشر الآن" : "Live now"}
              </Link>
            </div>

            <div className="hero-stats">
              <div className="hero-stat">
                <b>{fixtureSchedule.today.length}</b>
                <span>{locale === "ar" ? "مباريات اليوم" : "Today"}</span>
              </div>
              <div className="hero-stat">
                <b>{fixtureSchedule.tomorrow.length}</b>
                <span>{locale === "ar" ? "مباريات الغد" : "Tomorrow"}</span>
              </div>
              <div className="hero-stat">
                <b>{liveMatches.length}</b>
                <span>{locale === "ar" ? "بث متاح الآن" : "Live streams"}</span>
              </div>
            </div>
          </div>

          <div className="hero-panel reveal">
            {featured ? (
              <MatchCard
                match={featured}
                variant="featured"
                live={liveMatches.some((item) => item.fixtureId === featured.fixtureId)}
              />
            ) : (
              <EmptyState
                icon={<CalendarDays size={20} />}
                title={locale === "ar" ? "لا توجد مباريات منشورة حالياً" : "No published matches yet"}
                description={locale === "ar" ? "ستظهر المباريات هنا بمجرد نشرها من لوحة الإدارة." : "Matches appear here once published from the admin panel."}
              />
            )}
          </div>
        </div>
      </section>

      {/* ── LIVE NOW ──────────────────────────────────────────────────── */}
      <section className="content-section page-width">
        <div className="section-heading">
          <div>
            <span className="eyebrow">{locale === "ar" ? "البث المتاح" : "ON AIR"}</span>
            <h2>{locale === "ar" ? "مباشر الآن" : "Live now"}</h2>
          </div>
          <Link href="/live">
            {locale === "ar" ? "عرض الكل" : "Browse all"} <ArrowLeft size={15} aria-hidden="true" />
          </Link>
        </div>

        {liveMatches.length > 0 ? (
          <div className="match-grid match-grid-2">
            {liveMatches.map((match) => (
              <MatchCard key={match.fixtureId} match={match} live />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Radio size={20} />}
            title={locale === "ar" ? "لا يوجد بث متاح في هذه اللحظة" : "No broadcasts available right now"}
            description={locale === "ar" ? "المباريات التي يُتاح لها بث أو رابط رسمي ستظهر هنا." : "Matches with a stream or official link appear here."}
            action={<Link className="text-action" href="/upcoming">{locale === "ar" ? "تصفح المباريات" : "Browse matches"} <ArrowLeft size={14} aria-hidden="true" /></Link>}
          />
        )}
      </section>

      {/* ── ADVERTISEMENT ─────────────────────────────────────────────────
          Sits between two content sections, well clear of match cards,
          navigation and any control a visitor might click expecting a stream. */}
      <div className="page-width">
        <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_HOME} label={locale === "ar" ? "إعلان" : "Advertisement"} />
      </div>

      {/* ── UPCOMING ──────────────────────────────────────────────────── */}
      <section className="content-section page-width">
        <div className="section-heading">
          <div>
            <span className="eyebrow">{locale === "ar" ? "التالي" : "NEXT UP"}</span>
            <h2>{locale === "ar" ? "جدول المباريات" : "Match schedule"}</h2>
          </div>
          <Link href="/upcoming">
            {locale === "ar" ? "الجدول الكامل" : "Full schedule"} <ArrowLeft size={15} aria-hidden="true" />
          </Link>
        </div>

        {/* Primary filter: which dates to show. */}
        <div
          className="range-tabs"
          role="tablist"
          aria-label={locale === "ar" ? "نطاق التاريخ" : "Date range"}
        >
          {ranges.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={range === id ? "range-tab active" : "range-tab"}
              onClick={() => setRange(id)}
              aria-selected={range === id}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Secondary filter: how the match is broadcast. */}
        {rangeMatches.length > 0 && (
          <div className="filter-bar" role="group" aria-label={locale === "ar" ? "تصفية المباريات" : "Filter matches"}>
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "filter-chip active" : "filter-chip"}
                onClick={() => setTab(id)}
                aria-pressed={tab === id}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {visible.length > 0 ? (
          // Grouped by date for every range, so "This Week" reads as a browsable
          // Monday..Sunday schedule and Today/Tomorrow stay single groups.
          weekGroups.map(([date, matches]) => (
            <DateGroup
              key={date}
              title={dateLabel(date, fixtureSchedule, locale)}
              date={date}
              matches={matches}
              locale={locale}
            />
          ))
        ) : (
          <EmptyState
            icon={<Tv size={20} />}
            title={emptyTitle(range, locale)}
            description={
              range === "today"
                ? (locale === "ar" ? "لا توجد مباريات مجدولة اليوم. جرّب الغد أو هذا الأسبوع." : "No fixtures today. Try tomorrow or this week.")
                : range === "tomorrow"
                  ? (locale === "ar" ? "لا توجد مباريات مجدولة غداً. جرّب هذا الأسبوع." : "No fixtures tomorrow. Try this week.")
                  : (locale === "ar" ? "لا توجد مباريات منشورة في هذا الأسبوع." : "No published fixtures this week.")
            }
          />
        )}
      </section>
    </main>
  );
}

/** Empty-state heading that names the range the visitor is looking at. */
function emptyTitle(range: Range, locale: "ar" | "en") {
  if (range === "today") return locale === "ar" ? "لا توجد مباريات اليوم" : "No matches today";
  if (range === "tomorrow") return locale === "ar" ? "لا توجد مباريات غداً" : "No matches tomorrow";
  return locale === "ar" ? "لا توجد مباريات هذا الأسبوع" : "No matches this week";
}

/**
 * Heading for a date group: "Today", "Tomorrow", or the formatted date.
 *
 * Comparison is on the ISO date string, so no timezone conversion happens and a
 * fixture at 00:30 is never filed under the wrong day.
 */
function dateLabel(date: string, schedule: Schedule, locale: "ar" | "en") {
  if (date === schedule.todayDate) return locale === "ar" ? "اليوم" : "Today";
  if (date === schedule.tomorrowDate) return locale === "ar" ? "الغد" : "Tomorrow";
  return locale === "ar" ? "" : "";
}

function DateGroup({
  title,
  date,
  matches,
  locale,
}: {
  title: string;
  date: string;
  matches: PublicMatch[];
  locale: "ar" | "en";
}) {
  if (matches.length === 0) return null;

  // Formatted from a UTC-anchored midnight so the label always names the same
  // calendar day the fixture is stored against, in every visitor timezone.
  const label = new Intl.DateTimeFormat(locale === "ar" ? "ar-SA" : "en-GB", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

  return (
    <section className="date-group">
      <div className="date-group-heading">
        <h3>{title || label}</h3>
        <span>{title ? label : ""}</span>
        <span className="date-group-count">{matches.length}</span>
      </div>
      <div className="match-grid">
        {matches.map((match) => (
          <MatchCard key={match.fixtureId} match={match} />
        ))}
      </div>
    </section>
  );
}