import type { MetadataRoute } from "next";
import { allCompetitionSlugs } from "@/lib/sports/competitions";
import { getLiveMatches, getPublicFixtureSchedule } from "@/lib/sports/matches";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://me7gan-live.vercel.app";
  const [{ matches }, schedule] = await Promise.all([
    getLiveMatches(),
    getPublicFixtureSchedule(),
  ]);
  const lastModified = new Date();

  // Every published fixture in the current week, de-duplicated. Previously only
  // /live matches were listed, so a fixture without a stream never appeared in
  // the sitemap despite having a real, indexable page.
  const fixtureIds = [
    ...new Set([
      ...matches.map((match) => match.fixtureId),
      ...schedule.today.map((match) => match.fixtureId),
      ...schedule.tomorrow.map((match) => match.fixtureId),
      ...schedule.week.map((match) => match.fixtureId),
    ]),
  ];

  return [
    { url: base, lastModified, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/live`, lastModified, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/upcoming`, lastModified, changeFrequency: "daily", priority: 0.8 },
    // Competition pages are stable, substantive landing pages, so they outrank
    // individual fixtures in priority.
    ...allCompetitionSlugs().map((slug) => ({
      url: `${base}/competition/${slug}`,
      lastModified,
      changeFrequency: "daily" as const,
      priority: 0.85,
    })),
    ...fixtureIds.map((fixtureId) => ({
      url: `${base}/match/${fixtureId}`,
      lastModified,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
  ];
}
