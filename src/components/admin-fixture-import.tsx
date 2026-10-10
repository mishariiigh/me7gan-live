"use client";

import { useRef, useState } from "react";
import { AlertTriangle, Check, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { COMPETITIONS } from "@/lib/sports/competitions";
import { FIELD_LABELS, REQUIRED_FIELDS, type FieldName } from "@/lib/sports/fixture-import-fields";

/**
 * Excel fixture import panel for the admin console.
 *
 * Three explicit steps so nothing is written by accident:
 *   choose file → preview → confirm.
 *
 * The preview is produced by the server from the very same file that the commit
 * re-uploads, so what the admin approves is what gets written.
 */

type PreviewItem = {
  row: number;
  matchDate: string;
  kickoffTime: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  action: "create" | "update";
  changes?: string[];
  /** Non-fatal notes, e.g. a team name that stayed mis-encoded. */
  warnings?: string[];
};

type RejectedItem = { row: number; raw: Record<string, string>; reasons: string[] };

type Preview = {
  mode: "preview";
  headers: string[];
  mapping: Record<FieldName, string | null>;
  totalRows: number;
  creates: PreviewItem[];
  updates: PreviewItem[];
  rejected: RejectedItem[];
  summary: { toCreate: number; toUpdate: number; rejected: number; warned?: number };
};

type CommitResult = {
  mode: "commit";
  imported: number;
  updated: number;
  skipped: number;
  rejected: number;
  failures?: { row: number; reason: string }[];
  message: string;
};

export default function AdminFixtureImport({ onImported }: { onImported?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [missingFields, setMissingFields] = useState<FieldName[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldName, string>>>({});
  const [headers, setHeaders] = useState<string[]>([]);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  // Competition applied to every row when the file has no competition column.
  const [competition, setCompetition] = useState("");
  /**
   * Whether the server found a competition column. When it did not, the manual
   * competition selector is shown immediately rather than only after a failed
   * preview — otherwise nothing could satisfy the requirement and the admin
   * would be stuck looking at an error they had no way to clear.
   */
  const [hasCompetitionColumn, setHasCompetitionColumn] = useState(true);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError("");
    setMissingFields([]);
    setMapping({});
    setHeaders([]);
    setSheetNames([]);
    setSheet("");
    setCompetition("");
    if (inputRef.current) inputRef.current.value = "";
  };

  /** Sends the selected file to the server, with the current column mapping. */
  async function send(mode: "preview" | "commit") {
    if (!file) {
      setError("اختر ملف Excel أولاً (Choose a spreadsheet first).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("mode", mode);
      body.append("mapping", JSON.stringify(mapping));
      if (sheet) body.append("sheet", sheet);
      if (competition) body.append("competition", competition);

      const response = await fetch("/api/admin/fixtures/import", { method: "POST", body });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        // A mapping failure response carries the detected headers, the sheet
        // list and which fields are still missing, so the admin can map the
        // columns by hand instead of being shown a dead-end error.
        if (Array.isArray(payload.headers)) setHeaders(payload.headers as string[]);
        if (Array.isArray(payload.sheetNames)) setSheetNames(payload.sheetNames as string[]);
        if (Array.isArray(payload.missingFields)) setMissingFields(payload.missingFields as FieldName[]);
        if (typeof payload.hasCompetitionColumn === "boolean") {
          setHasCompetitionColumn(payload.hasCompetitionColumn);
        }
        if (payload.mapping && typeof payload.mapping === "object") {
          // Seed the selects with what was detected, so only the gaps need work.
          // Undetected fields arrive as null and must not overwrite an existing
          // choice, so they are dropped rather than stored as null.
          const detected: Partial<Record<FieldName, string>> = {};
          for (const [field, header] of Object.entries(payload.mapping as Record<string, unknown>)) {
            if (typeof header === "string" && header) detected[field as FieldName] = header;
          }
          // Detected values are applied last so they always populate the selects.
          // Spreading `current` on top would let a stale empty entry blank out a
          // column the server had just identified.
          setMapping((current) => ({ ...current, ...detected }));
        }
        setError(typeof payload.error === "string" ? payload.error : "تعذر معالجة الملف (Could not process the file).");
        setPreview(null);
        return;
      }

      setMissingFields([]);
      setHasCompetitionColumn(true);
      if (mode === "preview") {
        setPreview(payload as Preview);
        setResult(null);
      } else {
        setResult(payload as CommitResult);
        setPreview(null);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
        onImported?.();
      }
    } catch {
      setError("تعذر الاتصال بالخادم (Could not reach the server).");
    } finally {
      setBusy(false);
    }
  }

  const needsMapping = missingFields.length > 0;
  // The selectors are useful as soon as the file's columns are known: to fill a
  // gap the server reported, or to name the competition for a single-league file
  // before previewing. Either reason is enough to show them.
  const showSelectors = headers.length > 0 && (needsMapping || !hasCompetitionColumn);

  return (
    <section className="admin-section">
      <div className="admin-block-heading fixture-stream-heading">
        <div>
          <span className="eyebrow">EXCEL IMPORT</span>
          <h2>استيراد المباريات من Excel</h2>
        </div>
      </div>

      <div className="stream-warning">
        <FileSpreadsheet size={17} />
        <span>
          يُقبل ‎.xlsx و‎.csv (بما فيها الملفات بترميز UTF-8 مع BOM والفواصل المنقوطة أو الجدولة). الأعمدة المطلوبة:
          التاريخ، وقت البداية، البطولة، الفريق المضيف، الفريق الضيف — ويمكن دمج الفريقين في عمود واحد بصيغة
          «المضيف ضد الضيف»، أو دمج التاريخ والوقت في عمود واحد. إن لم يوجد عمود للبطولة يمكنك اختيارها يدوياً.
          الاستيراد يضيف الجديد ويحدّث الموجود، ولا يحذف أي مباراة أو رابط بث. الأوقات بتوقيت الرياض.
        </span>
      </div>

      <div className="import-panel">
        <label className="import-drop" htmlFor="fixture-file">
          <Upload size={20} aria-hidden="true" />
          <strong>{file ? file.name : "اختر ملف ‎.xlsx أو ‎.csv"}</strong>
          <small>{file ? `${Math.round(file.size / 1024)} كيلوبايت` : "Excel أو CSV · بحد أقصى 2 ميجابايت"}</small>
          <input
            id="fixture-file"
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/vnd.ms-excel"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError("");
              setMissingFields([]);
            }}
          />
        </label>

        <div className="import-actions">
          <button className="primary-action" type="button" disabled={busy || !file} onClick={() => void send("preview")}>
            <RefreshCw size={16} aria-hidden="true" />
            {busy ? "جارٍ التحقق…" : "معاينة قبل الاستيراد"}
          </button>
          {file && (
            <button className="secondary-action" type="button" onClick={reset}>إلغاء</button>
          )}
        </div>

        {error && (
          <div className="import-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {/* Worksheet chooser — appears once the workbook's sheets are known. */}
        {sheetNames.length > 1 && (
          <label className="admin-field import-sheet-picker">
            <span>ورقة العمل / Worksheet</span>
            <select
              value={sheet}
              onChange={(event) => { setSheet(event.target.value); setPreview(null); }}
            >
              <option value="">تلقائي — اختر الورقة الأفضل</option>
              {sheetNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )}

        {/*
          Column mapping. Shown whenever the server could not confidently
          identify every required column, seeded with whatever it did detect so
          only the gaps need attention.
        */}
        {showSelectors && (
          <div className="import-mapping">
            <p className="import-mapping-note">
              {needsMapping
                ? "لم يتم التعرف على كل الأعمدة تلقائياً. الأعمدة المكتشفة من ملفك معروضة أدناه — اختر العمود المقابل لكل حقل مطلوب ثم أعد المعاينة. الحقول المكتشفة مسبقاً محددة بالفعل."
                : "ملفك لا يحتوي على عمود للبطولة. اختر البطولة التي تنطبق على كل مباريات الملف (Your file has no competition column — choose the competition that applies to every fixture in it)."}
            </p>
            <div className="import-mapping-grid">
              {REQUIRED_FIELDS.map((field) => {
                const isMissing = missingFields.includes(field);
                return (
                  <label className={`admin-field${isMissing ? " import-field-missing" : ""}`} key={field}>
                    <span>
                      {FIELD_LABELS[field]}
                      {isMissing && <b aria-hidden="true"> *</b>}
                    </span>
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value }))}
                    >
                      <option value="">— اختر عموداً —</option>
                      {headers.map((header) => (
                        <option key={header} value={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>

            {/* Shown whenever the file has no competition column, so the
                requirement can be satisfied before previewing rather than
                only being reported as an error afterwards. */}
            {!hasCompetitionColumn && (
              <label className="admin-field import-competition-picker">
                <span>
                  البطولة لكل المباريات / Competition for this import
                  <b aria-hidden="true"> *</b>
                </span>
                <select value={competition} onChange={(event) => setCompetition(event.target.value)}>
                  <option value="">— اختر بطولة —</option>
                  {COMPETITIONS.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
            )}

            <button className="secondary-action" type="button" disabled={busy} onClick={() => void send("preview")}>
              إعادة المعاينة بالأعمدة المختارة
            </button>
          </div>
        )}
      </div>

      {/* ── PREVIEW ──────────────────────────────────────────────────────── */}
      {preview && (
        <div className="import-preview">
          <div className="import-summary">
            <Stat label="جديد" value={preview.summary.toCreate} tone="ok" />
            <Stat label="سيتم تحديثه" value={preview.summary.toUpdate} tone="info" />
            <Stat label="مرفوض" value={preview.summary.rejected} tone={preview.summary.rejected ? "bad" : "muted"} />
            <Stat label="إجمالي الصفوف" value={preview.totalRows} tone="muted" />
            {preview.summary.warned ? (
              <Stat label="تنبيهات" value={preview.summary.warned} tone="info" />
            ) : null}
          </div>

          {preview.rejected.length > 0 && (
            <div className="import-rejected">
              <h3><AlertTriangle size={15} aria-hidden="true" /> صفوف مرفوضة ({preview.rejected.length})</h3>
              <ul>
                {preview.rejected.slice(0, 40).map((item) => (
                  <li key={item.row}>
                    <strong>السطر {item.row}</strong>
                    <span>{item.reasons.join(" · ")}</span>
                  </li>
                ))}
              </ul>
              {preview.rejected.length > 40 && (
                <p className="import-more">و {preview.rejected.length - 40} صفاً آخر…</p>
              )}
              <p className="import-mapping-note">
                لن يتم الاستيراد حتى تُصحَّح هذه الصفوف، لأن الاستيراد الجزئي يصعب تتبعه. صحّح الملف ثم أعد الرفع —
                إعادة الرفع آمنة ولا تُنشئ نسخاً مكررة.
              </p>
            </div>
          )}

          {(preview.creates.length > 0 || preview.updates.length > 0) && (
            <div className="admin-table-block">
              <div className="admin-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>الإجراء</th>
                      <th>التاريخ</th>
                      <th>الوقت</th>
                      <th>البطولة</th>
                      <th>المضيف</th>
                      <th>الضيف</th>
                      <th>ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...preview.creates, ...preview.updates].map((item) => (
                      <tr key={`${item.action}-${item.row}`}>
                        <td>{item.row}</td>
                        <td>
                          <span className={item.action === "create" ? "status-tag online" : "status-tag"}>
                            {item.action === "create" ? "جديد" : "تحديث"}
                          </span>
                        </td>
                        <td>{item.matchDate}</td>
                        <td dir="ltr">{item.kickoffTime}</td>
                        <td>{item.competition}</td>
                        <td>{item.homeTeam}</td>
                        <td>{item.awayTeam}</td>
                        <td className="import-changes">
                          {item.changes?.length ? item.changes.join(" · ") : "—"}
                          {item.warnings?.map((warning) => (
                            <span className="import-row-warning" key={warning}>⚠ {warning}</span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="import-actions">
            <button
              className="primary-action"
              type="button"
              disabled={busy || preview.summary.rejected > 0}
              onClick={() => void send("commit")}
            >
              <Check size={16} aria-hidden="true" />
              {busy ? "جارٍ الاستيراد…" : `تأكيد الاستيراد (${preview.summary.toCreate + preview.summary.toUpdate})`}
            </button>
            <button className="secondary-action" type="button" onClick={reset}>إلغاء</button>
          </div>
        </div>
      )}

      {/* ── RESULT ───────────────────────────────────────────────────────── */}
      {result && (
        <div className="import-result" role="status">
          <Check size={17} aria-hidden="true" />
          <div>
            <strong>{result.message}</strong>
            <div className="import-summary">
              <Stat label="جديد" value={result.imported} tone="ok" />
              <Stat label="محدّث" value={result.updated} tone="info" />
              <Stat label="مرفوض" value={result.rejected} tone={result.rejected ? "bad" : "muted"} />
            </div>
            {result.failures?.length ? (
              <ul className="import-failures">
                {result.failures.map((failure) => (
                  <li key={failure.row}>السطر {failure.row}: {failure.reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "info" | "bad" | "muted" }) {
  return (
    <div className={`import-stat ${tone}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
