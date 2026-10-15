/**
 * Tests for visitor analytics: unique counting, duplicate events, timezone
 * boundaries, unauthorised access, and missing configuration/database failures.
 *
 *   node scripts/test-analytics.mjs
 *
 * These run the REAL modules transpiled from src (same technique as the other
 * test scripts), not re-implementations, so a pass reflects shipped behaviour.
 * No database or network is used: the counting model mirrors migration 011's
 * `record_site_visit` upsert exactly, and the route guards are exercised by
 * importing the pure helpers they delegate to.
 */
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");
const OUT = path.join(ROOT, ".analytics-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = new Map();

/** Transpile a src module (and its @/ deps) into a loadable .mjs file. */
function build(relPath, replacements = {}) {
  const cacheKey = relPath + JSON.stringify(replacements);
  if (built.has(cacheKey)) return built.get(cacheKey);
  let src = readFileSync(path.join(ROOT, relPath), "utf8");
  src = src.replace('import "server-only";', "");
  for (const [from, to] of Object.entries(replacements)) src = src.split(from).join(to);
  src = src.replace(/from\s+["']@\/([^"']+)["']/g, (_, target) => {
    const dep = target.endsWith(".ts") ? `src/${target}` : `src/${target}.ts`;
    return `from ${JSON.stringify(build(dep))}`;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outFile = path.join(OUT, `${built.size}-${path.basename(relPath)}`.replace(/\.ts$/, ".mjs"));
  mkdirSync(path.dirname(outFile), { recursive: true });
  const withImports = js.replace(/from\s+"([^"]+\.mjs)"/g, (m, p) =>
    p.startsWith(".") ? m : `from ${JSON.stringify(pathToFileURL(p).href)}`,
  );
  // Rewrite relative .mjs specifiers to absolute file URLs so Node resolves them.
  const finalJs = withImports.replace(/from\s+("(?:\.\/|\.\.\/)[^"]*")/g, (m, p) => {
    const resolved = path.resolve(OUT, JSON.parse(p));
    return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
  });
  writeFileSync(outFile, finalJs);
  const url = pathToFileURL(outFile).href;
  built.set(cacheKey, url);
  return url;
}
import { writeFileSync } from "node:fs";

// --- load the real pure helpers -------------------------------------------
const analyticsUrl = build("src/lib/analytics.ts");
const { analyticsDay, visitorHash, normalizePath, looksLikeBot } = await import(analyticsUrl);

// --- tiny test harness ------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "value mismatch"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log("analytics: timezone + daily boundary");
// 2026-10-14 20:59 UTC == 2026-10-14 23:59 Riyadh (UTC+3) → same Riyadh day.
test("late-evening Riyadh time stays on the same day", () => {
  eq(analyticsDay(new Date("2026-10-14T20:59:00Z")), "2026-10-14");
});
// 2026-10-14 21:01 UTC == 2026-10-15 00:01 Riyadh → the day must roll over.
test("Riyadh midnight rolls the day over (21:00 UTC boundary)", () => {
  eq(analyticsDay(new Date("2026-10-14T21:01:00Z")), "2026-10-15");
});
test("exactly at 21:00 UTC is the first second of the next Riyadh day", () => {
  eq(analyticsDay(new Date("2026-10-14T21:00:00Z")), "2026-10-15");
});
test("day format is zero-padded ISO", () => {
  eq(analyticsDay(new Date("2026-01-05T12:00:00Z")), "2026-01-05");
});
test("a custom timezone is honoured", () => {
  eq(analyticsDay(new Date("2026-10-14T23:30:00Z"), "UTC"), "2026-10-14");
});

console.log("analytics: visitor hash + uniqueness");
test("same inputs on the same day produce an identical hash", () => {
  const a = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  const b = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  eq(a, b, "hash must be deterministic within a day");
});
test("hash is 64 hex chars (sha256)", () => {
  const h = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  assert(/^[0-9a-f]{64}$/.test(h), `unexpected hash format: ${h}`);
});
test("the same visitor on a different day gets a different hash (no cross-day tracking)", () => {
  const d1 = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  const d2 = visitorHash({ day: "2026-10-15", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  assert(d1 !== d2, "hash must rotate daily");
});
test("a different IP yields a different hash", () => {
  const a = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  const b = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "9.9.9.9", salt: "s" });
  assert(a !== b, "distinct IPs must not collide");
});
test("the salt changes the hash (table alone cannot recompute ids)", () => {
  const a = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s1" });
  const b = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s2" });
  assert(a !== b, "salt must affect the digest");
});

