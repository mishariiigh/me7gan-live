import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Trophy } from "lucide-react";
import AdSlot from "@/components/ad-slot";
import { BRAND } from "@/lib/brand";
import {
  COMPETITIONS,
  COMPETITION_LABELS_AR,
  COMPETITION_SLUGS,
} from "@/lib/sports/competitions";
import { getPublicFixtureSchedule } from "@/lib/sports/matches";

export const metadata: Metadata = {
  title: "البطولات",
  description:
    "أهم البطولات الأوروبية: الدوري الإنجليزي، الإسباني، الإيطالي، الألماني، الفرنسي، ودوري أبطال أوروبا، مع جدول مباريات الأسبوع.",
  alternates: { canonical: "/competitions" },
};

/**
 * Index of the competitions we publish pages for.
 *
 * Built from the canonical `COMPETITIONS` list, so it cannot fall out of step
 * with the filter chips, the admin form or the competition routes. Each entry
 * shows how many fixtures are scheduled this week, which is real data from the
 * cached schedule rather than a fabricated count.
 */
export default async function CompetitionsIndexPage() {
  const schedule = await getPublicFixtureSchedule();
  const week = [...schedule.today, ...schedule.tomorrow, ...schedule.week];

  // Count per competition from the same cached rows the competition pages read.
  const countFor = (competition: string) =>
    week.filter((match) => match.competition === competition).length;

  return (
    <main id="main-content" className="page-width listing-page">
      <div className="page-head">
        <span className="eyebrow">
          <Trophy size={13} aria-hidden="true" />
          {BRAND.en} / COMPETITIONS
        </span>
        <h1>البطولات</h1>
        <p>اختر بطولة لعرض مبارياتها هذا الأسبوع والبث المتاح لكل مباراة.</p>
      </div>

      <div className="competition-index">
        {COMPETITIONS.map((competition) => {
          const count = countFor(competition);
          return (
            <Link
              key={competition}
              className="competition-card"
              href={`/competition/${COMPETITION_SLUGS[competition]}`}
            >
              <span className="competition-card-name">
                <Trophy size={16} aria-hidden="true" />
                {COMPETITION_LABELS_AR[competition]}
              </span>
              <span className="competition-card-meta">
                {/* Real count, or an honest "no fixtures" rather than a fake number. */}
                {count > 0 ? `${count} مباراة هذا الأسبوع` : "لا مباريات هذا الأسبوع"}
                <ArrowLeft size={14} aria-hidden="true" />
              </span>
            </Link>
          );
        })}
      </div>

      <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_FIXTURES} />
    </main>
  );
}
