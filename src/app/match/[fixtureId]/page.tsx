import Link from "next/link";
import { ArrowLeft, CalendarDays, Clock, ExternalLink, Radio, Tv } from "lucide-react";
import { notFound } from "next/navigation";
import AdSlot from "@/components/ad-slot";
import FixtureStreamPlayer from "@/components/fixture-stream-player";
import { getAuthorizedStream } from "@/lib/streaming/fixture-service";
import { getOfficialWatchLinks } from "@/lib/streaming/official-watch-links";
import { getPublicMatchByFixtureId } from "@/lib/sports/matches";
import { formatKickoffTime, formatMatchDate } from "@/lib/sports/match-types";
import { BRAND } from "@/lib/brand";

// Caching status of this page's data, stated precisely:
//
//   • authorized streams      -> CACHED (lib/streaming/fixture-service.ts)
//   • official watch links    -> CACHED (lib/streaming/official-watch-links.ts)
//   • the match row itself    -> NOT cached (getPublicMatchByFixtureId uses the
//                                cookie-reading server client, so it runs per
//                                request)
//
// All three are tagged with `FIXTURE_CACHE_TAG`, so an admin edit or a fixture
// import calls `revalidateFixtureData()` and the cached two are dropped at once.
//
// The page itself still renders per request because the match row is read with
// the session-aware client. That is a deliberate, separate trade-off: making the
// page static would require moving the match row onto the anonymous client, and
// this change is about the player, not about restructuring data access. The
// measured effect of caching the two stream lookups is reported in the summary.

export default async function MatchPage({ params }: PageProps<"/match/[fixtureId]">) {
  const { fixtureId } = await params;
  const match = await getPublicMatchByFixtureId(fixtureId);
  if (!match) notFound();

  const [officialWatchLinks, authorizedStreams] = await Promise.all([
    getOfficialWatchLinks(match.fixtureId).catch(() => []),
    getAuthorizedStream(match.fixtureId).catch(() => ({ primary: null, fallbacks: [] })),
  ]);

  const allAuthorizedSources = [authorizedStreams.primary, ...authorizedStreams.fallbacks].filter(
    (source) => source !== null,
  );
  const hasPlayableStream = allAuthorizedSources.some((source) => source.stream_type !== "external");
  const hasAuthorizedSource = allAuthorizedSources.length > 0;

  return (
    <main id="main-content" className="page-width match-page">
      <Link className="match-back" href="/upcoming">
        <ArrowLeft size={15} aria-hidden="true" /> العودة إلى المباريات
      </Link>

      {/* ── MATCH HEADER ──────────────────────────────────────────────── */}
      <header className="match-header">
        <div className="match-header-top">
          <div>
            <span className="eyebrow">{BRAND.en} / MATCH</span>
            <h1>{match.competition}</h1>
          </div>
          <div className="match-header-meta">
            <span><CalendarDays size={14} aria-hidden="true" /> {formatMatchDate(match.matchDate)}</span>
            <span><Clock size={14} aria-hidden="true" /> <span className="ltr">{formatKickoffTime(match.kickoffTime)}</span> · توقيت الرياض</span>
            <span className="badge badge-muted ltr">{match.fixtureId}</span>
          </div>
        </div>

        <div className="match-scoreboard">
          <div className="scoreboard-team">
            <span className="scoreboard-logo" aria-hidden="true" style={match.home.logo ? { backgroundImage: `url("${match.home.logo}")` } : undefined} />
            <strong>{match.home.name}</strong>
          </div>
          <div className="scoreboard-versus">VS</div>
          <div className="scoreboard-team">
            <span className="scoreboard-logo" aria-hidden="true" style={match.away.logo ? { backgroundImage: `url("${match.away.logo}")` } : undefined} />
            <strong>{match.away.name}</strong>
          </div>
        </div>
      </header>

      {/* ── PLAYER ────────────────────────────────────────────────────── */}
      <section className="player-section" aria-label="مشغل البث">
        <div className="player-section-head">
          <h2><Radio size={17} aria-hidden="true" /> البث داخل الموقع</h2>
          {hasAuthorizedSource && <span className="badge badge-stream">مصدر مصرح به</span>}
        </div>
        <div className="player-section-body">
          {hasPlayableStream ? (
            <FixtureStreamPlayer
              streams={authorizedStreams}
              title={`${match.home.name} vs ${match.away.name}`}
            />
          ) : (
            <FixtureStreamPlayer
              streams={{ primary: null, fallbacks: [] }}
              title={`${match.home.name} vs ${match.away.name}`}
              externalOnly={allAuthorizedSources}
            />
          )}
        </div>
        <div className="player-section-foot">
          يبث الفيديو من مزودك وCDN مباشرة، وليس من خادم الموقع.
        </div>
      </section>

      {/* ── OFFICIAL EXTERNAL BROADCASTERS ────────────────────────────────
          These open in a new tab. They are never loaded in a player and never
          proxied through this site. */}
      {officialWatchLinks.length > 0 && (
        <section className="external-section" aria-label="البث الرسمي">
          <h2><Tv size={17} aria-hidden="true" /> البث الرسمي
          </h2>
          <p className="external-section-desc">
            شاهد المباراة عبر الموقع الرسمي للناقل. سيتم فتح الرابط في نافذة جديدة.
          </p>
          <div className="external-list">
            {officialWatchLinks.map((link) => (
              <div className="external-card" key={link.id}>
                <div className="external-card-info">
                  <span className="external-card-icon" aria-hidden="true"><Tv size={19} /></span>
                  <span className="external-card-copy">
                    <strong>{link.broadcaster_name}</strong>
                    <small>{link.country_region}</small>
                    <small className="external-card-note">رابط خارجي · يُفتح في نافذة جديدة</small>
                  </span>
                </div>
                <a
                  className="external-action"
                  href={link.official_watch_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  <Tv size={16} aria-hidden="true" />
                  مشاهدة البث الرسمي
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── NO SOURCE AT ALL ──────────────────────────────────────────── */}
      {!hasAuthorizedSource && officialWatchLinks.length === 0 && (
        <div className="fixture-stream-external-only">
          <p>لا يتوفر بث لهذه المباراة حالياً. ستظهر مصادر المشاهدة هنا عند إضافتها.</p>
        </div>
      )}

      {/* ── ADVERTISEMENT ─────────────────────────────────────────────────
          Rendered last, after the player and the broadcaster links, so it can
          never sit beside or inside controls that look like streaming options. */}
      <AdSlot slot={process.env.NEXT_PUBLIC_ADSENSE_SLOT_MATCH} />
    </main>
  );
}