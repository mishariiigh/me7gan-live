import type { Metadata } from "next";
import AdSlot from "@/components/ad-slot";
import MatchesListing from "@/components/matches-listing";
import { getPublicFixtureSchedule } from "@/lib/sports/matches";
import { BRAND } from "@/lib/brand";

// No `dynamic = "force-dynamic"`: the fixture data is cached with an explicit
// revalidate window and tag (see `lib/sports/matches.ts`), so this page is
// served from that cache rather than re-querying Supabase per request.
// `revalidateTag("public-fixtures")` after an admin change refreshes it.

export const metadata: Metadata = { title: "المباريات", description: "جدول مباريات اليوم والغد والبثوث المتاحة لكل مباراة.", alternates: { canonical: "/upcoming" } };

export default async function UpcomingPage() {
  const fixtureSchedule = await getPublicFixtureSchedule();
  return (
    <main id="main-content" className="page-width listing-page">
      <div className="page-head">
        <span className="eyebrow">{BRAND.en} / MATCHES</span>
        <h1>المباريات</h1>
        <p>مباريات اليوم والغد المنشورة، مع البث المتاح لكل مباراة.</p>
      </div>
      <MatchesListing fixtureSchedule={fixtureSchedule} />

      {/* Advertisement sits below the whole fixture list, keeping it clear of
          match cards and their stream links. */}
      <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_FIXTURES} />
    </main>
  );
}