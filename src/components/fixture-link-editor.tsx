"use client";

import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/components/locale-provider";
import type { FixtureStreamType } from "@/lib/streaming/fixture-stream-types";

/**
 * Multi-source editor for a match's broadcaster / stream links.
 *
 * Writes through the **existing** `/api/admin/fixture-streams` API, so the
 * home-page editor and the admin panel operate on the same rows with the same
 * validation, priority semantics and audit trail. There is no second link store
 * and no new table.
 *
 * Every request is authorised server-side by `checkAdminRequest()`. This
 * component being rendered is never what grants access — a visitor who forced
 * it open would still get 401/403 from the API.
 *
 * ## Why this renders through a portal
 *
 * The panel is opened from a match card, but it must cover the whole viewport.
 * Rendering it inside the card does not achieve that: `.match-card:hover`
 * applies `transform: translateY(-2px)`, and a transformed element becomes the
 * containing block for `position: fixed` descendants. The overlay was therefore
 * positioned against the *card*, clipped by it, and stacked inside it.
 *
 * `createPortal(..., document.body)` lifts the overlay out of the card's DOM
 * subtree entirely, so no ancestor `transform`, `overflow`, `contain` or
 * `z-index` can constrain it — regardless of which card it was opened from.
 */

export type EditableStream = {
  id: string;
  fixture_id: string;
  stream_type: FixtureStreamType;
  stream_url: string;
  provider_name: string;
  active: boolean;
  priority: number;
};

/** Context shown in the panel header so the admin knows which match this is. */
export type EditorMatchContext = {
  fixtureId: string;
  homeName: string;
  awayName: string;
  competition: string;
  kickoffLabel: string;
  dateLabel: string;
};

/**
 * One editable row in the panel.
 *
 * `key` is a client-only identity used for React keys. `id` is present only for
 * a source that already exists in the database — which is exactly what
 * distinguishes "remove this unsaved row" from "delete this saved source".
 */
type SourceDraft = {
  key: string;
  id: string | null;
  stream_type: FixtureStreamType;
  stream_url: string;
  provider_name: string;
  priority: string;
  active: boolean;
  /** Set while this row's own request is in flight. */
  saving?: boolean;
  /** Per-row outcome, so a partial failure is attributed to the right row. */
  result?: { ok: true } | { ok: false; message: string };
};

type FieldErrors = Partial<Record<"stream_url" | "provider_name" | "priority", string>>;

let keyCounter = 0;
const nextKey = () => `src-${(keyCounter += 1)}`;

function emptyDraft(): SourceDraft {
  return {
    key: nextKey(),
    id: null,
    stream_type: "external",
    stream_url: "",
    provider_name: "",
    priority: "0",
    active: true,
  };
}

function draftFromStream(stream: EditableStream): SourceDraft {
  return {
    key: nextKey(),
    id: stream.id,
    stream_type: stream.stream_type,
    stream_url: stream.stream_url,
    provider_name: stream.provider_name,
    priority: String(stream.priority),
    active: stream.active,
  };
}

/** True when a draft holds no user-entered data (so it can be dropped silently). */
function isBlank(draft: SourceDraft): boolean {
  return !draft.id && !draft.stream_url.trim() && !draft.provider_name.trim();
}

/** True when a draft differs from the saved stream it came from. */
function isDirty(draft: SourceDraft, originals: Map<string, EditableStream>): boolean {
  if (!draft.id) return !isBlank(draft);
  const original = originals.get(draft.id);
  if (!original) return true;
  return (
    draft.stream_type !== original.stream_type ||
    draft.stream_url.trim() !== original.stream_url ||
    draft.provider_name.trim() !== original.provider_name ||
    String(draft.priority) !== String(original.priority) ||
    draft.active !== original.active
  );
}

/**
 * Validates one source, returning errors keyed by field so each message can be
 * shown beside the input that caused it.
 *
 * Mirrors the server's Zod rules so a bad value is caught before a round trip —
 * the server remains the authority and re-validates everything.
 */
