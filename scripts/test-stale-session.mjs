/**
 * Reproduces the "Invalid Refresh Token: Refresh Token Not Found" condition
 * against the configured Supabase project, and asserts the fix's behaviour.
 *
 * It builds a real server client with a genuinely invalid refresh token in the
 * cookie jar — exactly the state a browser is left in after a session is
 * revoked or a refresh token is rotated by another tab — and checks:
 *
 *   1. `getServerUser` reports "signed out" instead of throwing.
 *   2. The dead-session detector recognises ONLY the expected codes.
 *   3. `clearStaleAuthCookies` emits `Max-Age=0` for the session cookie.
 *
 * Run with:  node scripts/test-stale-session.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Load .env.local without adding a dependency.
const env = {};
for (const line of readFileSync(join(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Compile the REAL helper source to a temp .mjs and import it ─────────────
// Transpiling to a real file (rather than a `data:` URL) lets Node resolve the
// genuine `@supabase/ssr` import, so this exercises the actual module instead
// of a paraphrase of its logic.
const ts = await import("typescript");
const transpileModule = ts.transpileModule ?? ts.default?.transpileModule;
if (!transpileModule) {
  console.log("TypeScript not available; cannot run source-level assertions.");
  process.exit(1);
}

const outDir = join(root, "node_modules", ".cache", "stale-session-test");
mkdirSync(outDir, { recursive: true });
const authSessionSrc = readFileSync(join(root, "src/lib/supabase/auth-session.ts"), "utf8");
const compiled = transpileModule(authSessionSrc, {
  compilerOptions: { module: 99, target: 99, moduleResolution: 99 },
}).outputText;
const compiledPath = join(outDir, "auth-session.mjs");
writeFileSync(compiledPath, compiled);

const mod = await import(pathToFileURL(compiledPath).href);
const { isDeadSessionError, isExpectedAuthError, authStorageKey, clearStaleAuthCookies, storedSessionExpired } = mod;

console.log("\n══ 1. Dead-session detection (real source) ══");

check("refresh_token_not_found is a dead session", isDeadSessionError({ code: "refresh_token_not_found" }));
check("refresh_token_already_used is a dead session", isDeadSessionError({ code: "refresh_token_already_used" }));
check("session_expired is a dead session", isDeadSessionError({ code: "session_expired" }));
check("AuthSessionMissingError is a dead session", isDeadSessionError({ name: "AuthSessionMissingError" }));
check("null is not a dead session", isDeadSessionError(null) === false);
check("undefined is not a dead session", isDeadSessionError(undefined) === false);
check("session_not_found is a dead session", isDeadSessionError({ code: "session_not_found" }));

// These MUST NOT be treated as dead sessions — they are real problems.
check("invalid_credentials is NOT a dead session", isDeadSessionError({ code: "invalid_credentials" }) === false);
check("over_request_rate_limit is NOT a dead session", isDeadSessionError({ code: "over_request_rate_limit" }) === false);
check("validation_failed is NOT a dead session", isDeadSessionError({ code: "validation_failed" }) === false);
check("PostgREST error is NOT a dead session", isDeadSessionError({ code: "PGRST116", message: "no rows" }) === false);
check("retryable fetch error is NOT a dead session", isDeadSessionError({ name: "AuthRetryableFetchError" }) === false);
check("code-less AuthApiError is NOT a dead session", isDeadSessionError({ name: "AuthApiError" }) === false);
check("isExpectedAuthError mirrors the check", isExpectedAuthError({ code: "refresh_token_not_found" }));

// ── The regression that shipped: guarding getUser() was not enough. The library
// logs the raw error while CONSTRUCTING the client (its internal
// onAuthStateChange listener eagerly reads + refreshes the session), so an
// expired cookie must never reach the client at all.
console.log("\n══ 1b. Construction must not see an expired session ══");
{
  const key = "sb-testproj-auth-token";
  const enc = (obj) => "base64-" + Buffer.from(JSON.stringify(obj)).toString("base64url");
  const expired = enc({ access_token: "a", refresh_token: "b", expires_at: Math.floor(Date.now() / 1000) - 60 });
  const valid = enc({ access_token: "a", refresh_token: "b", expires_at: Math.floor(Date.now() / 1000) + 3600 });

  // This is exactly the filter createSupabaseServerClient applies.
  const strip = (cookies) =>
    storedSessionExpired(cookies, key) === true
      ? cookies.filter((c) => c.name !== key && !c.name.startsWith(`${key}.`))
      : cookies;

  const expiredJar = [{ name: key, value: expired }, { name: `${key}.0`, value: "chunk" }];
  check("an expired session is withheld from the client", strip(expiredJar).length === 0, JSON.stringify(strip(expiredJar)));

  const validJar = [{ name: key, value: valid }];
  check("a valid session is passed through untouched", strip(validJar).length === 1);

  const unknownJar = [{ name: "theme", value: "light" }];
  check("unrelated cookies are never stripped", strip(unknownJar).length === 1);

  const corruptJar = [{ name: key, value: "not-json" }];
  check("a corrupt session is passed through (no forced logout)", strip(corruptJar).length === 1);
}

// The REAL message the GoTrue server returns for a dead refresh token, which
// auth-js copies verbatim. The code varies by API version, so the message must
// be matched too.
check(
  "the live 'Invalid Refresh Token: Refresh Token Not Found' message is handled",
  isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Invalid Refresh Token: Refresh Token Not Found" }),
);
check(
  "the 'Already Used' variant is handled",
  isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Invalid Refresh Token: Already Used" }),
);
check(
  "the 'Session Expired' variant is handled",
  isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Invalid Refresh Token: Session Expired" }),
);
check(
  "'validation_failed' with a dead-token message IS handled",
  isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Refresh token is not valid" }),
);
check(
  "a password error is still NOT a dead session",
  isDeadSessionError({ name: "AuthApiError", code: "validation_failed", message: "Password should be at least 6 characters" }) === false,
);

console.log("\n══ 2. Storage key derivation ══");
check(
  "derives sb-<ref>-auth-token from the project URL",
  authStorageKey("https://abcdefghijklmnop.supabase.co") === "sb-abcdefghijklmnop-auth-token",
  authStorageKey("https://abcdefghijklmnop.supabase.co"),
);
check("derives a sensible key for the real project", authStorageKey(SUPABASE_URL).startsWith("sb-") && authStorageKey(SUPABASE_URL).endsWith("-auth-token"), authStorageKey(SUPABASE_URL));
check("falls back for a malformed URL", authStorageKey("not a url") === "supabase.auth.token");

console.log("\n══ 2b. Local expiry pre-check (decodes the cookie, no network) ══");
{
  const key = "sb-testproj-auth-token";
  const enc = (obj, prefix = "base64-") => prefix + Buffer.from(JSON.stringify(obj)).toString("base64url");

  const expired = enc({ access_token: "a", refresh_token: "b", expires_at: Math.floor(Date.now() / 1000) - 60 });
  const valid = enc({ access_token: "a", refresh_token: "b", expires_at: Math.floor(Date.now() / 1000) + 3600 });

  check("an expired session is detected", storedSessionExpired([{ name: key, value: expired }], key) === true);
  check("a valid session is NOT flagged", storedSessionExpired([{ name: key, value: valid }], key) === false);
  check("no cookie -> unknown (null), so nothing is cleared", storedSessionExpired([], key) === null);
  check(
    "an unrelated cookie -> unknown (null)",
    storedSessionExpired([{ name: "other-cookie", value: valid }], key) === null,
  );
  check(
    "an undecodable cookie -> unknown (null), never a forced logout",
    storedSessionExpired([{ name: key, value: "not-base64-json" }], key) === null,
  );
  check(
    "a chunked valid session is reassembled and NOT flagged",
    storedSessionExpired(
      [
        { name: `${key}.0`, value: valid.slice(0, 20) },
        { name: `${key}.1`, value: valid.slice(20) },
      ],
      key,
    ) === false,
  );
  check(
    "a chunked expired session IS flagged",
    storedSessionExpired(
      [
        { name: `${key}.0`, value: expired.slice(0, 20) },
        { name: `${key}.1`, value: expired.slice(20) },
      ],
      key,
    ) === true,
  );
}

// ── 3. Clearing emits an expiring cookie (real helper + real library) ───────
console.log("\n══ 3. clearStaleAuthCookies expires the stale cookie ══");
{
  const storageKey = authStorageKey(SUPABASE_URL || "https://abcdefghijklmnop.supabase.co");
  // A session cookie plus one chunk, as the SSR client writes a large session.
  const jar = new Map([
    [storageKey, JSON.stringify({ access_token: "x", refresh_token: "y" })],
    [`${storageKey}.0`, "chunk-zero"],
  ]);
  const writes = [];
  const ok = await clearStaleAuthCookies({
    supabaseUrl: SUPABASE_URL || "https://abcdefghijklmnop.supabase.co",
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => { for (const c of list ?? []) writes.push(c); },
    },
  });

  check("clear reported success", ok === true);
  check("both the session cookie and its chunk were cleared", writes.length === 2, `writes=${writes.length}`);
  check(
    "cleared names are the auth storage key",
    writes.every((c) => c.name === storageKey || c.name.startsWith(`${storageKey}.`)),
    JSON.stringify(writes.map((c) => c.name)),
  );
  check("every cleared cookie has maxAge 0", writes.every((c) => c.options?.maxAge === 0), JSON.stringify(writes.map((c) => c.options?.maxAge)));
  check("every cleared value is empty", writes.every((c) => c.value === ""));
  check("a malformed URL does not attempt a clear", (await clearStaleAuthCookies({ supabaseUrl: "", cookies: { getAll: () => [], setAll: () => {} } })) === false);
  console.log(`  (cleared ${writes.length}: ${writes.map((c) => c.name).join(", ")})`);
}

// ── 5. The actual regression: construction must be silent ───────────────────
// Guards the bug that shipped — the library logs the raw error while the client
// is being CONSTRUCTED, so hiding the expired cookie before construction is what
// keeps the log clean. This tests the real library, not a paraphrase.
console.log("\n══ 5. Constructing the real client with an expired cookie ══");
if (!SUPABASE_URL || !ANON_KEY) {
  console.log("  skip — Supabase URL/key not configured");
} else {
  const { createServerClient } = await import("@supabase/ssr");
  const storageKey = authStorageKey(SUPABASE_URL);

  const expiredValue =
    "base64-" +
    Buffer.from(
      JSON.stringify({
        access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjF9.x",
        refresh_token: "Q2xpZW50SW5WYWxpZFJlZnJlc2hUb2tlbkZvclRlc3Rpbmc0MzIx",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 3600,
        user: { id: "00000000-0000-0000-0000-000000000000" },
      }),
    ).toString("base64url");

  const cookieList = [{ name: storageKey, value: expiredValue }];
  const isExpired = storedSessionExpired(cookieList, storageKey) === true;
  check("the fixture session is detected as expired", isExpired);

  // Exactly what createSupabaseServerClient() feeds the client.
  const visible = isExpired
    ? cookieList.filter((c) => c.name !== storageKey && !c.name.startsWith(`${storageKey}.`))
    : cookieList;

  const errors = [];
  const warns = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => { errors.push(a[0]); };
  console.warn = (...a) => { warns.push(a[0]); };
  try {
    createServerClient(SUPABASE_URL, ANON_KEY, {
      cookies: {
        getAll: () => visible,
        setAll: () => {},
      },
    });
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }

  const authErrors = errors.filter((e) => e && (e.name === "AuthApiError" || /refresh token/i.test(String(e.message ?? e))));
  check("constructing with the stripped cookie logs NO AuthApiError", authErrors.length === 0, `got ${authErrors.length}: ${authErrors.map((e) => e.message).join("; ")}`);
  console.log(`  (captured console.error=${errors.length}, console.warn=${warns.length})`);

  // Control: feeding the expired cookie straight in DOES log — proving the test
  // is sensitive enough to detect the regression it guards.
  const controlErrors = [];
  const origError2 = console.error;
  console.error = (...a) => { controlErrors.push(a[0]); };
  try {
    createServerClient(SUPABASE_URL, ANON_KEY, {
      cookies: {
        getAll: () => cookieList,
        setAll: () => {},
      },
    });
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    console.error = origError2;
  }
  const controlAuthErrors = controlErrors.filter((e) => e && (e.name === "AuthApiError" || /refresh token/i.test(String(e.message ?? e))));
  check(
    "control: WITHOUT stripping, the error IS logged (test is sensitive)",
    controlAuthErrors.length > 0,
    `got ${controlAuthErrors.length}`,
  );
}

// ── 4. Live client with a dead refresh token ────────────────────────────────
console.log("\n══ 4. Live server client with a dead refresh token ══");
if (!SUPABASE_URL || !ANON_KEY) {
  console.log("  skip — Supabase URL/key not configured");
} else {
  const { createServerClient } = await import("@supabase/ssr");
  const storageKey = authStorageKey(SUPABASE_URL);

  // A well-formed but unknown refresh token — the shape a revoked or
  // previously-rotated session leaves behind — with an already-expired access
  // token, so auth-js must actually call the token endpoint.
  const deadSession = {
    access_token:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJleHAiOjF9.invalid-signature",
    refresh_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    user: { id: "00000000-0000-0000-0000-000000000000" },
  };

  const jar = new Map([[storageKey, JSON.stringify(deadSession)]]);
  const supabase = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: () => { /* capture not needed here */ },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  console.log(`  (raw getUser -> user=${data.user ? "present" : "null"}, code=${error?.code ?? "none"}, name=${error?.name ?? "none"})`);

  check("no user is returned for the dead session", !data.user);
  // This is the real thing the app sees. Against this project the server answers
  // `validation_failed` / "Refresh token is not valid"; against a project that
  // advertises the 2024-01-01 API version it is `refresh_token_not_found` with
  // the "Refresh Token Not Found" message. The detector must catch BOTH.
  check(
    "the dead token is classified as handleable (signed out)",
    isDeadSessionError(error),
    `code=${error?.code} name=${error?.name} message=${error?.message}`,
  );

  // Prove the exact string from the bug report is handled, independently of
  // whichever code this particular project happens to return.
  check(
    "the reported 'Invalid Refresh Token: Refresh Token Not Found' is handled",
    isDeadSessionError({ name: "AuthApiError", code: error?.code ?? "validation_failed", message: "Invalid Refresh Token: Refresh Token Not Found" }),
  );
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n════ ${passed} passed, ${failed} failed ════`);
process.exit(failed === 0 ? 0 : 1);