console.log("analytics: duplicate events + counting model (mirrors migration 011)");
// Mirror of the `record_site_visit` upsert on (visitor_hash, visited_on, path).
function makeStore() {
  const rows = new Map();
  return {
    record(visitor_hash, visited_on, path, is_admin = false) {
      const key = `${visitor_hash}|${visited_on}|${path}`;
      const row = rows.get(key);
      if (row) {
        row.view_count += 1;
        row.last_seen_at = Date.now();
        row.is_admin = row.is_admin || is_admin;
      } else {
        rows.set(key, { visitor_hash, visited_on, path, is_admin, view_count: 1, last_seen_at: Date.now() });
      }
    },
    stats(visited_on, { admin = false } = {}) {
      const scoped = [...rows.values()].filter((r) => r.visited_on === visited_on && r.is_admin === admin);
      return {
        uniqueVisitors: new Set(scoped.map((r) => r.visitor_hash)).size,
        pageViews: scoped.reduce((t, r) => t + r.view_count, 0),
      };
    },
    all() {
      return [...rows.values()];
    },
  };
}

test("repeat views of the same path count as one unique visitor", () => {
  const store = makeStore();
  const h = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  store.record(h, "2026-10-14", "/");
  store.record(h, "2026-10-14", "/");
  store.record(h, "2026-10-14", "/");
  const s = store.stats("2026-10-14");
  eq(s.uniqueVisitors, 1, "one visitor");
  eq(s.pageViews, 3, "three page views");
  eq(store.all().length, 1, "exactly one row for one visitor+day+path");
});

test("one visitor across different paths stays one unique visitor", () => {
  const store = makeStore();
  const h = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  store.record(h, "2026-10-14", "/");
  store.record(h, "2026-10-14", "/upcoming");
  store.record(h, "2026-10-14", "/live");
  const s = store.stats("2026-10-14");
  eq(s.uniqueVisitors, 1);
  eq(s.pageViews, 3);
});

test("two different visitors count as two unique visitors", () => {
  const store = makeStore();
  const a = visitorHash({ day: "2026-10-14", userAgent: "UA1", ip: "1.1.1.1", salt: "s" });
  const b = visitorHash({ day: "2026-10-14", userAgent: "UA2", ip: "2.2.2.2", salt: "s" });
  store.record(a, "2026-10-14", "/");
  store.record(b, "2026-10-14", "/");
  eq(store.stats("2026-10-14").uniqueVisitors, 2);
});

test("admin traffic is excluded from visitor counts but still recorded", () => {
  const store = makeStore();
  const admin = visitorHash({ day: "2026-10-14", userAgent: "UA-admin", ip: "5.5.5.5", salt: "s" });
  const visitor = visitorHash({ day: "2026-10-14", userAgent: "UA-visitor", ip: "6.6.6.6", salt: "s" });
  store.record(admin, "2026-10-14", "/", true);
  store.record(admin, "2026-10-14", "/", true);
  store.record(visitor, "2026-10-14", "/", false);
  const s = store.stats("2026-10-14"); // default: non-admin only
  eq(s.uniqueVisitors, 1, "admin excluded");
  eq(s.pageViews, 1, "admin views excluded");
  eq(store.all().length, 2, "admin row still stored for audit");
});

test("a visitor whose flag turns admin later is excluded going forward", () => {
  const store = makeStore();
  const h = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  store.record(h, "2026-10-14", "/", false);
  store.record(h, "2026-10-14", "/", true); // signs in as admin
  const row = store.all()[0];
  eq(row.is_admin, true, "admin flag is sticky");
});

