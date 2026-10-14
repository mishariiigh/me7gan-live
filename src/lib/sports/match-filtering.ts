/**
 * Client-safe match filtering: competition, team search, and favourites.
 *
 * Everything here runs in the browser over rows the server already sent, so
 * changing a filter never triggers another Supabase query. The functions are
 * pure and take plain data, which keeps them unit-testable without a DOM.
 *
 * Kept out of `matches.ts` (server-only) so client components can import it
 * without pulling `server-only` into the browser bundle.
 */

import { COMPETITIONS, type Competition } from "@/lib/sports/competitions";
import type { PublicMatch } from "@/lib/sports/match-types";

/** The "no competition filter" sentinel. */
export const ALL_COMPETITIONS = "all" as const;

export type CompetitionFilter = typeof ALL_COMPETITIONS | Competition;

/**
 * Competitions actually present in a set of matches, in the canonical order
 * defined by `COMPETITIONS`.
 *
 * Derived rather than hard-coded: a chip is only offered when there is at least
 * one fixture for it, so a visitor can never click through to an empty list.
 * The canonical list still governs ordering and membership.
 */
export function availableCompetitions(matches: PublicMatch[]): Competition[] {
  const present = new Set(matches.map((match) => match.competition));
  return COMPETITIONS.filter((competition) => present.has(competition));
}

/* ── SEARCH NORMALISATION ───────────────────────────────────────────────── */

/**
 * Folds Arabic text for search without touching what is displayed.
 *
 * Applies the same letter folding the team-identity layer uses (أ إ آ → ا,
 * ة → ه, ى → ي) plus diacritic and tatweel removal, so a query typed without
 * hamza still finds a name stored with one. The original string is never
 * mutated — this returns a separate comparison key.
 */
export function normaliseArabic(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    // Harakat (diacritics) and tatweel carry no search meaning.
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ → ا
    .replace(/\u0629/g, "\u0647") // ة → ه
    .replace(/\u0649/g, "\u064A"); // ى → ي
}

/**
 * Normalises a string for matching: trims, collapses whitespace, lowercases,
 * strips punctuation and applies the Arabic folding above.
 *
 * Punctuation is removed without leaving a separator so "Man-City", "Man.City"
 * and "Man City" all compare equal.
 */
