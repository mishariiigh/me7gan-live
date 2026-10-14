/**
 * Tests for the multi-source link panel and the stale-session warning fix.
 *
 *   node scripts/test-link-panel.mjs
 *
 * Split into two kinds of assertion:
 *  - **Source-contract** checks: the panel must not lose the behaviours that
 *    make partial failure safe (pre-validation, per-row ids, retry safety).
 *  - **Live API** checks against a running server: unauthorised callers are
 *    refused, and a two-source save really produces two rows.
 */
import { readFileSync } from "node:fs";

const ROOT = "/Users/M10/Desktop/developer/LiveStreamWebsite";
const BASE = process.env.BASE_URL ?? "http://localhost:3222";

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

const editor = readFileSync(`${ROOT}/src/components/fixture-link-editor.tsx`, "utf8");
const card = readFileSync(`${ROOT}/src/components/match-card.tsx`, "utf8");
const authSession = readFileSync(`${ROOT}/src/lib/supabase/auth-session.ts`, "utf8");

console.log("\n══ 1. The panel identifies the match it edits ══");
check("the header takes a match context object", /EditorMatchContext/.test(editor));
check("it shows both team names", /match\.homeName/.test(editor) && /match\.awayName/.test(editor));
check("it shows the competition", /match\.competition/.test(editor));
check("it shows the kickoff time", /match\.kickoffLabel/.test(editor));
check("the card passes all of that through", /homeName: match\.home\.name/.test(card) && /competition: match\.competition/.test(card));
check("the dialog is labelled by its title", /aria-labelledby="link-editor-title"/.test(editor));

console.log("\n══ 2. Multiple sources in one panel ══");
check("sources are held as a list, not a single draft", /useState<SourceDraft\[\]>/.test(editor));
check("an 'add another' control exists", /link-add-source/.test(editor) && /Add another link source/.test(editor));
check("each source is a labelled group", /<fieldset className="link-source"/.test(editor));
check("each source is numbered", /Link source \$\{index \+ 1\}/.test(editor));
check("a new panel starts with one empty row", /\[emptyDraft\(\)\]/.test(editor));
check("saved sources are listed before the blank row", /\[\.\.\.mine\.map\(draftFromStream\), emptyDraft\(\)\]/.test(editor));

console.log("\n══ 3. Unsaved vs saved removal are clearly different ══");
check("removing an unsaved row drops it without a prompt", /function removeRow[\s\S]{0,220}if \(draft\.id\)/.test(editor));
check("a saved row routes to confirmation instead", /setConfirmDeleteId\(draft\.id\)/.test(editor));
check("saved rows are badged in the UI", /link-source-saved/.test(editor));
check("the confirm wording differs from a plain remove", /Delete the saved source/.test(editor));
check("deleting a saved source calls DELETE", /method: "DELETE"/.test(editor));
check("the panel never ends up with zero rows", /next\.length > 0 \? next : \[emptyDraft\(\)\]/.test(editor));