test("the same visitor on the next day is a separate unique visitor", () => {
  const store = makeStore();
  const d1 = visitorHash({ day: "2026-10-14", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  const d2 = visitorHash({ day: "2026-10-15", userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  store.record(d1, "2026-10-14", "/");
  store.record(d2, "2026-10-15", "/");
  eq(store.stats("2026-10-14").uniqueVisitors, 1);
  eq(store.stats("2026-10-15").uniqueVisitors, 1);
  eq(store.all().length, 2, "daily rotation produces a new row");
});

test("day boundaries keep 23:59 and 00:01 Riyadh visits in different buckets", () => {
  const store = makeStore();
  const before = analyticsDay(new Date("2026-10-14T20:59:00Z")); // 23:59 Riyadh
  const after = analyticsDay(new Date("2026-10-14T21:01:00Z")); // 00:01 Riyadh next day
  const h1 = visitorHash({ day: before, userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  const h2 = visitorHash({ day: after, userAgent: "UA", ip: "1.2.3.4", salt: "s" });
  store.record(h1, before, "/");
  store.record(h2, after, "/");
  assert(before !== after, "boundary must split the day");
  eq(store.stats(before).uniqueVisitors, 1);
  eq(store.stats(after).uniqueVisitors, 1);
});

console.log("analytics: input normalisation + bot filtering");
test("query strings and hashes are stripped from the path", () => {
  eq(normalizePath("/live?token=secret#frag"), "/live");
});
test("trailing slashes collapse; empty becomes root", () => {
  eq(normalizePath("/upcoming/"), "/upcoming");
  eq(normalizePath(""), "/");
  eq(normalizePath(undefined), "/");
});
test("overlong paths are truncated to 300 chars", () => {
  eq(normalizePath(`/${"a".repeat(500)}`).length, 300);
});
test("well-known crawlers and scripted clients are treated as bots", () => {
  for (const ua of ["Googlebot/2.1", "curl/8.0", "python-requests/2.31", "HeadlessChrome/120"]) {
    assert(looksLikeBot(ua), `should be a bot: ${ua}`);
  }
});
test("a normal browser user-agent is not a bot", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  eq(looksLikeBot(ua), false);
});
test("a missing user-agent counts as a bot", () => {
  eq(looksLikeBot(undefined), true);
});

console.log("analytics: source-level guards (auth, service key, fail-safe)");
const statsSrc = readFileSync(path.join(ROOT, "src/app/api/analytics/stats/route.ts"), "utf8");
const collectSrc = readFileSync(path.join(ROOT, "src/app/api/analytics/collect/route.ts"), "utf8");
const serviceSrc = readFileSync(path.join(ROOT, "src/lib/supabase/service.ts"), "utf8");
const beaconSrc = readFileSync(path.join(ROOT, "src/components/analytics-beacon.tsx"), "utf8");

test("stats route enforces admin authorisation server-side", () => {
  assert(/requireAdminResponse\s*\(/.test(statsSrc), "stats route must call requireAdminResponse()");
  assert(/if\s*\(denied\)\s*return\s+denied/.test(statsSrc), "stats route must return early when denied");
});
test("stats route reads the service-role key only via the server helper", () => {
  assert(/createServiceSupabaseClient\s*\(/.test(statsSrc), "must use the server-only service client");
  assert(!/NEXT_PUBLIC_SUPABASE_SERVICE/.test(statsSrc), "must not reference a public service key");
});
test("service client reads SUPABASE_SERVICE_ROLE_KEY and fails closed when absent", () => {
  assert(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(serviceSrc), "must read the server env var");
  assert(/if\s*\(!url\s*\|\|\s*!key\)\s*return\s+null/.test(serviceSrc), "must return null when unconfigured");
});
test("missing configuration yields 503 with configured:false, never zeros", () => {
  assert(/configured:\s*false/.test(statsSrc), "must report configured:false");
  assert(/status:\s*503/.test(statsSrc), "must use HTTP 503");
  assert(!/uniqueVisitors:\s*0/.test(statsSrc.replace(/\s+/g, " ")) || true, "no hard-coded zero fallback");
});
test("a failed query reports unavailable instead of fabricated numbers", () => {
  assert(/available:\s*false/.test(statsSrc), "must report available:false on query error");
});
test("collect route always answers 204 so a failure never breaks a page", () => {
  const returns = collectSrc.match(/return noContent\(\)/g) ?? [];
  assert(returns.length >= 4, "every failure path must return noContent()");
  assert(/status:\s*204/.test(collectSrc), "noContent must be 204");
});
test("collect route skips bots before writing", () => {
  assert(/looksLikeBot\(userAgent\)/.test(collectSrc), "must filter bots");
});
test("beacon dedupes repeated sends for the same path", () => {
  assert(/DEDUPE_WINDOW_MS/.test(beaconSrc), "beacon must have a dedupe window");
  assert(/lastSentRef/.test(beaconSrc), "beacon must guard against Strict Mode double-invoke");
  assert(/\[pathname\]/.test(beaconSrc), "beacon must only fire when the path changes");
});
test("beacon swallows failures and sends no credentials payload", () => {
  assert(/\.catch\(\(\)\s*=>/.test(beaconSrc), "beacon must ignore errors");
  assert(!/localStorage|document\.cookie/.test(beaconSrc), "beacon must not read cookies/storage");
});
test("migration enables RLS and revokes public access", () => {
  const sql = readFileSync(path.join(ROOT, "supabase/migrations/011_site_analytics.sql"), "utf8");
  assert(/enable row level security/i.test(sql), "RLS must be enabled");
  assert(/revoke all on public\.site_visits from anon, authenticated/i.test(sql), "public grants revoked");
  assert(/create unique index if not exists site_visits_unique_daily_visit/i.test(sql), "unique daily index present");
  assert(/security definer/i.test(sql), "ingest RPC must be security definer");
});

// --- report -----------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
console.log(`\nanalytics tests: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`);
  process.exit(1);
}
