/**
 * Small, reusable presentation primitives shared across the public site and the
 * admin panel. Keeping them here avoids one giant page component and keeps the
 * theme variables in one place.
 */

import Link from "next/link";
import { Radio, Trophy } from "lucide-react";
import { competitionSlug, isCompetition } from "@/lib/sports/competitions";

/* ── LIVE BADGE ────────────────────────────────────────────────────────── */

export function LiveBadge({ label = "مباشر" }: { label?: string }) {
  return (
    <span className="badge badge-live">
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

/* ── COMPETITION BADGE ─────────────────────────────────────────────────── */

export function CompetitionBadge({ competition }: { competition: string }) {
  const content = (
    <>
      <Trophy size={12} aria-hidden="true" />
      {competition}
    </>
  );

  // A competition we publish a page for becomes a link; anything else (a
  // fixture whose competition is outside the canonical list) stays plain text,
  // so the badge never points at a 404.
  if (!isCompetition(competition)) {
    return <span className="badge badge-competition">{content}</span>;
  }

  return (
    <Link
      className="badge badge-competition badge-competition-link"
      href={`/competition/${competitionSlug(competition)}`}
      // The badge sits inside a card-wide link, so the click must not bubble into
      // the match-detail navigation.
      onClick={(event) => event.stopPropagation()}
      aria-label={`${competition} — عرض المباريات`}
    >
      {content}
    </Link>
  );
}

/* ── STREAM-TYPE BADGE ─────────────────────────────────────────────────── */

export function StreamBadge({ kind }: { kind: "hls" | "embed" | "external" }) {
  if (kind === "external") {
    return <span className="badge badge-external">البث الرسمي</span>;
  }
  return (
    <span className="badge badge-stream">
      <Radio size={12} aria-hidden="true" />
      بث مباشر
    </span>
  );
}

/* ── TEAM DISPLAY ──────────────────────────────────────────────────────── */

export function TeamDisplay({ name, logo, size = "md" }: { name: string; logo?: string | null; size?: "sm" | "md" | "lg" }) {
  return (
    <div className={`team team-${size}`}>
      <span
        className="team-logo"
        aria-hidden="true"
        style={logo ? { backgroundImage: `url("${logo}")` } : undefined}
      />
      <strong className="team-name">{name}</strong>
    </div>
  );
}

/* ── SECTION HEADER ────────────────────────────────────────────────────── */

export function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

/* ── EMPTY STATE ───────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <span className="empty-state-icon" aria-hidden="true">{icon ?? <Radio size={22} />}</span>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/* ── LOADING STATE ─────────────────────────────────────────────────────── */

export function LoadingState({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Skeleton placeholder for a match card while data loads. */
export function MatchCardSkeleton() {
  return (
    <div className="match-card skeleton" aria-hidden="true">
      <div className="skeleton-line skeleton-line-short" />
      <div className="skeleton-line" />
      <div className="skeleton-line skeleton-line-medium" />
    </div>
  );
}
