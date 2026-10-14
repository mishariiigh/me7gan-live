"use client";

import MatchCard, { type FavouritesProps } from "@/components/match-card";
import { useLocale } from "@/components/locale-provider";
import type { DateGroup } from "@/lib/sports/match-filtering";

/**
 * Fixtures grouped by date, and by competition within each date.
 *
 * Grouping is done by the caller with `groupByDateAndCompetition`, which
 * partitions rather than filters — every match passed in is rendered exactly
 * once, so a fixture can never be silently dropped.
 *
 * Shared by the homepage, /upcoming and the competition pages so the list looks
 * identical everywhere and there is only one implementation to maintain.
 */
export default function FixtureGroups({
  groups,
  todayDate,
  tomorrowDate,
  live = false,
  favourites,
  admin,
  onLinksChanged,
}: {
  groups: DateGroup[];
  todayDate?: string;
  tomorrowDate?: string;
  live?: boolean;
  /** Optional favourites wiring, forwarded to each match card. */
  favourites?: FavouritesProps;
  /** Present only for a confirmed administrator; forwarded to each card. */
  admin?: { enabled: boolean };
  /** Called after an inline link edit, so the page can refresh its data. */
  onLinksChanged?: (fixtureId: string) => void;
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";

  return (
    <>
      {groups.map((group) => {
        const title =
          group.date === todayDate
            ? isArabic ? "مباريات اليوم" : "Today"
            : group.date === tomorrowDate
              ? isArabic ? "مباريات الغد" : "Tomorrow"
              : isArabic ? "مباريات قادمة" : "Upcoming";

        const label = new Intl.DateTimeFormat(isArabic ? "ar-SA" : "en-GB", {
          dateStyle: "full",
          timeZone: "UTC",
        }).format(new Date(`${group.date}T00:00:00Z`));

        return (
          <section className="date-group" key={group.date}>
            <div className="date-group-heading">
              <h3>{title}</h3>
              <span>{label}</span>
              <span className="date-group-count">{group.total}</span>
            </div>

            {/* One competition heading per group, so a date with three leagues
                reads as three scannable blocks instead of one long list. */}
            {group.competitions.map((entry) => (
              <div className="competition-group" key={entry.competition ?? "other"}>
                {entry.competition && (
                  <h4 className="competition-group-heading">
                    <span>{entry.competition}</span>
                    <span className="competition-group-count">{entry.matches.length}</span>
                  </h4>
                )}
                <div className="match-grid">
                  {entry.matches.map((match) => (
                    <MatchCard
                      key={match.fixtureId}
                      match={match}
                      live={live}
                      favourites={favourites}
                      admin={admin}
                      onLinksChanged={onLinksChanged}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
