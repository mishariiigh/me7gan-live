/**
 * Tests for the stale-session log dedup and the modal close logic.
 *
 *   node scripts/test-auth-logging.mjs
 *
 * Runs the REAL modules (transpiled from src), so a passing test reflects
 * shipped behaviour.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");

const OUT = path.join(ROOT, ".auth-log-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function build(relPath) {
  let src = readFileSync(path.join(ROOT, relPath), "utf8");
  src = src.replace('import "server-only";', "");
  src = src.replace(/from\s+["']@\/([^"']+)["']/g, (_, target) => {
    const dep = target.endsWith(".ts") ? `src/${target}` : `src/${target}.ts`;
    return `from ${JSON.stringify(build(dep))}`;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outPath = path.join(OUT, `${relPath.replace(/[/]/g, "_").replace(/\.ts$/, "")}.mjs`);
  writeFileSync(outPath, js);
  return pathToFileURL(outPath).href;
}

const A = await import(build("src/lib/supabase/auth-session.ts"));

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

console.log("\n══ 1. Dead-session detection still works ══");
check("refresh_token_not_found is detected", A.isDeadSessionError({ code: "refresh_token_not_found" }));
check("the live 'Invalid Refresh Token' message is detected", A.isDeadSessionError({ code: "validation_failed", message: "Invalid Refresh Token: Refresh Token Not Found" }));
check("an unrelated error is not detected", A.isDeadSessionError({ code: "invalid_credentials" }) === false);
check("null is not detected", A.isDeadSessionError(null) === false);

// ── The false positive that made the warning appear for every visitor ──────
// Supabase returns AuthSessionMissingError whenever there is simply no session
// in storage, which is the ordinary state of a logged-out visitor. Classifying
// it as "stale cookies" made every anonymous request to /admin log the warning
// and attempt a pointless clear. Verified against the live auth server:
//   no cookie   -> AuthSessionMissingError   (NOT stale)
//   dead cookie -> AuthApiError / validation_failed (stale)
console.log("\n══ 1b. A logged-out visitor is NOT a stale session ══");
check(
  "AuthSessionMissingError is not treated as a dead session",
  A.isDeadSessionError({ name: "AuthSessionMissingError", message: "Auth session missing!" }) === false,
);
check(
  "the 'Auth session missing!' message is not treated as stale",
  A.isDeadSessionError({ message: "Auth session missing!" }) === false,
);
check(
  "a real dead refresh token IS still detected",
  A.isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Refresh token is not valid" }),
);

console.log("\n══ 2. One condition logs once, regardless of which path saw it ══");
{
  A.resetDeadSessionLogForTests();

  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(String(args[0]));

  try {
    // Simulate the two independent observers of the SAME stale cookie: the
    // proxy (on /admin/*) and the auth path (session endpoint / admin pages).
    A.logDeadSessionOnce("proxy", undefined);
    A.logDeadSessionOnce("auth", undefined);
    // And repeated observations, as happens on every request while the cookie
    // is still in the browser.
    A.logDeadSessionOnce("proxy", undefined);
    A.logDeadSessionOnce("auth", undefined);
    A.logDeadSessionOnce("proxy", undefined);
  } finally {
    console.warn = originalWarn;
  }

  check("exactly ONE line for one condition across all paths", lines.length === 1, `${lines.length} lines: ${JSON.stringify(lines)}`);
  check("the line reports which path noticed it first", /^\[proxy\]/.test(lines[0] ?? ""), lines[0] ?? "(none)");
  check("the line is the expected informational message", /stale Supabase session cookies detected/.test(lines[0] ?? ""));
}

console.log("\n══ 3. Distinct conditions still log separately ══");
{
  A.resetDeadSessionLogForTests();
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(String(args[0]));
  try {
    A.logDeadSessionOnce("proxy", "refresh_token_not_found");
    A.logDeadSessionOnce("auth", "refresh_token_not_found"); // same -> deduped
    A.logDeadSessionOnce("proxy", "session_expired");        // different -> new line
  } finally {
    console.warn = originalWarn;
  }
  check("two distinct codes produce two lines", lines.length === 2, `${lines.length}`);
  check("the first code is reported once", lines.filter((l) => l.includes("refresh_token_not_found")).length === 1);
}

console.log("\n══ 4. No sensitive material is logged ══");
{
  A.resetDeadSessionLogForTests();
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    A.logDeadSessionOnce("proxy", "refresh_token_not_found");
  } finally {
    console.warn = originalWarn;
  }
  const text = lines.join(" ");
  check("no token-looking string is present", !/eyJ|base64-|refresh_token["':]/i.test(text), text);
  check("no cookie name/value is present", !/sb-[a-z0-9]+-auth-token=/i.test(text), text);
}

console.log("\n══ 5. The dedup memory is shared across bundles ══");
{
  // Next compiles the middleware and route handlers into separate bundles, each
  // with its own copy of the module. A module-level Set would give each copy
  // its own memory and the duplicate would return. The memory must therefore
  // live on a shared global.
  const source = readFileSync(path.join(ROOT, "src/lib/supabase/auth-session.ts"), "utf8");
  check("the log memory is not a plain module-level Set", !/^const logged = new Set/m.test(source));
  check("the log memory is keyed on globalThis via Symbol.for", /Symbol\.for\(/.test(source) && /globalThis/.test(source));
}

console.log("\n══ 6. Modal close guards (source contract) ══");
{
  const editor = readFileSync(path.join(ROOT, "src/components/fixture-link-editor.tsx"), "utf8");

  check("an X close button exists with an accessible label", /aria-label=\{isArabic \? "إغلاق المحرر"/.test(editor));  check("a bottom Close action exists", /link-close-action/.test(editor));
  check("backdrop click closes", /event\.target === event\.currentTarget/.test(editor));
  check("clicks inside the dialog do not close", /onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(editor));
  check("Escape still closes", /event\.key === "Escape"/.test(editor));
  check("closing is blocked while a write is in flight", /if \(saving\) return;/.test(editor));
  check("unsaved changes are confirmed before closing", /window\.confirm/.test(editor));
  check("dirty state is computed, not assumed", /const hasUnsavedChanges = useMemo/.test(editor) && /isDirty\(draft, originals\)/.test(editor));
  check("all close paths go through the guarded requestClose", /requestClose/.test(editor) && !/onClick=\{onClose\}/.test(editor));
  check("focus is moved into the dialog on open", /dialogRef\.current\?\.querySelector<HTMLElement>\("input, select, button"\)\?\.focus\(\)/.test(editor));
  // Strengthened: `overflow: hidden` alone does not stop iOS Safari scrolling
  // the page behind a fixed overlay, so the body is also pinned and the scroll
  // offset restored. See test-modal-portal.mjs for the full contract.
  check(
    "background scroll is locked and restored",
    /body\.style\.overflow = "hidden"/.test(editor) && /body\.style\.position = "fixed"/.test(editor),
  );
  check("the scroll offset is restored on close", /window\.scrollTo\(0, previous\.scrollY\)/.test(editor));
}

console.log("\n══ 7. The editor still uses the existing admin API ══");
{
  const editor = readFileSync(path.join(ROOT, "src/components/fixture-link-editor.tsx"), "utf8");
  check("it writes to /api/admin/fixture-streams", /\/api\/admin\/fixture-streams/.test(editor));
  check("it performs POST, PATCH and DELETE", /"POST"/.test(editor) && /"PATCH"/.test(editor) && /"DELETE"/.test(editor));
  check("it does not import a Supabase client directly", !/supabase/i.test(editor));
  check("it refuses non-HTTPS URLs client-side", /\^https:\\\/\\\//.test(editor));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
rmSync(OUT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);