function validateSource(draft: SourceDraft, isArabic: boolean): FieldErrors {
  const errors: FieldErrors = {};

  const url = draft.stream_url.trim();
  if (!url) {
    errors.stream_url = isArabic ? "أدخل الرابط." : "Enter a URL.";
  } else if (!/^https:\/\//i.test(url)) {
    errors.stream_url = isArabic ? "يجب أن يبدأ الرابط بـ https://" : "The URL must start with https://";
  } else {
    try {
      new URL(url);
    } catch {
      errors.stream_url = isArabic ? "الرابط غير صالح." : "That URL is not valid.";
    }
  }

  if (!draft.provider_name.trim()) {
    errors.provider_name = isArabic ? "أدخل اسم الناقل." : "Enter the broadcaster name.";
  }

  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
    errors.priority = isArabic ? "رقم بين 0 و 10000." : "A whole number between 0 and 10000.";
  }

  return errors;
}

/**
 * Whether two rows in the panel would be the same link.
 *
 * The database has no uniqueness constraint on `(fixture_id, stream_url)`, so
 * this is checked client-side before saving: the same URL twice would create
 * two rows that render as duplicate links on the match page.
 */
function duplicateOf(draft: SourceDraft, drafts: SourceDraft[]): boolean {
  const url = draft.stream_url.trim().toLowerCase();
  if (!url) return false;
  return drafts.some((other) => other.key !== draft.key && other.stream_url.trim().toLowerCase() === url);
}

export default function FixtureLinkEditor({
  match,
  onClose,
  onChanged,
}: {
  /** Teams, competition and kickoff, shown in the panel header. */
  match: EditorMatchContext;
  onClose: () => void;
  /** Called after any successful write, so the card can refresh its data. */
  onChanged: () => void;
}) {
  const { locale } = useLocale();
  const isArabic = locale === "ar";

  const [drafts, setDrafts] = useState<SourceDraft[]>([emptyDraft()]);
  /** The saved state each draft is compared against, for the dirty check. */
  const [originals, setOriginals] = useState<Map<string, EditableStream>>(new Map());
  const [errors, setErrors] = useState<Record<string, FieldErrors>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [summary, setSummary] = useState<{ saved: number; failed: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  /**
   * False during the server render and the first client render.
   *
   * `document.body` does not exist on the server, so a portal created during
   * SSR would throw. Gating on this flag keeps the server and first client
   * render identical (both render nothing), and the portal appears immediately
   * afterwards on the client — which is the supported pattern for portalling
   * from a component in the App Router.
   */
  const [mounted, setMounted] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  setMounted(true);
}, []);

