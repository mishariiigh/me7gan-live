"use client";

import Link from "next/link";
import { CalendarDays, Radio, Star } from "lucide-react";
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
  filterMatches,
  groupByDateAndCompetition,
  prioritiseFavourites,
  type CompetitionFilter,
} from "@/lib/sports/match-filtering";

type Schedule = Awaited<ReturnType<typeof getPublicFixtureSchedule>>;

/**
 * The fixture list on a competition page.
 *
 * Reuses `FixtureGroups` and `MatchFilterBar` rather than reimplementing match
 * cards, so a competition page looks and behaves exactly like the homepage
 * list. Within a competition the chip row would be redundant (every fixture is
 * the same competition), so only search and favourites are offered here — the
 * visitor is already on the competition they chose.
 */
export default function CompetitionFixtures({
  matches,
  schedule,
}: {
  matches: PublicMatch[];
  schedule: Schedule;
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";
  const [query, setQuery] = useState("");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const { favourites, isFavourite, toggleFavourite } = useFavourites();

  // Search and favourites combine with each other, and both operate on the
  // competition's fixtures the server already sent — no extra request.
  const visible = useMemo(() => {
    const filtered = filterMatches(matches, {
      // The competition is fixed by the route, so it is never filtered again.
      competition: ALL_COMPETITIONS as CompetitionFilter,
      query,
      favouritesOnly,
      favourites,
    });
    return prioritiseFavourites(filtered, favourites);
  }, [matches, query, favouritesOnly, favourites]);

  if (matches.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays size={20} />}
        title={isArabic ? "لا توجد مباريات في هذه البطولة هذا الأسبوع" : "No fixtures in this competition this week"}
        description={
          isArabic
            ? "لم تُنشر أي مباريات لهذه البطولة في الأسبوع الحالي. تحقق من الجدول الكامل."
            : "No fixtures for this competition have been published for the current week. Check the full schedule."
        }
        action={
          <Link className="text-action" href="/upcoming">
            {isArabic ? "الجدول الكامل" : "Full schedule"}
          </Link>
        }
      />
    );
  }

  return (
    <>
      <MatchFilterBar
        // No competition chips: the route already selects one.
        competitions={[]}
        competition={ALL_COMPETITIONS}
        onCompetitionChange={() => { }}
        query={query}
        onQueryChange={setQuery}
        favouritesOnly={favouritesOnly}
        onFavouritesOnlyChange={setFavouritesOnly}
        favouriteCount={favourites.size}
        resultCount={visible.length}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={<Star size={20} />}
          title={isArabic ? "لا توجد مباريات مطابقة" : "No matching matches"}
          description={
            isArabic ? "جرّب مسح البحث أو إلغاء تصفية المفضلة." : "Try clearing the search or the favourites filter."
          }
          action={
            <button
              type="button"
              className="text-action"
              onClick={() => {
                setQuery("");
                setFavouritesOnly(false);
              }}
            >
              {isArabic ? "مسح التصفية" : "Clear filters"}
            </button>
          }
        />
      ) : (
        <FixtureGroups
          groups={groupByDateAndCompetition(visible)}
          todayDate={schedule.todayDate}
          tomorrowDate={schedule.tomorrowDate}
          favourites={{ isFavourite, toggleFavourite }}
        />
      )}

      <p className="competition-window-note">
        <Radio size={13} aria-hidden="true" />
        {isArabic
          ? "تُعرض مباريات الأسبوع الحالي فقط."
          : "Showing fixtures for the current week only."}
      </p>
    </>
  );
}
