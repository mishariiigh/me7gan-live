"use client";

import { useEffect, useState } from "react";
import { Activity, Eye, Radio, Users } from "lucide-react";

/**
 * Visitor statistics card for the admin surface.
 *
 * Deliberately a *client* component that calls the admin-only
 * `/api/analytics/stats` endpoint after mount. That keeps the admin page free
 * of any database access during render and means the service-role key never
 * touches a client bundle — the browser only ever sees the JSON numbers.
 *
 * The endpoint itself enforces `profiles.role === 'admin'`, so this card shows
 * nothing useful to a signed-out visitor even if it is rendered.
 *
 * Honesty rules
 * -------------
 *   * "Not configured" (503, configured:false) and "not available yet"
 *     (503, available:false — e.g. migration 011 not applied) are shown as
 *     such. We never fall back to zeros, which would read as "0 visitors".
 */

type Stats = {
  configured: boolean;
  available?: boolean;
  day?: string;
  timeZone?: string;
  uniqueVisitors?: number;
  pageViews?: number;
  onlineNow?: number;
  onlineWindowMinutes?: number;
  error?: string;
  detail?: string;
};

type State =
  | { status: "loading" }
  | { status: "ready"; data: Stats }
  | { status: "unavailable"; message: string; detail?: string };

export default function AdminAnalyticsPanel() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/analytics/stats", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as Stats;

        if (cancelled) return;

        if (res.status === 403) {
          setState({ status: "unavailable", message: "غير مصرّح بعرض الإحصاءات." });
          return;
        }
        if (!data.configured) {
          setState({
            status: "unavailable",
            message: "الإحصاءات غير مُهيّأة على هذا الخادم.",
            detail: data.error,
          });
          return;
        }
        if (!data.available) {
          setState({
            status: "unavailable",
            message: "جداول الإحصاءات غير متاحة بعد (لم تُطبَّق التهجيرات).",
            detail: data.detail ?? data.error,
          });
          return;
        }
        setState({ status: "ready", data });
      } catch {
        if (!cancelled) {
          setState({ status: "unavailable", message: "تعذّر تحميل الإحصاءات." });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="admin-analytics" aria-labelledby="admin-analytics-title">
      <header className="admin-analytics-head">
        <h2 id="admin-analytics-title">
          <Activity size={18} aria-hidden="true" /> زوّار اليوم
        </h2>
        {state.status === "ready" && (
          <span className="admin-analytics-day" dir="ltr">
            {state.data.day} · {state.data.timeZone}
          </span>
        )}
      </header>

      {state.status === "loading" && <p className="admin-analytics-note">جارٍ التحميل…</p>}

      {state.status === "unavailable" && (
        <p className="admin-analytics-note" role="status">
          {state.message}
          {state.detail ? <span className="admin-analytics-detail" dir="ltr"> ({state.detail})</span> : null}
        </p>
      )}

      {state.status === "ready" && (
        <>
          <dl className="admin-analytics-grid">
            <div className="admin-analytics-stat">
              <dt>
                <Users size={15} aria-hidden="true" /> زوّار فريدون
              </dt>
              <dd>{state.data.uniqueVisitors ?? 0}</dd>
            </div>
            <div className="admin-analytics-stat">
              <dt>
                <Eye size={15} aria-hidden="true" /> مشاهدات الصفحات
              </dt>
              <dd>{state.data.pageViews ?? 0}</dd>
            </div>
            <div className="admin-analytics-stat">
              <dt>
                <Radio size={15} aria-hidden="true" /> متصلون الآن
              </dt>
              <dd>{state.data.onlineNow ?? 0}</dd>
            </div>
          </dl>
          <p className="admin-analytics-footnote">
            الحدود اليومية بتوقيت الرياض. &laquo;الزوّار الفريدون&raquo; تقدير مبني على بصمة يومية متجددة (وكيل
            المستخدم + عنوان الشبكة)، وقد يُحتسب زائر واحد أكثر من مرة عند تغيّر الشبكة أو المتصفح. تُستثنى زيارات
            المدراء.
          </p>
        </>
      )}
    </section>
  );
}