/** Loads this fixture's saved sources. */
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/fixture-streams", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(isArabic ? "تعذر تحميل الروابط." : "Could not load links.");
      const body = (await res.json()) as { data?: EditableStream[] };
      const mine = (body.data ?? []).filter((stream) => stream.fixture_id === match.fixtureId);

      setOriginals(new Map(mine.map((stream) => [stream.id, stream])));
      // Existing sources first, then one empty row ready for the next one. A
      // match with no sources starts with a single blank form.
      setDrafts(mine.length > 0 ? [...mine.map(draftFromStream), emptyDraft()] : [emptyDraft()]);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : isArabic ? "تعذر تحميل الروابط." : "Could not load links.");
    } finally {
      setLoading(false);
    }
  }, [match.fixtureId, isArabic]);

  useEffect(() => {
    // Deferred to a microtask so the effect body performs no synchronous state
    // update — only the resolved request does.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** Any row with unsaved edits, including a half-filled new row. */
  const hasUnsavedChanges = useMemo(
    () => drafts.some((draft) => isDirty(draft, originals)),
    [drafts, originals],
  );

  /**
   * Closes the dialog, confirming first when there is unsaved work.
   *
   * `saving` blocks the close outright: letting the panel disappear mid-write
   * would discard the response and leave the admin unsure whether it landed.
   */
  const requestClose = useCallback(() => {
    if (saving) return;
    if (hasUnsavedChanges && !window.confirm(isArabic
      ? "لديك تغييرات غير محفوظة. هل تريد إغلاق المحرر؟"
      : "You have unsaved changes. Close the editor anyway?")) {
      return;
    }
    onClose();
  }, [saving, hasUnsavedChanges, isArabic, onClose]);

  // Escape closes, routed through the same guard so it cannot discard edits.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Lock background scrolling while the dialog is open.
  //
  // `overflow: hidden` on `<body>` is not enough on its own: iOS Safari still
  // scrolls the page behind a fixed overlay. Pinning the body with
  // `position: fixed` and restoring the scroll offset on close works across
  // mobile browsers. The previous inline values are captured and put back
  // verbatim, so a page that was itself already locked is left as it was.
  useEffect(() => {
    const body = document.body;
    const previous = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      scrollY: window.scrollY,
    };

    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${previous.scrollY}px`;
    body.style.width = "100%";

    return () => {
      body.style.overflow = previous.overflow;
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      // Return the page to exactly where it was, so closing does not jump to top.
      window.scrollTo(0, previous.scrollY);
    };
  }, []);

  // Move focus into the dialog on open, so keyboard users are not stranded on
  // the card underneath and Escape works immediately.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input, select, button")?.focus();
  }, []);

  function patchDraft(key: string, patch: Partial<SourceDraft>) {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    // Clear that row's errors as the admin edits, so a stale message does not
    // sit under a field that is now valid.
    setErrors((current) => ({ ...current, [key]: {} }));
  }

  function addSource() {
    setDrafts((current) => [...current, emptyDraft()]);
  }

  /**
   * Removes a row.
   *
   * A **new, unsaved** row is simply dropped — there is nothing to lose, and
   * asking to confirm would be noise. A row that exists in the database is
   * routed through the confirm + DELETE path instead, so an accidental click
   * cannot destroy a saved broadcaster link.
   */
  function removeRow(draft: SourceDraft) {
    if (draft.id) {
      setConfirmDeleteId(draft.id);
      return;
    }
    setDrafts((current) => {
      const next = current.filter((row) => row.key !== draft.key);
      // Never leave the panel with no rows at all.
      return next.length > 0 ? next : [emptyDraft()];
    });
  }

  async function deleteSaved(draft: SourceDraft) {
    if (saving || !draft.id) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/fixture-streams", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? (isArabic ? "تعذر الحذف." : "Could not delete."));
      }
      setConfirmDeleteId(null);
      await load();
      onChanged();
    } catch (err) {
      setErrors((current) => ({
        ...current,
        [draft.key]: {
          provider_name: err instanceof Error ? err.message : isArabic ? "تعذر الحذف." : "Could not delete.",
        },
      }));
      setConfirmDeleteId(null);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Saves every changed row, one request per row.
   *
   * Partial failure is handled honestly:
   *  - everything is validated *before* the first write, so a bad row cannot be
   *    discovered halfway through a batch that has already created sources;
   *  - each row reports its own outcome, and a failed row keeps its values so it
   *    can be retried;
   *  - a row that already saved has its new id recorded immediately, so a retry
   *    of the remaining rows cannot re-POST it and duplicate it;
   *  - the summary states exactly how many saved and how many failed, so a
   *    partial result is never presented as full success.
   */
  async function saveAll() {
    if (saving) return;

    const nextErrors: Record<string, FieldErrors> = {};
    const candidates = drafts.filter((draft) => !isBlank(draft) && isDirty(draft, originals));

    for (const draft of candidates) {
      const fieldErrors = validateSource(draft, isArabic);
      if (duplicateOf(draft, drafts)) {
        fieldErrors.stream_url = isArabic ? "هذا الرابط مضاف بالفعل." : "This URL is already added.";
      }
      if (Object.keys(fieldErrors).length > 0) nextErrors[draft.key] = fieldErrors;
    }
    setErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setSummary(null);
      return;
    }
    if (candidates.length === 0) {
      setSummary({ saved: 0, failed: 0 });
      return;
    }

    setSaving(true);
    setSummary(null);

    let saved = 0;
    let failed = 0;

    for (const draft of candidates) {
      // Mark this row in flight so the panel shows per-row progress.
      setDrafts((current) =>
        current.map((row) => (row.key === draft.key ? { ...row, saving: true, result: undefined } : row)),
      );

      const payload = {
        stream_type: draft.stream_type,
        stream_url: draft.stream_url.trim(),
        provider_name: draft.provider_name.trim(),
        priority: Number(draft.priority),
        active: draft.active,
      };

      try {
        const res = await fetch("/api/admin/fixture-streams", {
          method: draft.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            draft.id ? { id: draft.id, ...payload } : { fixture_id: match.fixtureId, ...payload },
          ),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? (isArabic ? "تعذر الحفظ." : "Could not save."));
        }

        const body = (await res.json()) as { data?: EditableStream };
        saved += 1;

        // Record the new id and saved values immediately. This is what makes a
        // retry safe: the row is no longer "dirty", so it will not be sent again.
        setOriginals((current) => {
          const next = new Map(current);
          if (body.data) next.set(body.data.id, body.data);
          return next;
        });
        setDrafts((current) =>
          current.map((row) =>
            row.key === draft.key
              ? { ...row, id: body.data?.id ?? row.id, saving: false, result: { ok: true } }
              : row,
          ),
        );
      } catch (err) {
        failed += 1;
        setDrafts((current) =>
          current.map((row) =>
            row.key === draft.key
              ? {
                  ...row,
                  saving: false,
                  result: {
                    ok: false,
                    message: err instanceof Error ? err.message : isArabic ? "تعذر الحفظ." : "Could not save.",
                  },
                }
              : row,
          ),
        );
      }
    }

    setSaving(false);
    setSummary({ saved, failed });

    if (saved > 0) {
      // Refresh the card whenever anything landed, even on a partial failure.
      onChanged();
      // Reload only when everything succeeded: on a partial failure the failed
      // rows must keep their values so they can be retried.
      if (failed === 0) await load();
    }
  }

  const errorCount = Object.keys(errors).length;

  // Nothing is rendered until the component is mounted on the client, so the
  // portal never runs during SSR.
  if (!mounted) return null;

  return createPortal(
    <div
      className="link-editor-backdrop"
      role="presentation"
      onClick={(event) => {
        // Only a click that both starts and ends on the backdrop closes it, so
        // a drag that began inside the panel cannot dismiss it.
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        className="link-editor"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="link-editor-head">
          <button
            type="button"
            className="link-editor-close"
            onClick={requestClose}
            disabled={saving}
            aria-label={isArabic ? "إغلاق المحرر" : "Close editor"}
            title={isArabic ? "إغلاق" : "Close"}
          >
            <X size={16} aria-hidden="true" />
          </button>
          <div>
            <strong id="link-editor-title">
              {isArabic ? "إضافة روابط الناقلين" : "Add broadcaster links"}
            </strong>
            {/* Which match is being edited, stated explicitly. */}
            <span className="link-editor-match">
              {match.homeName} <em>{isArabic ? "ضد" : "vs"}</em> {match.awayName}
            </span>
            <span className="link-editor-match-meta">
              <span className="badge badge-competition">{match.competition}</span>
              <span className="ltr">{match.kickoffLabel}</span>
              <span>{match.dateLabel}</span>
            </span>
          </div>
        </header>

        {loadError && (
          <p className="link-editor-error" role="alert">{loadError}</p>
        )}

        <div className="link-editor-list">
          {loading ? (
            <p className="link-editor-empty">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              {isArabic ? "جارٍ التحميل…" : "Loading…"}
            </p>
          ) : (
            drafts.map((draft, index) => {
              const fieldErrors = errors[draft.key] ?? {};
              const isExisting = Boolean(draft.id);
              return (
                <fieldset className="link-source" key={draft.key}>
                  <legend className="link-source-legend">
                    <span>
                      {isArabic ? `مصدر ${index + 1}` : `Link source ${index + 1}`}
                      {isExisting && (
                        <span className="link-source-saved">{isArabic ? "محفوظ" : "saved"}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="link-remove"
                      onClick={() => removeRow(draft)}
                      disabled={saving}
                      aria-label={
                        isExisting
                          ? isArabic ? `حذف المصدر ${index + 1} المحفوظ` : `Delete saved source ${index + 1}`
                          : isArabic ? `إزالة المصدر ${index + 1}` : `Remove source ${index + 1}`
                      }
                      title={isExisting
                        ? (isArabic ? "حذف المصدر المحفوظ" : "Delete saved source")
                        : isArabic ? "إزالة" : "Remove"}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      <span>
                        {isExisting ? (isArabic ? "حذف" : "Delete") : isArabic ? "إزالة" : "Remove"}
                      </span>
                    </button>
                  </legend>

                  <div className="link-field-row">
                    <label className="link-field">
                      <span>{isArabic ? "اسم الناقل" : "Broadcaster name"}</span>
                      <input
                        type="text"
                        placeholder={isArabic ? "مثال: beIN SPORTS" : "e.g. beIN SPORTS"}
                        value={draft.provider_name}
                        onChange={(event) => patchDraft(draft.key, { provider_name: event.target.value })}
                        aria-invalid={Boolean(fieldErrors.provider_name)}
                        disabled={draft.saving}
                      />
                      {fieldErrors.provider_name && (
                        <em className="link-field-error">{fieldErrors.provider_name}</em>
                      )}
                    </label>

                    <label className="link-field">
                      <span>{isArabic ? "الأولوية" : "Priority"}</span>
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step={1}
                        value={draft.priority}
                        onChange={(event) => patchDraft(draft.key, { priority: event.target.value })}
                        aria-invalid={Boolean(fieldErrors.priority)}
                        disabled={draft.saving}
                      />
                      {fieldErrors.priority && (
                        <em className="link-field-error">{fieldErrors.priority}</em>
                      )}
                    </label>
                  </div>

                  <label className="link-field">
                    <span>{isArabic ? "الرابط" : "URL"}</span>
                    <input
                      type="url"
                      dir="ltr"
                      inputMode="url"
                      placeholder="https://…"
                      value={draft.stream_url}
                      onChange={(event) => patchDraft(draft.key, { stream_url: event.target.value })}
                      aria-invalid={Boolean(fieldErrors.stream_url)}
                      disabled={draft.saving}
                    />
                    {fieldErrors.stream_url && (
                      <em className="link-field-error">{fieldErrors.stream_url}</em>
                    )}
                  </label>

                  <div className="link-field-row">
                    <label className="link-field">
                      <span>{isArabic ? "النوع" : "Type"}</span>
                      <select
                        value={draft.stream_type}
                        onChange={(event) =>
                          patchDraft(draft.key, { stream_type: event.target.value as FixtureStreamType })
                        }
                        disabled={draft.saving}
                      >
                        <option value="external">{isArabic ? "رابط ناقل رسمي" : "Official broadcaster link"}</option>
                        <option value="embed">{isArabic ? "تضمين (embed)" : "Embed"}</option>
                        <option value="hls">{isArabic ? "بث HLS" : "HLS stream"}</option>
                      </select>
                    </label>

                    <label className="link-check">
                      <input
                        type="checkbox"
                        checked={draft.active}
                        onChange={(event) => patchDraft(draft.key, { active: event.target.checked })}
                        disabled={draft.saving}
                      />
                      <span>{isArabic ? "مُفعّل" : "Enabled"}</span>
                    </label>
                  </div>

                  {draft.saving && (
                    <p className="link-source-status" role="status">
                      <Loader2 size={12} className="spin" aria-hidden="true" />
                      {isArabic ? "جارٍ الحفظ…" : "Saving…"}
                    </p>
                  )}
                  {draft.result?.ok && (
                    <p className="link-source-status ok" role="status">
                      <CheckCircle2 size={12} aria-hidden="true" />
                      {isArabic ? "تم الحفظ" : "Saved"}
                    </p>
                  )}
                  {draft.result && !draft.result.ok && (
                    <p className="link-source-status fail" role="alert">
                      <AlertTriangle size={12} aria-hidden="true" />
                      {draft.result.message} — {isArabic ? "أعد المحاولة" : "retry"}
                    </p>
                  )}

                  {/* Deleting a SAVED source is confirmed separately: the trash
                      button only reveals this, it never deletes directly. */}
                  {draft.id && confirmDeleteId === draft.id && (
                    <div
                      className="link-row-confirm"
                      role="alertdialog"
                      aria-label={isArabic ? "تأكيد حذف المصدر المحفوظ" : "Confirm deleting the saved source"}
                    >
                      <span>
                        {isArabic
                          ? `حذف المصدر المحفوظ «${draft.provider_name}»؟ لا يمكن التراجع.`
                          : `Delete the saved source "${draft.provider_name}"? This cannot be undone.`}
                      </span>
                      <button
                        type="button"
                        className="link-confirm danger"
                        onClick={() => deleteSaved(draft)}
                        disabled={saving}
                      >
                        {isArabic ? "حذف نهائي" : "Delete"}
                      </button>
                      <button type="button" className="link-confirm" onClick={() => setConfirmDeleteId(null)}>
                        {isArabic ? "إلغاء" : "Cancel"}
                      </button>
                    </div>
                  )}
                </fieldset>
              );
            })
          )}
        </div>

        {!loading && (
          <button type="button" className="link-add-source" onClick={addSource} disabled={saving}>
            <Plus size={14} aria-hidden="true" />
            {isArabic ? "إضافة مصدر آخر" : "Add another link source"}
          </button>
        )}

        <p className="link-editor-hint">
          {isArabic
            ? "أضف روابط الناقلين الرسميين الموثّقين فقط. الأولوية الأعلى تُعرض أولاً."
            : "Only add links for verified official broadcasters. Higher priority is listed first."}
        </p>

        {summary && (
          <p className={summary.failed > 0 ? "link-editor-error" : "link-editor-notice"} role="status">
            {summary.failed === 0
              ? isArabic
                ? `تم حفظ ${summary.saved} مصدر.`
                : `Saved ${summary.saved} source${summary.saved === 1 ? "" : "s"}.`
              : isArabic
                ? `تم حفظ ${summary.saved} وفشل ${summary.failed}. راجع الأخطاء أعلاه وأعد المحاولة.`
                : `Saved ${summary.saved}, failed ${summary.failed}. Review the errors above and retry.`}
          </p>
        )}

        {errorCount > 0 && !summary && (
          <p className="link-editor-error" role="alert">
            {isArabic ? "راجع الحقول المميّزة بالأخطاء." : "Please fix the highlighted fields."}
          </p>
        )}

        <div className="link-editor-actions">
          <button
            type="button"
            className="primary-action link-save"
            onClick={saveAll}
            disabled={saving || loading}
          >
            {saving && <Loader2 size={14} className="spin" aria-hidden="true" />}
            {saving
              ? isArabic ? "جارٍ الحفظ…" : "Saving…"
              : isArabic ? "حفظ التغييرات" : "Save changes"}
          </button>
          <button
            type="button"
            className="secondary-action link-close-action"
            onClick={requestClose}
            disabled={saving}
          >
            {isArabic ? "إغلاق" : "Close"}
          </button>
        </div>
      </div>
    </div>,
    // The overlay is attached to `document.body`, not to the match card. This
    // is what makes it cover the whole viewport and escape the card's stacking
    // context (see the note at the top of this file).
    document.body,
  );
}