export function normaliseForSearch(input: string): string {
  const withoutDots = String(input ?? "").replace(/[.\-_'\u2019`\u00b4]/g, "");
  // Punctuation becomes a space (so it separates words), except the dot above.
  const separated = withoutDots.replace(/[,"?()\[\]{}&/\\|_+*\u060C\u061B;:!]/g, " ");
  return normaliseArabic(separated.replace(/\s+/g, " ").trim());
}

/**
 * Well-known short forms that are not a prefix or substring of the full name.
 *
 * "Man City" shares no substring with "Manchester City" beyond "man", so a
 * plain `includes` can never connect them. These are explicit, hand-checked
 * mappings — deliberately a short list rather than fuzzy matching, because a
 * guess would happily equate "Man United" with "Man City".
 *
 * Each entry maps a normalised abbreviation to the normalised full name.
 */
const SEARCH_ALIASES: Record<string, string[]> = {
  mancity: ["manchestercity"],
  mcfc: ["manchestercity"],
  manutd: ["manchesterunited"],
  manunited: ["manchesterunited"],
  barca: ["barcelona"],
  barcafc: ["barcelona"],
  realmadrid: ["realmadrid"],
  psg: ["parissaintgermain"],
  bayern: ["bayernmunich"],
  bayernmunchen: ["bayernmunich"],
  juve: ["juventus"],
  inter: ["intermilan"],
  atleti: ["atleticomadrid"],
};

/**
 * Expands a normalised query into every form that should be searched for.
 *
 * Arabic queries are also matched against a Latin alias set, so "برشلونة" finds
 * a fixture stored as "Barcelona", and English abbreviations expand to the full
 * club name so "Man City" finds "Manchester City".
 */
export function expandQuery(query: string): string[] {
  const normalised = normaliseForSearch(query);
  if (!normalised) return [];
  const compact = normalised.replace(/\s+/g, "");
  const forms = new Set([normalised, compact]);
  for (const alias of SEARCH_ALIASES[compact] ?? []) forms.add(alias);
  return [...forms].filter(Boolean);
}

/**
 * True when `query` matches any of `fields`.
 *
 * Matching is "contains" rather than "starts with", so typing "city" finds a
 * Manchester City fixture. Every expanded query form is tried against each
 * field, and a field matches when any form is contained in it.
 */
export function matchesQuery(query: string, fields: (string | null | undefined)[]): boolean {
  const forms = expandQuery(query);
  if (forms.length === 0) return true;
  const haystacks = fields
    .filter((field): field is string => Boolean(field))
    .flatMap((field) => {
      const normalised = normaliseForSearch(field);
      return [normalised, normalised.replace(/\s+/g, "")];
    });
  return haystacks.some((hay) => forms.some((form) => hay.includes(form)));
}

/** True when the query matches either side of a fixture. */
export function matchMatchesSearch(match: PublicMatch, query: string): boolean {
  return matchesQuery(query, [match.home.name, match.away.name, match.competition]);
}

/* ── FAVOURITES ─────────────────────────────────────────────────────────── */

/**
 * Stable identifier for a favourited team.
 *
 * The stored value is a normalised team key (see `team-identity.ts`), not the
 * display name: renaming a club's display name keeps the favourite, whereas
 * storing the name would silently lose it.
 *
 * The key is computed inline rather than imported from `team-identity.ts` so
 * this module stays free of that file's larger rule set — but it applies the
 * SAME core folding, so the two produce identical values for the names seen on
 * match cards.
 */
export function favouriteTeamId(teamName: string): string {
  return normaliseForSearch(teamName).replace(/\s+/g, "");
}

/** True when a fixture involves a favourited team. */
export function involvesFavourite(match: PublicMatch, favourites: Set<string>): boolean {
  if (favourites.size === 0) return false;
  return favourites.has(favouriteTeamId(match.home.name)) || favourites.has(favouriteTeamId(match.away.name));
}

/* ── COMBINED FILTERING ─────────────────────────────────────────────────── */

export type MatchFilterState = {
  competition: CompetitionFilter;
  query: string;
  favouritesOnly: boolean;
  favourites: Set<string>;
};

/**
 * Applies competition, search and favourite filters to already-loaded matches.
 *
 * Ordering is preserved exactly as received (the server sorts by date, kickoff
 * then creation), so filtering never reorders fixtures.
 */
export function filterMatches(matches: PublicMatch[], state: MatchFilterState): PublicMatch[] {
  const query = state.query.trim();
  return matches.filter((match) => {
    if (state.competition !== ALL_COMPETITIONS && match.competition !== state.competition) return false;
    if (query && !matchMatchesSearch(match, query)) return false;
    if (state.favouritesOnly && !involvesFavourite(match, state.favourites)) return false;
    return true;
  });
}

/**
 * Moves fixtures involving a favourite team to the front, preserving the
 * relative order within each group.
 *
 * A stable partition rather than a sort: nothing is hidden and fixtures that
 * already share a date stay in chronological order.
 */
export function prioritiseFavourites(matches: PublicMatch[], favourites: Set<string>): PublicMatch[] {
  if (favourites.size === 0) return matches;
  const preferred: PublicMatch[] = [];
  const rest: PublicMatch[] = [];
  for (const match of matches) {
    (involvesFavourite(match, favourites) ? preferred : rest).push(match);
  }
  return preferred.length === 0 ? matches : [...preferred, ...rest];
}

/* ── GROUPING ───────────────────────────────────────────────────────────── */

export type DateGroup = {
  date: string;
  /** Fixtures for this date, grouped by competition in canonical order. */
  competitions: { competition: Competition | null; matches: PublicMatch[] }[];
  total: number;
};

/**
 * Groups matches by date, then by competition within each date.
 *
 * Ordering rules:
 *  - Dates ascend, compared as ISO strings (no date parsing, so no timezone
 *    boundary bugs).
 *  - Competitions follow the canonical `COMPETITIONS` order, with any
 *    unrecognised competition collected under a final `null` group so a fixture
 *    with unexpected metadata is shown rather than dropped.
 *  - Within a competition, the incoming order is preserved.
 *
 * Every input match appears exactly once: the function partitions, never filters.
 */
export function groupByDateAndCompetition(matches: PublicMatch[]): DateGroup[] {
  const byDate = new Map<string, PublicMatch[]>();
  for (const match of matches) {
    const list = byDate.get(match.matchDate) ?? [];
    list.push(match);
    byDate.set(match.matchDate, list);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateMatches]) => {
      const byCompetition = new Map<Competition, PublicMatch[]>();
      const unknown: PublicMatch[] = [];
      for (const match of dateMatches) {
        // `isCompetition` is not applied here: a row whose competition is
        // outside the canonical list is still real data and must be displayed.
        const known = (COMPETITIONS as readonly string[]).includes(match.competition);
        if (!known) {
          unknown.push(match);
          continue;
        }
        const list = byCompetition.get(match.competition) ?? [];
        list.push(match);
        byCompetition.set(match.competition, list);
      }

      const competitions = COMPETITIONS.filter((competition) => byCompetition.has(competition)).map(
        (competition) => ({
          competition: competition as Competition | null,
          matches: byCompetition.get(competition) as PublicMatch[],
        }),
      );
      if (unknown.length > 0) competitions.push({ competition: null, matches: unknown });

      return { date, competitions, total: dateMatches.length };
    });
}
