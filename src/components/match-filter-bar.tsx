"use client";

import { Search, Star, X } from "lucide-react";
import { useId } from "react";
import { useLocale } from "@/components/locale-provider";
import { ALL_COMPETITIONS, type CompetitionFilter } from "@/lib/sports/match-filtering";
import type { Competition } from "@/lib/sports/competitions";

/**
 * The shared filter surface: competition chips, team search, and the favourites
 * toggle.
 *
 * Every control here filters data that is already on the client, so no
 * interaction triggers a Supabase query. The chips are rendered from the
 * competitions actually present in the current date range, derived from the
 * canonical `COMPETITIONS` config rather than a duplicated list.
 */
export default function MatchFilterBar({
  competitions,
  competition,
  onCompetitionChange,
  query,
  onQueryChange,
  favouritesOnly,
  onFavouritesOnlyChange,
  favouriteCount,
  resultCount,
}: {
  /** Competitions present in the current pool, in canonical order. */
  competitions: Competition[];
  competition: CompetitionFilter;
  onCompetitionChange: (value: CompetitionFilter) => void;
  query: string;
  onQueryChange: (value: string) => void;
  favouritesOnly: boolean;
  onFavouritesOnlyChange: (value: boolean) => void;
  favouriteCount: number;
  resultCount: number;
}) {
  const { locale } = useLocale();
  const searchId = useId();
  const isArabic = locale === "ar";

  // A chip is only offered when the current date range actually contains that
  // competition, so a visitor can never filter down to an empty list.
  const options: { id: CompetitionFilter; label: string }[] = [
    { id: ALL_COMPETITIONS, label: isArabic ? "الكل" : "All" },
    ...competitions.map((name) => ({ id: name as CompetitionFilter, label: name })),
  ];

  return (
    <div className="match-filters">
      {/* Horizontal scroll on mobile; `overflow-x: auto` is confined to this
          strip so the page itself never gains a horizontal scrollbar.

          Hidden entirely when the caller supplies no competitions — on a
          competition page the route already selects one, so a row containing
          only "All" would be a control that does nothing. */}
      {competitions.length > 0 && (
        <div
          className="chip-scroller"
          role="group"
          aria-label={isArabic ? "تصفية حسب البطولة" : "Filter by competition"}
        >
          {options.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={competition === id ? "filter-chip active" : "filter-chip"}
              onClick={() => onCompetitionChange(id)}
              aria-pressed={competition === id}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="match-filters-row">
        <div className="search-field">
          <label className="sr-only" htmlFor={searchId}>
            {isArabic ? "ابحث عن فريق" : "Search for a team"}
          </label>
          <Search size={15} aria-hidden="true" className="search-field-icon" />
          <input
            id={searchId}
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder={isArabic ? "ابحث عن فريق… مثال: برشلونة أو Barcelona" : "Search a team… e.g. Barcelona"}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              onClick={() => onQueryChange("")}
              aria-label={isArabic ? "مسح البحث" : "Clear search"}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <button
          type="button"
          className={favouritesOnly ? "filter-chip favourites-toggle active" : "filter-chip favourites-toggle"}
          onClick={() => onFavouritesOnlyChange(!favouritesOnly)}
          aria-pressed={favouritesOnly}
        >
          <Star size={14} aria-hidden="true" />
          {isArabic ? "فرقي المفضلة" : "My teams"}
          {favouriteCount > 0 && <span className="filter-chip-count">{favouriteCount}</span>}
        </button>
      </div>

      {/* Announced for screen readers, and the visible count doubles as the
          "you filtered everything out" signal. */}
      <p className="match-filters-status" role="status" aria-live="polite">
        {isArabic
          ? `${resultCount} مباراة مطابقة`
          : `${resultCount} matching ${resultCount === 1 ? "match" : "matches"}`}
      </p>
    </div>
  );
}
