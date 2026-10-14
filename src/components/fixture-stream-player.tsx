"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Tv } from "lucide-react";
import EmbedPlayer from "@/components/embed-player";
import HlsPlayer from "@/components/hls-player";
import type { AuthorizedFixtureStream, AuthorizedFixtureStreams } from "@/lib/streaming/fixture-stream-types";
import { resolvePlayerForStoredStream } from "@/lib/streaming/stream-source";

export default function FixtureStreamPlayer({
  streams,
  title,
  externalOnly = [],
}: {
  streams: AuthorizedFixtureStreams;
  title: string;
  /**
   * Authorized sources for a match that has no playable stream. When set, the
   * widget shows the external viewing options instead of a broken player.
   */
  externalOnly?: AuthorizedFixtureStream[];
}) {
  const allSources = useMemo(
    () => [streams.primary, ...streams.fallbacks].filter((source): source is AuthorizedFixtureStream => Boolean(source)),
    [streams],
  );

  // Official external links are never loaded in a player. They are separated out
  // here so the internal player keeps working exactly as before, with the links
  // offered as an additional viewing option.
  const externalSources = useMemo(
    () => [...allSources, ...externalOnly].filter((source) => source.stream_type === "external"),
    [allSources, externalOnly],
  );
  const sources = useMemo(
    () => allSources.filter((source) => source.stream_type !== "external"),
    [allSources],
  );

  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const activeIndex = Math.max(0, sources.findIndex((source) => source.id === selectedId));
  const activeSource = sources[activeIndex];

  /**
   * The fallback handler, kept at a STABLE identity across renders.
   *
   * This is critical for performance. `HlsPlayer`'s effect lists `onFatalError`
   * in its dependency array, and that effect is what creates and destroys the
   * hls.js instance. A `useCallback` depending on `sources` would get a new
   * identity on every parent render (because `sources` is a fresh array each
   * time), which tore the player down and rebuilt it — aborting in-flight
   * segment requests and re-fetching the manifest repeatedly.
   *
   * Reading the current values from a ref instead means the identity never
   * changes, so the player is initialised once per selected source and survives
   * every unrelated re-render (state changes, polling, `router.refresh()`).
   *
   * The ref is written in an effect, not during render, because mutating a ref
   * while rendering is unsafe under concurrent React.
   */
  const latest = useRef({ activeIndex: 0, sources: [] as AuthorizedFixtureStream[] });
  useEffect(() => {
    latest.current = { activeIndex, sources };
  });

  const moveToFallback = useCallback(() => {
    const { activeIndex: index, sources: list } = latest.current;
    if (index + 1 < list.length) {
      setSelectedId(list[index + 1].id);
      setNotice("تعذر تشغيل المصدر الحالي؛ تم التبديل إلى المصدر الاحتياطي.");
    } else {
      setNotice("تعذر تشغيل مصدر البث. جرّب إعادة المحاولة أو اختر مصدراً آخر.");
    }
  }, []);

  // Nothing playable, but an authorized external link exists: show the link
  // instead of a broken player. The copy never implies a video is playing here.
  if (!activeSource) {
    return (
      <div className="fixture-stream-player">
        {externalSources.length === 0 ? (
          <div className="fixture-stream-unavailable" role="status">
            <p>البث غير متاح حالياً</p>
          </div>
        ) : (
          <div className="fixture-stream-external-only">
            <p className="fixture-stream-external-badge">مصدر مصرح به</p>
            <p>لا يتوفر بث مباشر داخل الموقع لهذه المباراة، ويمكنك المشاهدة عبر الناقل الرسمي.</p>
          </div>
        )}
        {externalSources.length > 0 && <ExternalLinks sources={externalSources} />}
      </div>
    );
  }

  // The stored `stream_type` is a hint, not the final word. Detection decides the
  // actual player, so a YouTube link stored as "hls" still gets the embed player.
  const routed = resolvePlayerForStoredStream(activeSource.stream_type, activeSource.stream_url);

  return (
    <div className="fixture-stream-player">
      {routed.player === "hls" ? (
        <HlsPlayer key={activeSource.id} src={routed.url} title={title} onFatalError={moveToFallback} />
      ) : routed.player === "embed" ? (
        <EmbedPlayer
          key={activeSource.id}
          src={routed.url}
          title={`${title} · ${activeSource.provider_name}`}
          providerName={activeSource.provider_name}
          onFatalError={moveToFallback}
        />
      ) : (
        <div className="fixture-stream-unavailable" role="status">
          <p>
            هذا الرابط يبدو صفحة ويب عادية وليس مصدر بث أو تضمين مدعوم. الرجاء إدخال رابط بث HLS
            أو رابط تضمين مصرح به من الإدارة.
          </p>
        </div>
      )}
      {notice && <p className="fixture-stream-notice" role="status">{notice}</p>}
      {sources.length > 1 && (
        <div className="fixture-stream-fallbacks" aria-label="مصادر البث الاحتياطية">
          <span>مصادر البث:</span>
          {sources.map((source, index) => (
            <button
              key={source.id}
              type="button"
              className={source.id === activeSource.id ? "active" : ""}
              onClick={() => { setSelectedId(source.id); setNotice(""); }}
            >
              {index === 0 ? "أساسي" : `احتياطي ${index}`} · {source.provider_name}
            </button>
          ))}
        </div>
      )}
      {externalSources.length > 0 && <ExternalLinks sources={externalSources} />}
    </div>
  );
}

/**
 * External viewing options.
 *
 * These open in a new tab with `rel="noopener noreferrer"`. The page is never
 * proxied or framed, so the broadcaster's own security policies apply.
 */
function ExternalLinks({ sources }: { sources: AuthorizedFixtureStream[] }) {
  return (
    <section className="watch-options" aria-label="خيارات المشاهدة">
      <div className="watch-options-head">
        <Tv size={16} aria-hidden="true" />
        <h3>خيارات المشاهدة</h3>
        <span className="watch-options-count">{sources.length}</span>
      </div>
      <p className="watch-options-note">
        روابط خارجية تُفتح في نافذة جديدة على موقع الناقل، ولا يبدأ التشغيل داخل الموقع.
      </p>
      <ul className="watch-options-list">
        {sources.map((source, index) => {
          const host = hostName(source.stream_url);
          return (
            <li key={source.id}>
              <a
                className="watch-option"
                href={source.stream_url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <span className="watch-option-index ltr" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="watch-option-copy">
                  <strong>مشاهدة البث الرسمي</strong>
                  <span className="watch-option-meta">
                    {source.provider_name && (
                      <small className="watch-option-provider">{source.provider_name}</small>
                    )}
                    {host && <small className="watch-option-host ltr">{host}</small>}
                  </span>
                </span>
                <ExternalLink size={15} aria-hidden="true" className="watch-option-go" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Display host of an external URL. Returns "" when the URL cannot be parsed. */
function hostName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}