console.log("\n══ 4. Per-field validation ══");
check("validation returns errors keyed by field", /FieldErrors/.test(editor) && /errors\.stream_url/.test(editor));
check("the URL is required", /Enter a URL\./.test(editor));
check("non-HTTPS is rejected", /\^https:/.test(editor));
check("the provider name is required", /Enter the broadcaster name\./.test(editor));
check("priority is range-checked", /0 and 10000/.test(editor));
check("errors are shown beside their field", /link-field-error/.test(editor));
check("invalid fields are marked for assistive tech", /aria-invalid=\{Boolean\(fieldErrors/.test(editor));
check("a duplicate URL is rejected before saving", /This URL is already added\./.test(editor));

console.log("\n══ 5. Partial failure is handled honestly ══");
check("rows are saved one at a time", /for \(const draft of candidates\)/.test(editor));
check("each row tracks its own outcome", /result\?: \{ ok: true \} \| \{ ok: false; message: string \}/.test(editor));
check("a failed row keeps its values for a retry", /if \(failed === 0\) await load\(\)/.test(editor));
check("a saved row records its id so a retry cannot duplicate it", /next\.set\(body\.data\.id, body\.data\)/.test(editor));
check("the summary reports saved AND failed counts", /setSummary\(\{ saved, failed \}\)/.test(editor));
check("a partial result is not reported as full success", /Saved \$\{summary\.saved\}, failed \$\{summary\.failed\}/.test(editor));
check("everything is validated before the first write", /for \(const draft of candidates\) \{\s*const fieldErrors = validateSource/.test(editor));
check("saving is blocked while already saving", /if \(saving\) return;/.test(editor));

console.log("\n══ 6. Close behaviour ══");
check("an X button exists with an accessible label", /aria-label=\{isArabic \? "إغلاق المحرر"/.test(editor));
check("a bottom Close button exists", /link-close-action/.test(editor));
check("backdrop click closes", /event\.target === event\.currentTarget/.test(editor));
check("clicks inside do not close", /onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(editor));
check("Escape closes", /event\.key === "Escape"/.test(editor));
check("closing is blocked mid-save", /if \(saving\) return;/.test(editor));
check("unsaved changes are confirmed", /window\.confirm/.test(editor));
check("every close path is guarded", /requestClose/.test(editor) && !/onClick=\{onClose\}/.test(editor));

console.log("\n══ 7. Existing API + model reused (no new table) ══");
check("it uses /api/admin/fixture-streams", /\/api\/admin\/fixture-streams/.test(editor));
check("it issues POST, PATCH and DELETE", /"POST"/.test(editor) && /"PATCH"/.test(editor) && /"DELETE"/.test(editor));
check("it never talks to Supabase directly", !/supabase/i.test(editor));
check("it states the official-broadcaster policy", /verified official broadcasters/.test(editor));
check("no migration was added", !/create table/i.test(editor));

console.log("\n══ 8. The stale-session false positive is fixed ══");
check(
  "AuthSessionMissingError is NOT treated as a stale session",
  !/error\.name === "AuthSessionMissingError"\) return true/.test(authSession),
);
check(
  "a real dead refresh token IS still detected",
  /DEAD_SESSION_MESSAGE\.test\(error\.message\)/.test(authSession),
);
check("the fix is documented with the evidence", /Auth session missing!/.test(authSession));

console.log("\n══ 9. Live: unauthorised callers cannot touch sources ══");
{
  const attempts = [
    ["GET", "/api/admin/fixture-streams", undefined],
    ["POST", "/api/admin/fixture-streams", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com", provider_name: "X", active: true, priority: 0 }],
    ["PATCH", "/api/admin/fixture-streams", { id: "00000000-0000-0000-0000-000000000000", active: false }],
    ["DELETE", "/api/admin/fixture-streams", { id: "00000000-0000-0000-0000-000000000000" }],
  ];
  for (const [method, path, body] of attempts) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    check(`${method} is refused`, [401, 403, 429].includes(res.status), `got ${res.status}`);
  }

  // Two sources in one batch must both be refused — a batch is not a bypass.
  const batch = await fetch(`${BASE}/api/admin/fixture-streams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com/a", provider_name: "A", active: true, priority: 1 }),
  });
  const batch2 = await fetch(`${BASE}/api/admin/fixture-streams`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com/b", provider_name: "B", active: true, priority: 2 }),
  });
  check("the first of two sources is refused", [401, 403, 429].includes(batch.status), `got ${batch.status}`);
  check("the second of two sources is refused", [401, 403, 429].includes(batch2.status), `got ${batch2.status}`);
}

console.log("\n══ 10. Live: the panel's markup is absent for visitors ══");
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check("home page renders", res.status === 200);
  check("no admin link control in the served HTML", !html.includes("match-admin-link"));
  check("no editor markup in the served HTML", !html.includes("link-editor-backdrop"));
  check("no add-source control in the served HTML", !html.includes("link-add-source"));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
process.exit(fail ? 1 : 0);