"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Radio, Star, Tv } from "lucide-react";
import { useCallback, useMemo, useState, useTransition } from "react";
import AdSlot from "@/components/ad-slot";
import FixtureGroups from "@/components/fixture-groups";
import MatchCard from "@/components/match-card";
import MatchFilterBar from "@/components/match-filter-bar";
import NextMatchPanel from "@/components/next-match-panel";
import { useFavourites } from "@/components/use-favourites";
import { useAdminSession } from "@/components/use-admin-session";
import { useLocale } from "@/components/locale-provider";
import { EmptyState } from "@/components/ui/primitives";
import type { getPublicFixtureSchedule } from "@/lib/sports/matches";
import type { PublicMatch } from "@/lib/sports/match-types";
import {
  ALL_COMPETITIONS,
  availableCompetitions,
  filterMatches,
  groupByDateAndCompetition,
  prioritiseFavourites,
  type CompetitionFilter,
} from "@/lib/sports/match-filtering";
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
  const isArabic = locale === "ar";
  const [tab, setTab] = useState<Tab>("all");
  const [range, setRange] = useState<Range>("week");
  const [competition, setCompetition] = useState<CompetitionFilter>(ALL_COMPETITIONS);
  const [query, setQuery] = useState("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const { favourites, isFavourite, toggleFavourite } = useFavourites();
  // Admin controls are offered only after the SERVER confirms the session (see
  // the hook). A regular visitor never renders them, and the server authorises
  // every write again regardless of what the UI shows.
  const { isAdmin } = useAdminSession();
  const router = useRouter();
  const [, startRefresh] = useTransition();

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

  // Chips come from the rows currently in view, so selecting "today" never
  // offers a competition that only plays tomorrow.
  const competitionOptions = useMemo(() => availableCompetitions(rangeMatches), [rangeMatches]);

  const filtered = useMemo(
    () =>
      filterMatches(rangeMatches, {
        competition,
        query,
        favouritesOnly,
        favourites,
      }),
    [rangeMatches, competition, query, favouritesOnly, favourites],
  );

  const visible = useMemo(() => {
    const byTab =
      tab === "stream"
        ? filtered.filter((match) => match.hasActiveStream)
        : tab === "external"
          ? filtered.filter((match) => !match.hasActiveStream)
          : filtered;
    // Favourites float to the top without hiding anything else.
    return prioritiseFavourites(byTab, favourites);
  }, [filtered, tab, favourites]);

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: isArabic ? "اليوم" : "Today" },
    { id: "tomorrow", label: isArabic ? "الغد" : "Tomorrow" },
    { id: "week", label: isArabic ? "هذا الأسبوع" : "This week" },
  ];

  const tabs: { id: Tab; label: string }[] = [
    { id: "all", label: isArabic ? "الكل" : "All" },
    { id: "stream", label: isArabic ? "بث داخل الموقع" : "On-site stream" },
    { id: "external", label: isArabic ? "بث رسمي" : "Official broadcast" },
  ];

  /** The week's fixtures grouped by date then competition, for the headings. */
  const weekGroups = useMemo(() => groupByDateAndCompetition(visible), [visible]);

  // Which fixture is "next" depends on the current time, so it is resolved on
  // the client (`useSyncExternalStore`) rather than during the server render —
  // reading the clock while rendering would make the page non-cacheable and is
  // flagged by the React purity rule.
  const upcomingPool = useMemo(() => {
    const seen = new Set<string>();
    return [...fixtureSchedule.today, ...fixtureSchedule.week].filter((match) => {
      if (seen.has(match.fixtureId)) return false;
      seen.add(match.fixtureId);
      return true;
    });
  }, [fixtureSchedule.today, fixtureSchedule.week]);

  const favouritesProps = { isFavourite, toggleFavourite };
  const adminProps = isAdmin ? { enabled: true } : undefined;
  const hasLive = liveMatches.length > 0;
  const filtersActive = competition !== ALL_COMPETITIONS || query.trim() !== "" || favouritesOnly;

  /**
   * Re-fetches the server component after an inline link edit.
   *
   * `router.refresh()` re-renders the page with fresh data without losing
   * client state (filters, search, favourites), so the edited card updates
   * immediately instead of requiring a manual reload. Wrapped in a transition
   * so React keeps the current UI visible while the refresh is in flight.
   */
  const handleLinksChanged = useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

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
                admin={adminProps}
                onLinksChanged={handleLinksChanged}
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

      {/* ── LIVE NOW, or the next match ──────────────────────────────────
          When nothing is live the full section is replaced by a compact
          next-match panel, so the page never reserves a large empty area. */}
      {hasLive ? (
        <section className="content-section page-width">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{isArabic ? "البث المتاح" : "ON AIR"}</span>
              <h2>{isArabic ? "مباشر الآن" : "Live now"}</h2>
            </div>
            <Link href="/live">
              {isArabic ? "عرض الكل" : "Browse all"} <ArrowLeft size={15} aria-hidden="true" />
            </Link>
          </div>

          <div className="match-grid match-grid-2">
            {liveMatches.map((match) => (
              <MatchCard
                key={match.fixtureId}
                match={match}
                live
                favourites={favouritesProps}
                admin={adminProps}
                onLinksChanged={handleLinksChanged}
              />
            ))}
          </div>
        </section>
      ) : (
        <NextMatchPanel matches={upcomingPool} />
      )}

      {/* ── ADVERTISEMENT ─────────────────────────────────────────────────
          Sits between two content sections, well clear of match cards,
          navigation and any control a visitor might click expecting a stream. */}
      <div className="page-width">
        <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_HOME} label={isArabic ? "إعلان" : "Advertisement"} />
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

        <MatchFilterBar
          competitions={competitionOptions}
          competition={competition}
          onCompetitionChange={setCompetition}
          query={query}
          onQueryChange={setQuery}
          favouritesOnly={favouritesOnly}
          onFavouritesOnlyChange={setFavouritesOnly}
          favouriteCount={favourites.size}
          resultCount={visible.length}
        />

        {/* Secondary filter: how the match is broadcast. */}
        {rangeMatches.length > 0 && (
          <div className="filter-bar" role="group" aria-label={isArabic ? "تصفية المباريات" : "Filter matches"}>
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
          // Grouped by date, then by competition, so "This Week" reads as a
          // browsable Monday..Sunday schedule.
          <FixtureGroups
            groups={weekGroups}
            todayDate={fixtureSchedule.todayDate}
            tomorrowDate={fixtureSchedule.tomorrowDate}
            favourites={favouritesProps}
            admin={adminProps}
            onLinksChanged={handleLinksChanged}
          />
        ) : (
          <EmptyState
            icon={filtersActive ? <Star size={20} /> : <Tv size={20} />}
            title={
              filtersActive
                ? isArabic ? "لا توجد مباريات مطابقة" : "No matching matches"
                : emptyTitle(range, isArabic)
            }
            description={
              filtersActive
                ? isArabic
                  ? "جرّب تغيير البطولة أو مسح البحث أو اختيار نطاق تاريخ أوسع."
                  : "Try another competition, clear the search, or widen the date range."
                : range === "today"
                  ? isArabic ? "لا توجد مباريات مجدولة اليوم. جرّب الغد أو هذا الأسبوع." : "No fixtures today. Try tomorrow or this week."
                  : range === "tomorrow"
                    ? isArabic ? "لا توجد مباريات مجدولة غداً. جرّب هذا الأسبوع." : "No fixtures tomorrow. Try this week."
                    : isArabic ? "لا توجد مباريات منشورة في هذا الأسبوع." : "No published fixtures this week."
            }
            action={
              filtersActive ? (
                <button
                  type="button"
                  className="text-action"
                  onClick={() => {
                    setCompetition(ALL_COMPETITIONS);
                    setQuery("");
                    setFavouritesOnly(false);
                  }}
                >
                  {isArabic ? "مسح التصفية" : "Clear filters"}
                </button>
              ) : undefined
            }
          />
        )}
      </section>
    </main>
  );
}

/** Empty-state heading that names the range the visitor is looking at. */
function emptyTitle(range: Range, isArabic: boolean) {
  if (range === "today") return isArabic ? "لا توجد مباريات اليوم" : "No matches today";
  if (range === "tomorrow") return isArabic ? "لا توجد مباريات غداً" : "No matches tomorrow";
  return isArabic ? "لا توجد مباريات هذا الأسبوع" : "No matches this week";
}