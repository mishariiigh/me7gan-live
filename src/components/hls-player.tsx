"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

/**
 * HLS player.
 *
 * Error handling notes:
 * - hls.js classifies every problem by `type` (network / media / other) and
 *   `details` (the specific sub-reason). Both are logged so the console shows
 *   exactly which stage failed: manifest, level playlist, fragment, key, buffer,
 *   or media decode.
 * - Recoverable errors must NOT trigger `onFatalError`. Only a genuinely
 *   unrecoverable failure moves the UI to a fallback source. A network hiccup on
 *   a live stream is normal and hls.js recovers from it on its own.
 */

/** Minimal shape of an hls.js error event payload. */
type HlsErrorData = {
  type: string;
  details: string;
  fatal: boolean;
  url?: string;
  reason?: string;
  response?: { code?: number; text?: string; url?: string };
  error?: Error;
  frag?: { url?: string; type?: string; sn?: number };
};

/** Maps an hls.js error onto the pipeline stage that actually failed. */
function describeStage(data: HlsErrorData) {
  const details = data.details ?? "";
  if (details.startsWith("manifest")) return "manifest";
  if (details.includes("level") || details.includes("Level")) return "level playlist";
  if (details.includes("rag")) return "fragment/segment";
  if (details.includes("ey")) return "encryption key";
  if (details.includes("uffer")) return "buffer";
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return "media decode";
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) return "network";
  return "other";
}

function logHlsError(data: HlsErrorData) {
  console.groupCollapsed(`[HLS] ${data.fatal ? "FATAL" : "recoverable"} · ${describeStage(data)} · ${data.type}`);
  console.log("type     :", data.type);
  console.log("details  :", data.details);
  console.log("fatal    :", data.fatal);
  console.log("url      :", data.url ?? data.frag?.url ?? "(none)");
  console.log("response :", data.response ?? "(none)");
  console.log("reason   :", data.reason ?? "(none)");
  console.log("error    :", data.error ?? "(none)");
  console.log("segment  :", data.frag ? { type: data.frag.type, sn: data.frag.sn, url: data.frag.url } : "(none)");
  console.groupEnd();

  if (data.response?.code) {
    const hint =
      data.response.code === 403
        ? "Origin rejected the request (403). Check the source server's Referer/Origin policy or token expiry."
        : data.response.code === 404
          ? "Not found (404). The playlist may reference segments outside the current live window."
          : null;
    if (hint) console.warn(`[HLS] ${hint}`);
  }
}

export default function HlsPlayer({ src, title, captions, onFatalError }: { src: string; title: string; captions?: string; onFatalError?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);

  /**
   * The error callback, read through a ref so it is NOT an effect dependency.
   *
   * If `onFatalError` were listed below, any parent re-render that produced a
   * new function identity would destroy and rebuild the hls.js instance —
   * aborting in-flight segment requests and re-fetching the manifest. Keeping it
   * in a ref means the effect runs only when the source or retry count actually
   * changes, which is the intended trigger.
   *
   * The ref is updated in an effect rather than during render: writing a ref
   * while rendering is not safe under concurrent React, and the lint rule that
   * flags it is right.
   */
  const fatalErrorRef = useRef(onFatalError);
  useEffect(() => {
    fatalErrorRef.current = onFatalError;
  }, [onFatalError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let disposed = false;
    // Tracked so it can be cleared on unmount: it is scheduled outside hls.js,
    // so `hls.destroy()` alone would not cancel it.
    let stallTimer: number | null = null;
    setMessage("");
    console.info("[HLS] loading source:", src);

    // Native HLS (Safari / iOS). Chromium has no native HLS, and there we always
    // use hls.js even though canPlayType may report support.
    if (video.canPlayType("application/vnd.apple.mpegurl") && !Hls.isSupported()) {
      video.src = src;
      const handleNativeError = () => {
        console.error("[HLS] native playback error (Safari path)");
        setMessage("تعذر تشغيل هذا المصدر. تحقق من صلاحية الرابط أو جرّب مصدراً آخر.");
        fatalErrorRef.current?.();
      };
      video.addEventListener("error", handleNativeError, { once: true });
      return () => { video.pause(); video.removeEventListener("error", handleNativeError); video.removeAttribute("src"); video.load(); };
    }

    if (!Hls.isSupported()) {
      // Deferred so the effect body itself performs no synchronous state update.
      const unsupported = window.setTimeout(
        () => setMessage("هذا المتصفح لا يدعم تشغيل هذا النوع من البث."),
        0,
      );
      return () => window.clearTimeout(unsupported);
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      maxBufferLength: 30,
      backBufferLength: 30,
      // Retry network failures internally instead of surfacing them immediately.
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 6,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 1000,
    });
    hlsRef.current = hls;
    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      console.info("[HLS] manifest parsed; playlist and segments can now be requested.");
    });

    // Intentionally no autoplay while debugging: the visitor uses the native
    // Play button, which also avoids autoplay-policy noise masking real errors.

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (disposed) return;
      const error = data as HlsErrorData;
      logHlsError(error);

      // Recoverable: let hls.js retry. Never fall back for these.
      if (!error.fatal) {
        if (error.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          setMessage("البث يتوقف مؤقتاً لضعف الاتصال…");
        }
        return;
      }

      if (error.type === Hls.ErrorTypes.NETWORK_ERROR) {
        const status = error.response?.code;
        setMessage(
          status === 403
            ? "رفض المصدر الطلب (403). تحقق من صلاحية الرابط أو من سياسة المصدر."
            : status === 404
              ? "لم يتم العثور على ملفات البث (404). قد يكون الرابط منتهي الصلاحية."
              : "تعذر الوصول إلى مصدر البث. جارٍ إعادة المحاولة…",
        );
        hls.startLoad();
        // Only offer a fallback source if startLoad could not recover in time.
        // The timer is tracked so it cannot fire after unmount.
        stallTimer = window.setTimeout(() => {
          if (disposed) return;
          if (hls.media && hls.media.readyState >= 1) return;
          fatalErrorRef.current?.();
        }, 8000);
        return;
      }

      if (error.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setMessage("تعذر فك ترميز البث. جارٍ إعادة المحاولة…");
        hls.recoverMediaError();
        return;
      }

      setMessage("تعذر تشغيل هذا المصدر. تحقق من صلاحية الرابط أو جرّب مصدراً آخر.");
      fatalErrorRef.current?.();
      hls.destroy();
      hlsRef.current = null;
      window.setTimeout(() => { if (!disposed) setRetry((value) => value + 1); }, 1800);
    });

    // `hls.destroy()` detaches the media, stops loading and tears down the
    // worker, so no instance, listener or timer outlives the component. The
    // stall timer is cleared explicitly because it is scheduled outside hls.js.
    return () => {
      disposed = true;
      if (stallTimer !== null) window.clearTimeout(stallTimer);
      hls.destroy();
      hlsRef.current = null;
    };
  }, [src, retry]);

  return (
    <div className="player-frame">
      <video ref={videoRef} controls playsInline preload="metadata" aria-label={title}>
        {captions && <track kind="captions" src={captions} srcLang="ar" label="العربية" default />}
      </video>
      {message && <div className="player-message" role="status"><span>{message}</span><button onClick={() => setRetry((value) => value + 1)}>إعادة المحاولة</button></div>}
    </div>
  );
}