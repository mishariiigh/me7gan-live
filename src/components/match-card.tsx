"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, Link2, Pencil } from "lucide-react";
import { useState } from "react";
import FavouriteButton from "@/components/favourite-button";
import FixtureLinkEditor from "@/components/fixture-link-editor";
import { useLocale } from "@/components/locale-provider";
import { CompetitionBadge, LiveBadge, StreamBadge, TeamDisplay } from "@/components/ui/primitives";
import type { PublicMatch } from "@/lib/sports/match-types";

/**
 * Optional favourites wiring.
 *
 * Passed in rather than read from a hook inside the card, so the card stays a
 * pure presentational component and can still be rendered (e.g. in the admin
 * preview) with no favourites at all.
 */
export type FavouritesProps = {
  isFavourite: (teamName: string) => boolean;
  toggleFavourite: (teamName: string) => void;
};

/**
 * A single match card, used on the homepage, /live, /upcoming and the admin
 * preview. All data comes from Supabase — nothing here is hard-coded.
 *
 * `variant`:
 *  - "default" — standard grid card
 *  - "featured" — larger hero card
 *  - "compact" — dense row style
 *
 * `admin` is passed in by the page rather than detected here, so the card stays
 * presentational and can be rendered anywhere without an admin check. The
 * controls it enables are a convenience only: every write is authorised again
 * on the server.
 */
export default function MatchCard({
  match,
  variant = "default",
  live = false,
  favourites,
  admin,
  onLinksChanged,
}: {
  match: PublicMatch;
  variant?: "default" | "featured" | "compact";
  live?: boolean;
  favourites?: FavouritesProps;
  /** Present only for a confirmed administrator. */
  admin?: { enabled: boolean };
  /** Called after a link is saved, so the host page can refresh this match. */
  onLinksChanged?: (fixtureId: string) => void;
}) {
  const { locale } = useLocale();
  const [editorOpen, setEditorOpen] = useState(false);

  const dateLabel =
    locale === "ar"
      ? new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(`${match.matchDate}T00:00:00Z`),
        )
      : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(`${match.matchDate}T00:00:00Z`),
        );

  if (variant === "compact") {
    return (
      <Link className="match-row" href={`/match/${match.fixtureId}`}>
        <span className="match-row-time">{match.kickoffLabel}</span>
        <span className="match-row-teams">
          <TeamDisplay name={match.home.name} logo={match.home.logo} size="sm" />
          <TeamDisplay name={match.away.name} logo={match.away.logo} size="sm" />
        </span>
        <span className="match-row-competition">{match.competition}</span>
        {live && <LiveBadge label={locale === "ar" ? "مباشر" : "Live"} />}
        <ArrowUpRight size={15} aria-hidden="true" className="match-row-arrow" />
      </Link>
    );
  }

  return (
    <div className={`match-card match-card-${variant}`}>
      {/* The whole card is a link, so the admin control is a sibling button
          layered over it rather than nested inside the anchor. Nesting a button
          in an <a> is invalid HTML and would make the card navigate when the
          admin clicked "Add link". */}
      {admin?.enabled && (
        <button
          type="button"
          className="match-admin-link"
          onClick={() => setEditorOpen(true)}
          aria-label={
            match.hasActiveStream
              ? `${locale === "ar" ? "إدارة روابط" : "Manage links"} ${match.home.name} - ${match.away.name}`
              : `${locale === "ar" ? "إضافة رابط" : "Add link"} ${match.home.name} - ${match.away.name}`
          }
          title={match.hasActiveStream ? (locale === "ar" ? "إدارة الروابط" : "Manage links") : locale === "ar" ? "إضافة رابط" : "Add link"}
        >
          {match.hasActiveStream ? <Pencil size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
          <span>{match.hasActiveStream ? (locale === "ar" ? "إدارة الروابط" : "Manage links") : locale === "ar" ? "إضافة رابط" : "Add link"}</span>
        </button>
      )}

      <Link
        className="match-card-link"
        href={`/match/${match.fixtureId}`}
        aria-label={`${match.home.name} ${locale === "ar" ? "ضد" : "vs"} ${match.away.name}`}
      >
        <div className="match-card-head">
          <CompetitionBadge competition={match.competition} />
          {live ? <LiveBadge label={locale === "ar" ? "مباشر" : "Live"} /> : <StreamBadge kind={match.hasActiveStream ? "hls" : "external"} />}
        </div>
        <div className="match-card-body">
          <div className="match-card-team-row">
            <TeamDisplay name={match.home.name} logo={match.home.logo} size={variant === "featured" ? "lg" : "md"} />
            {favourites && (
              <FavouriteButton
                teamName={match.home.name}
                active={favourites.isFavourite(match.home.name)}
                onToggle={favourites.toggleFavourite}
              />
            )}
          </div>
          <span className="match-card-versus" aria-hidden="true">
            {locale === "ar" ? "ضد" : "VS"}
          </span>
          <div className="match-card-team-row">
            <TeamDisplay name={match.away.name} logo={match.away.logo} size={variant === "featured" ? "lg" : "md"} />
            {favourites && (
              <FavouriteButton
                teamName={match.away.name}
                active={favourites.isFavourite(match.away.name)}
                onToggle={favourites.toggleFavourite}
              />
            )}
          </div>
        </div>

        <div className="match-card-foot">
          <span className="match-card-kickoff">
            <CalendarDays size={13} aria-hidden="true" />
            <span className="ltr">{match.kickoffLabel}</span>
            <span className="match-card-date">{dateLabel}</span>
          </span>
          <span className="match-card-cta">
            {match.hasActiveStream
              ? locale === "ar" ? "مشاهدة الآن" : "Watch now"
              : locale === "ar" ? "التفاصيل" : "Details"}
            <ArrowUpRight size={14} aria-hidden="true" />
          </span>
        </div>
      </Link>

      {editorOpen && (
        <FixtureLinkEditor
          match={{
            fixtureId: match.fixtureId,
            homeName: match.home.name,
            awayName: match.away.name,
            competition: match.competition,
            kickoffLabel: match.kickoffLabel,
            dateLabel,
          }}
          onClose={() => setEditorOpen(false)}
          // Refresh the host page's data so a new link shows on the card
          // immediately, without a manual reload.
          onChanged={() => onLinksChanged?.(match.fixtureId)}
        />
      )}
    </div>
  );
}
