import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Trophy } from "lucide-react";
import AdSlot from "@/components/ad-slot";
import CompetitionFixtures from "@/components/competition-fixtures";
import { BRAND } from "@/lib/brand";
import {
  COMPETITION_LABELS_AR,
  allCompetitionSlugs,
  competitionFromSlug,
} from "@/lib/sports/competitions";
import { getCompetitionFixtures } from "@/lib/sports/matches";

/**
 * Competition pages, e.g. /competition/champions-league.
 *
 * Slugs come from `COMPETITION_SLUGS` in the competition config, so this route
 * cannot drift from the list used by the filter chips and the admin form.
 *
 * Fixtures come from the same cached schedule the homepage uses, via
 * `getCompetitionFixtures`. There is one match-card implementation and one
 * grouping implementation, shared with the homepage and /upcoming.
 *
 * The window is the current Monday..Sunday week — the same window the schedule
 * covers — and the page states that explicitly rather than implying a complete
 * season archive that does not exist.
 */

/** Pre-render every competition; there are exactly six and they never change. */
export function generateStaticParams() {
  return allCompetitionSlugs().map((slug) => ({ slug }));
}

/**
 * Unknown slugs 404 through `notFound()` in the page body.
 *
 * `dynamicParams = false` was removed deliberately. It expressed the same
 * intent, but in the App Router it makes an unrecognised path throw Next's
 * internal `NoFallbackError` during the static-generation check, which the
 * server then logs as:
 *
 *   Error: Internal: NoFallbackError
 *     at ignore-listed frames
 *
 * That is a genuine application-triggered error, not dev tooling noise — it
 * appears in `npm start` as well as `next dev`, and it fires for every stray or
 * crawler request to `/competition/<anything>`. Since `generateStaticParams`
 * already enumerates all six slugs, an unknown slug reaches the page, fails
 * `competitionFromSlug`, and returns a clean 404 without the internal throw.
 * The behaviour is identical; only the spurious error log is gone.
 */

export async function generateMetadata({
  params,
}: PageProps<"/competition/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const competition = competitionFromSlug(slug);
  if (!competition) return { title: "البطولة غير موجودة" };

  const arabic = COMPETITION_LABELS_AR[competition];
  return {
    title: `${arabic} — جدول المباريات والبث`,
    description: `جدول مباريات ${arabic} هذا الأسبوع مع مواعيد الانطلاق والبث المتاح والناقلين الرسميين.`,
    alternates: { canonical: `/competition/${slug}` },
    openGraph: {
      title: `${arabic} | ${BRAND.ar}`,
      description: `جدول مباريات ${arabic} والبث المتاح لكل مباراة.`,
      type: "website",
    },
  };
}

export default async function CompetitionPage({ params }: PageProps<"/competition/[slug]">) {
  const { slug } = await params;
  const competition = competitionFromSlug(slug);
  if (!competition) notFound();

  const { matches, schedule } = await getCompetitionFixtures(competition);
  const arabic = COMPETITION_LABELS_AR[competition];

  return (
    <main id="main-content" className="page-width listing-page">
      <div className="page-head">
        <span className="eyebrow">
          <Trophy size={13} aria-hidden="true" />
          {BRAND.en} / COMPETITION
        </span>
        <h1>{arabic}</h1>
        <p>
          مباريات {arabic} المنشورة في الأسبوع الحالي، مع مواعيد الانطلاق والبث المتاح لكل مباراة.
        </p>
      </div>

      <CompetitionFixtures matches={matches} schedule={schedule} />

      {/* Advertisement sits below the fixture list, clear of match cards and
          their stream links. */}
      <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_FIXTURES} />
    </main>
  );
}
