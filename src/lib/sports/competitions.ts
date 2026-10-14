/**
 * The only competitions an administrator can assign to a match.
 *
 * This list is the contract shared by the admin form, the API validation layer,
 * and the database check constraint in `supabase/migrations/005_matches.sql`.
 * Arbitrary competition names are rejected — keep all three in sync.
 */
export const COMPETITIONS = [
  "Premier League",
  "La Liga",
  "Serie A",
  "Bundesliga",
  "Ligue 1",
  "UEFA Champions League",
] as const;

export type Competition = (typeof COMPETITIONS)[number];

/**
 * URL slug for each competition.
 *
 * Declared here, beside the names they refer to, so every route, link and
 * sitemap entry derives from one mapping. Hand-writing slugs at each call site
 * is how a site ends up with `/competition/champions-league` in one place and
 * `/competition/uefa-champions-league` in another, producing duplicate pages.
 *
 * Slugs are Latin and stable: Arabic titles stay in the page content and
 * metadata, where they belong for SEO, while the URL stays shareable.
 */
export const COMPETITION_SLUGS: Record<Competition, string> = {
  "Premier League": "premier-league",
  "La Liga": "la-liga",
  "Serie A": "serie-a",
  Bundesliga: "bundesliga",
  "Ligue 1": "ligue-1",
  "UEFA Champions League": "champions-league",
};

/** Arabic display names, used for headings and page titles. */
export const COMPETITION_LABELS_AR: Record<Competition, string> = {
  "Premier League": "الدوري الإنجليزي الممتاز",
  "La Liga": "الدوري الإسباني (لا ليغا)",
  "Serie A": "الدوري الإيطالي (سيري آ)",
  Bundesliga: "الدوري الألماني (البوندسليغا)",
  "Ligue 1": "الدوري الفرنسي (ليغ ١)",
  "UEFA Champions League": "دوري أبطال أوروبا",
};

/** The slug for a competition, or null when it is not one we publish. */
export function competitionSlug(competition: Competition): string {
  return COMPETITION_SLUGS[competition];
}

/**
 * Resolves a URL slug back to its competition.
 *
 * Returns null for an unknown slug so the route can 404 rather than render a
 * thin page for a competition that does not exist.
 */
export function competitionFromSlug(slug: string): Competition | null {
  const match = COMPETITIONS.find(
    (competition) => COMPETITION_SLUGS[competition] === slug.toLowerCase(),
  );
  return match ?? null;
}

/** Every published competition's slug, for static params and the sitemap. */
export function allCompetitionSlugs(): string[] {
  return COMPETITIONS.map((competition) => COMPETITION_SLUGS[competition]);
}

export function isCompetition(value: unknown): value is Competition {
  return typeof value === "string" && (COMPETITIONS as readonly string[]).includes(value);
}