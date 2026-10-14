"use client";

import { CalendarDays, Radio, Tv } from "lucide-react";
import { useMemo, useState } from "react";
import FixtureGroups from "@/components/fixture-groups";
import MatchFilterBar from "@/components/match-filter-bar";
import { useFavourites } from "@/components/use-favourites";
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

type Schedule = Awaited<ReturnType<typeof getPublicFixtureSchedule>>;
type Filter = "all" | "stream" | "external";
type Range = "today" | "tomorrow" | "week";

/**
 * Shared schedule listing used by /upcoming and /live.
 *
 * `live` mode additionally shows external-only matches, so an official
 * broadcaster link is never hidden just because there is no on-site stream.
 *
 * Every filter below operates on rows the server already sent — switching a
 * chip, typing in the search box or toggling favourites never issues a request.
 */
export default function MatchesListing({
  fixtureSchedule,
  matches,
  mode = "schedule",
}: {
  fixtureSchedule?: Schedule;
  matches?: PublicMatch[];
  mode?: "schedule" | "live";
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";
  const [filter, setFilter] = useState<Filter>("all");
  const [range, setRange] = useState<Range>("week");
  const [competition, setCompetition] = useState<CompetitionFilter>(ALL_COMPETITIONS);
  const [query, setQuery] = useState("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const { favourites, isFavourite, toggleFavourite } = useFavourites();

  // The full pool for the mode: /live shows only what is on air, the schedule
  // shows the whole published week (today and tomorrow are subsets of it).
  const pool = useMemo(() => {
    if (mode === "live") return matches ?? [];
    if (!fixtureSchedule) return [];
    return fixtureSchedule.week;
  }, [fixtureSchedule, matches, mode]);

  const rangeMatches = useMemo(() => {
    if (mode === "live") return pool;
    if (!fixtureSchedule) return pool;
    if (range === "today") return fixtureSchedule.today;
    if (range === "tomorrow") return fixtureSchedule.tomorrow;
    return fixtureSchedule.week;
  }, [pool, range, fixtureSchedule, mode]);

  const competitionOptions = useMemo(() => availableCompetitions(rangeMatches), [rangeMatches]);

  const filtered = useMemo(
    () => filterMatches(rangeMatches, { competition, query, favouritesOnly, favourites }),
    [rangeMatches, competition, query, favouritesOnly, favourites],
  );

  const visible = useMemo(() => {
    const byType =
      filter === "stream"
        ? filtered.filter((match) => match.hasActiveStream)
        : filter === "external"
          ? filtered.filter((match) => !match.hasActiveStream)
          : filtered;
    return prioritiseFavourites(byType, favourites);
  }, [filtered, filter, favourites]);

  const groups = useMemo(() => groupByDateAndCompetition(visible), [visible]);

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: isArabic ? "الكل" : "All" },
    { id: "stream", label: isArabic ? "بث داخل الموقع" : "On-site stream" },
    { id: "external", label: isArabic ? "بث رسمي" : "Official broadcast" },
  ];

  const ranges: { id: Range; label: string }[] = [
    { id: "today", label: isArabic ? "اليوم" : "Today" },
    { id: "tomorrow", label: isArabic ? "الغد" : "Tomorrow" },
    { id: "week", label: isArabic ? "هذا الأسبوع" : "This week" },
  ];

  const todayDate = fixtureSchedule?.todayDate;
  const tomorrowDate = fixtureSchedule?.tomorrowDate;
  const filtersActive = competition !== ALL_COMPETITIONS || query.trim() !== "" || favouritesOnly;

  if (pool.length === 0) {
    return (
      <EmptyState
        icon={mode === "live" ? <Radio size={20} /> : <CalendarDays size={20} />}
        title={
          mode === "live"
            ? isArabic ? "لا يوجد بث متاح الآن" : "No broadcasts available right now"
            : isArabic ? "لا توجد مباريات منشورة" : "No published matches"
        }
        description={
          isArabic
            ? "ستظهر المباريات هنا بمجرد نشرها من لوحة الإدارة."
            : "Matches appear here once published from the admin panel."
        }
      />
    );
  }

  return (
    <>
      {mode === "schedule" && (
        <div className="range-tabs" role="tablist" aria-label={isArabic ? "نطاق التاريخ" : "Date range"}>
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
      )}

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

      <div className="filter-bar" role="group" aria-label={isArabic ? "تصفية المباريات" : "Filter matches"}>
        {filters.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={filter === id ? "filter-chip active" : "filter-chip"}
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
          >
            {label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<Tv size={20} />}
          title={isArabic ? "لا توجد مباريات مطابقة" : "No matching matches"}
          description={
            isArabic ? "جرّب تغيير البطولة أو مسح البحث أو اختيار نطاق أوسع." : "Try another competition, clear the search, or widen the range."
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
      ) : (
        <FixtureGroups
          groups={groups}
          todayDate={todayDate}
          tomorrowDate={tomorrowDate}
          live={mode === "live"}
          favourites={{ isFavourite, toggleFavourite }}
        />
      )}
    </>
  );
}
