"use client";

import { Play, Tv } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/locale-provider";

/**
 * Renders an authorized embed/iframe stream URL.
 *
 * ## Why the iframe is not created until the visitor asks for it
 *
 * An `<iframe>` to a third-party video host starts a whole parallel page load
the moment it is inserted: its own scripts, stylesheets, ad/tracking beacons
and media manifests. On a match page that is a large amount of work competing
with the app itself, and it happened even when the visitor only wanted to read
the fixture.
 *
 * So the frame is created only after an explicit click. Until then the same
 * 16:9 box is reserved with a lightweight placeholder, which also means the
 * layout does not shift when the player appears — the space is already there.
 *
 * This does not change the admin's stored link in any way: the same URL is
 * loaded, just later.
 *
 * ## Why we never try to work around a refusal
 *
 * A site can refuse to be framed with `X-Frame-Options` or
 * `Content-Security-Policy: frame-ancestors`. Browsers deliberately give the
 * parent page no way to read the framed response, and the `iframe` element does
 * not fire `error` for that case. We therefore do not attempt to detect, proxy,
 * scrape or bypass those restrictions. What we can do is notice that the frame
 * never completed loading and surface a clear message, plus an outbound link.
 */
export default function EmbedPlayer({
  src,
  title,
  providerName,
  onFatalError,
}: {
  src: string;
  title: string;
  /** Shown on the placeholder so the visitor knows what they are loading. */
  providerName?: string;
  onFatalError?: () => void;
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [started, setStarted] = useState(false);
  const [blocked, setBlocked] = useState(false);

  // The 12s "did it load?" window only runs once the frame actually exists, so
  // an idle page holds no timer at all.
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    // Give a slow authorized embed a generous window before assuming it refused
    // to load. A successful `onLoad` cancels the timer.
    const timer = window.setTimeout(() => {
      if (!cancelled) setBlocked(true);
    }, 12000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [started, src]);

  // Before the visitor opts in: a placeholder that reserves the exact box the
  // player will occupy, so nothing moves when it loads.
  if (!started) {
    return (
      <div className="embed-player">
        <div className="player-frame">
          <button
            type="button"
            className="player-placeholder"
            onClick={() => setStarted(true)}
            aria-label={isArabic ? "تشغيل البث داخل الموقع" : "Load the on-site player"}
          >
            <span className="player-placeholder-icon" aria-hidden="true">
              <Play size={22} fill="currentColor" />
            </span>
            <strong>{isArabic ? "تشغيل البث داخل الموقع" : "Load the on-site player"}</strong>
            <span className="player-placeholder-note">
              {providerName
                ? isArabic
                  ? `المصدر: ${providerName}. يُحمّل المشغل عند الضغط فقط.`
                  : `Source: ${providerName}. The player loads only when you click.`
                : isArabic
                  ? "يُحمّل المشغل عند الضغط فقط."
                  : "The player loads only when you click."}
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="embed-player">
      <div className="player-frame">
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          // `autoplay` is granted in the allow-list so a provider designed to
          // start on load is not broken — we never add `?autoplay` ourselves,
          // and nothing autoplays before this click.
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          // The visitor already asked for this frame, so deferring it further
          // would only delay what they requested.
          loading="eager"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          onLoad={() => setBlocked(false)}
        />
      </div>
      {blocked && (
        <div className="embed-blocked" role="status">
          <p>
            {isArabic
              ? "هذا الموقع لا يسمح بالتضمين داخل إطار. الرجاء استخدام رابط تضمين مصرح به أو رابط بث مباشر."
              : "This site does not allow being embedded in a frame. Please use an authorized embed URL or a direct stream link."}
          </p>
          <div className="embed-blocked-actions">
            <a href={src} target="_blank" rel="noopener noreferrer">
              <Tv size={14} aria-hidden="true" />
              {isArabic ? "فتح الرابط في نافذة جديدة" : "Open in a new tab"}
            </a>
            <button
              type="button"
              onClick={() => {
                setBlocked(false);
                setStarted(false);
                onFatalError?.();
              }}
            >
              {isArabic ? "تجربة مصدر آخر" : "Try another source"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}