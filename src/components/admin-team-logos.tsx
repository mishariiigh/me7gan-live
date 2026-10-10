"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageIcon, Trash2, Upload } from "lucide-react";

/**
 * Team logo manager.
 *
 * A crest is stored against the club, not the fixture, so uploading it once
 * applies it to every match involving that club — past and future, home and
 * away. This panel makes that ownership explicit: each row is a club.
 *
 * The team list is derived from the saved teams plus every distinct name already
 * present in the schedule, so an administrator can assign a logo to a club that
 * appears in fixtures but has not been saved yet.
 */

type Team = {
  id: string;
  team_key: string;
  name: string;
  logo_url: string | null;
};

export default function AdminTeamLogos({
  fixtureTeamNames,
  onSaved,
}: {
  /** Distinct team names present in the schedule, newest data included. */
  fixtureTeamNames: string[];
  onSaved?: () => void;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [query, setQuery] = useState("");
  const [busyTeam, setBusyTeam] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2800);
  };

  async function load() {
    try {
      const response = await fetch("/api/admin/teams/logo", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const payload = await response.json().catch(() => ({}));
      setTeams(Array.isArray(payload.data) ? (payload.data as Team[]) : []);
      setError("");
    } catch {
      setError("تعذر تحميل الفرق (Could not load teams).");
    } finally {
      setLoading(false);
    }
  }

  // Loaded through a promise chain rather than an async effect body, matching
  // the pattern used by the match manager. Setting state inside an async
  // function called from an effect triggers a cascading render.
  useEffect(() => {
    let active = true;
    fetch("/api/admin/teams/logo", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("load failed"))))
      .then((payload: { data?: unknown }) => {
        if (!active) return;
        setTeams(Array.isArray(payload.data) ? (payload.data as Team[]) : []);
        setError("");
      })
      .catch(() => {
        if (active) setError("تعذر تحميل الفرق (Could not load teams).");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  /** Every club to show: saved teams first, then names only seen in fixtures. */
  const rows = useMemo(() => {
    const saved = new Map(teams.map((team) => [normalise(team.name), team]));
    const result: { name: string; logo: string | null; savedTeam: Team | null }[] = [];

    for (const team of teams) {
      result.push({ name: team.name, logo: team.logo_url, savedTeam: team });
    }
    const seen = new Set(result.map((row) => normalise(row.name)));
    for (const name of fixtureTeamNames) {
      const key = normalise(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({ name, logo: null, savedTeam: saved.get(key) ?? null });
    }

    const term = normalise(query);
    const filtered = term ? result.filter((row) => normalise(row.name).includes(term)) : result;
    return filtered.sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [teams, fixtureTeamNames, query]);

  async function upload(teamName: string, file: File) {
    if (!file.type.startsWith("image/")) {
      setError("اختر ملف صورة (Choose an image file).");
      return;
    }
    setBusyTeam(teamName);
    setError("");
    try {
      const body = new FormData();
      body.append("teamName", teamName);
      body.append("file", file);
      const response = await fetch("/api/admin/teams/logo", { method: "POST", body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "");
      await load();
      onSaved?.();
      flash(`تم حفظ شعار ${teamName}. سيظهر في كل مبارياته.`);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "تعذر رفع الشعار (Could not upload the logo).");
    } finally {
      setBusyTeam(null);
      const input = inputs.current[teamName];
      if (input) input.value = "";
    }
  }

  async function remove(teamName: string) {
    if (!window.confirm(`إزالة شعار ${teamName}؟ (Remove the logo for ${teamName}?)`)) return;
    setBusyTeam(teamName);
    setError("");
    try {
      const body = new FormData();
      body.append("teamName", teamName);
      body.append("remove", "true");
      const response = await fetch("/api/admin/teams/logo", { method: "POST", body });
      if (!response.ok) throw new Error();
      await load();
      onSaved?.();
      flash(`تمت إزالة شعار ${teamName}.`);
    } catch {
      setError("تعذر إزالة الشعار (Could not remove the logo).");
    } finally {
      setBusyTeam(null);
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-block-heading fixture-stream-heading">
        <div>
          <span className="eyebrow">TEAM LOGOS</span>
          <h2>شعارات الفرق ({rows.length})</h2>
        </div>
      </div>

      <div className="stream-warning">
        <ImageIcon size={17} />
        <span>
          يُحفظ الشعار لكل فريق مرة واحدة، ويظهر تلقائياً في كل مبارياته — السابقة والمستقبلية، وفي الاستيراد من
          CSV. استبدال الشعار يحدّث كل المباريات التي يظهر فيها الفريق. لا يؤثر ذلك على روابط البث أو مواعيد
          المباريات.
        </span>
      </div>

      {notice && (
        <div className="admin-toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {error && <div className="import-error" role="alert"><span>{error}</span></div>}

      <div className="fixture-browser-filters">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ابحث عن فريق"
          aria-label="بحث في الفرق"
        />
      </div>

      {loading ? (
        <div className="live-api-message" role="status">جارٍ تحميل الفرق…</div>
      ) : rows.length === 0 ? (
        <div className="fixture-list-empty">لا توجد فرق بعد. أضف مباراة أو استورد ملفاً لعرض الفرق هنا.</div>
      ) : (
        <div className="admin-table-block">
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>الشعار</th>
                  <th>الفريق</th>
                  <th>الحالة</th>
                  <th>الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={normalise(row.name)}>
                    <td>
                      <span className="team-logo-preview" aria-hidden="true">
                        {row.logo ? (
                          // Remote Supabase Storage URL; `unoptimized` avoids
                          // configuring a remote image pattern for one asset.
                          <Image src={row.logo} alt="" width={34} height={34} unoptimized />
                        ) : (
                          <span className="team-logo-placeholder">{row.name.slice(0, 2)}</span>
                        )}
                      </span>
                    </td>
                    <td><strong>{row.name}</strong></td>
                    <td>
                      <span className={row.logo ? "status-tag online" : "status-tag"}>
                        {row.logo ? "له شعار" : "بدون شعار"}
                      </span>
                    </td>
                    <td className="table-actions">
                      <label className="team-logo-upload">
                        <Upload size={14} aria-hidden="true" />
                        {busyTeam === row.name ? "جارٍ…" : row.logo ? "استبدال" : "رفع شعار"}
                        <input
                          ref={(element) => { inputs.current[row.name] = element; }}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/avif"
                          disabled={busyTeam === row.name}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void upload(row.name, file);
                          }}
                        />
                      </label>
                      {row.logo && (
                        <button
                          type="button"
                          onClick={() => void remove(row.name)}
                          disabled={busyTeam === row.name}
                          aria-label={`إزالة شعار ${row.name}`}
                          title="إزالة الشعار"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Mirrors the server's normalisation closely enough for list de-duplication. */
function normalise(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}
