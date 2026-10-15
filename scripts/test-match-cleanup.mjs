/**
 * Tests for the two admin features:
 *
 *   1. Today's visitor statistics on the homepage — admins only.
 *   2. Automatic deletion of matches six hours after kickoff.
 *
 *   node scripts/test-match-cleanup.mjs
 *
 * The cleanup logic is exercised through the REAL `purgeExpiredMatches` and its
 * REAL pure helpers (`isMatchExpired`, `expiredCandidateDate`) transpiled from
 * src, against a small in-memory fake of the three Supabase tables. That fake
 * mirrors migration 005/006's schema and the delete ordering in the module, so a
 * pass reflects shipped behaviour — including associated-record deletion and
 * repeat runs. No database or network is used.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");
const OUT = path.join(ROOT, ".match-cleanup-test-build");
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
    // Leave already-resolved file URLs and relative specifiers untouched; only
    // a bare module path (e.g. an absolute build path) needs converting.
    p.startsWith(".") || p.startsWith("file:") ? m : `from ${JSON.stringify(pathToFileURL(p).href)}`,
  );
  const finalJs = withImports.replace(/from\s+("(?:\.\/|\.\.\/)[^"]*")/g, (m, p) => {
    const resolved = path.resolve(OUT, JSON.parse(p));
    return `from ${JSON.stringify(pathToFileURL(resolved).href)}`;
  });
  writeFileSync(outFile, finalJs);
  const url = pathToFileURL(outFile).href;
  built.set(cacheKey, url);
  return url;
}

// --- load the real modules --------------------------------------------------
const cleanupUrl = build("src/lib/sports/match-cleanup.ts");
const { isMatchExpired, expiredCandidateDate, purgeExpiredMatches, MATCH_GRACE_HOURS, CLEANUP_BATCH_SIZE } =
  await import(cleanupUrl);
const matchTypesUrl = build("src/lib/sports/match-types.ts");
const { getKickoffInstant } = await import(matchTypesUrl);

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
async function testAsync(name, fn) {
  try {
    await fn();
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

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase client over the match tables, mirroring migrations 005/006/008.
// ─────────────────────────────────────────────────────────────────────────────
function makeDb(seed = {}) {
  return {
    matches: seed.matches ?? [],
    fixture_streams: seed.fixture_streams ?? [],
    official_watch_links: seed.official_watch_links ?? [],
    fixture_import_keys: seed.fixture_import_keys ?? [],
    teams: seed.teams ?? [],
    team_aliases: seed.team_aliases ?? [],
  };
}

/** Minimal chainable query builder implementing only what the module uses. */
function fakeClient(db) {
  return {
    from(table) {
      if (!(table in db)) throw new Error(`unknown table ${table}`);
      const filters = [];
      let limitTo = null;
      let selectCols = "*";
      let mode = "select";
      const api = {
        select(cols = "*") {
          selectCols = cols;
          return api;
        },
        delete() {
          mode = "delete";
          return api;
        },
        lte(column, value) {
          filters.push((row) => row[column] <= value);
          return api;
        },
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return api;
        },
        in(column, values) {
          const set = new Set(values);
          filters.push((row) => set.has(row[column]));
          return api;
        },
        order() {
          return api;
        },
        range(from, to) {
          limitTo = to + 1;
          return api;
        },
        async then(resolve) {
          let rows = db[table].filter((row) => filters.every((f) => f(row)));
          if (mode === "delete") {
            const removed = rows;
            db[table] = db[table].filter((row) => !removed.includes(row));
            const projected = project(removed, selectCols);
            resolve({ data: projected, error: null });
            return;
          }
          if (limitTo != null) rows = rows.slice(0, limitTo);
          resolve({ data: project(rows, selectCols), error: null });
        },
      };
      return api;
    },
  };
}

/** Emulates PostgREST returning only the requested columns. */
function project(rows, cols) {
  if (cols === "*") return rows;
  const wanted = cols.split(",").map((c) => c.trim());
  return rows.map((row) => Object.fromEntries(wanted.map((c) => [c, row[c]])));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("match-cleanup: six-hour cutoff");
eq(MATCH_GRACE_HOURS, 6, "grace window must be six hours");

// A match at 21:00 Riyadh on 2026-10-14. Its instant is 18:00 UTC.
const KICKOFF = { matchDate: "2026-10-14", kickoffTime: "21:00" };
const kickoffIso = getKickoffInstant(KICKOFF.matchDate, KICKOFF.kickoffTime);
eq(kickoffIso, "2026-10-14T18:00:00.000Z", "kickoff must resolve to the Riyadh instant");

test("not expired one second before the window closes", () => {
  // Window closes at 2026-10-15T00:00:00Z (kickoff 18:00Z + 6h).
  eq(isMatchExpired(KICKOFF, new Date("2026-10-14T23:59:59Z")), false);
});
test("not expired exactly at kickoff", () => {
  eq(isMatchExpired(KICKOFF, new Date("2026-10-14T18:00:00Z")), false);
});
test("not expired five hours after kickoff", () => {
  eq(isMatchExpired(KICKOFF, new Date("2026-10-14T23:00:00Z")), false);
});
test("expired exactly at kickoff + six hours (boundary is inclusive)", () => {
  eq(isMatchExpired(KICKOFF, new Date("2026-10-15T00:00:00Z")), true);
});
test("expired well after the window", () => {
  eq(isMatchExpired(KICKOFF, new Date("2026-10-15T06:00:00Z")), true);
});
test("an unparseable match is never treated as expired", () => {
  eq(isMatchExpired({ matchDate: "not-a-date", kickoffTime: "nope" }, new Date("2030-01-01T00:00:00Z")), false);
  eq(isMatchExpired({ matchDate: "", kickoffTime: "" }, new Date("2030-01-01T00:00:00Z")), false);
});

console.log("match-cleanup: timezone boundaries");
// 2026-10-14 23:00 Riyadh == 20:00 UTC → expires at 2026-10-15 05:00 UTC.
test("a late-evening Riyadh match expires six hours after its own instant", () => {
  const late = { matchDate: "2026-10-14", kickoffTime: "23:00" };
  eq(getKickoffInstant(late.matchDate, late.kickoffTime), "2026-10-14T20:00:00.000Z");
  eq(isMatchExpired(late, new Date("2026-10-15T01:59:00Z")), false, "just before six hours");
  eq(isMatchExpired(late, new Date("2026-10-15T02:00:00Z")), true, "at six hours");
});
// 2026-10-15 00:30 Riyadh == 2026-10-14 21:30 UTC. The Riyadh calendar day is
// the 15th, so the candidate date must allow for it.
test("a match just after Riyadh midnight is classified on the correct day", () => {
  const afterMidnight = { matchDate: "2026-10-15", kickoffTime: "00:30" };
  eq(getKickoffInstant(afterMidnight.matchDate, afterMidnight.kickoffTime), "2026-10-14T21:30:00.000Z");
  eq(isMatchExpired(afterMidnight, new Date("2026-10-15T03:30:00Z")), true);
});
test("candidate cutoff date is six hours back in Riyadh time", () => {
  // 2026-10-15 02:00 UTC == 05:00 Riyadh; six hours earlier is 23:00 on the 14th.
  eq(expiredCandidateDate(new Date("2026-10-15T02:00:00Z")), "2026-10-14");
  // Far enough back that the candidate day rolls over: 2026-10-15 08:00 UTC ==
  // 11:00 Riyadh, six hours earlier is 05:00 on the same day.
  eq(expiredCandidateDate(new Date("2026-10-15T08:00:00Z")), "2026-10-15");
});

console.log("match-cleanup: deletion of matches and associated records");
async function runCleanup(db, now, batchSize) {
  return purgeExpiredMatches({ now, batchSize, client: fakeClient(db) });
}

await testAsync("expired match and ALL its dependent records are deleted; teams survive", async () => {
  const db = makeDb({
    matches: [
      { fixture_id: "ML-1", match_date: "2026-10-10", kickoff_time: "21:00" },
      { fixture_id: "ML-2", match_date: "2026-10-20", kickoff_time: "21:00" },
    ],
    fixture_streams: [
      { id: "s1", fixture_id: "ML-1" },
      { id: "s2", fixture_id: "ML-2" },
    ],
    official_watch_links: [
      { id: "w1", fixture_id: "ML-1" },
      { id: "w2", fixture_id: "ML-2" },
    ],
    fixture_import_keys: [
      { id: "k1", source_key: "sheet:1", fixture_id: "ML-1" },
      { id: "k2", source_key: "sheet:2", fixture_id: "ML-2" },
    ],
    teams: [{ id: "t1", team_key: "barcelona" }],
    team_aliases: [{ id: "a1", team_id: "t1", alias_key: "barca" }],
  });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  eq(result.deleted, 1, "exactly the expired match is deleted");
  eq(result.removedStreams, 1, "its stream link is deleted");
  eq(result.removedWatchLinks, 1, "its watch link is deleted");
  eq(result.removedImportKeys, 1, "its import key is deleted");
  eq(db.matches.length, 1, "only the future match remains");
  eq(db.matches[0].fixture_id, "ML-2", "the future match is untouched");
  eq(db.fixture_streams.length, 1, "the future match's stream survives");
  eq(db.fixture_streams[0].fixture_id, "ML-2");
  eq(db.official_watch_links.length, 1, "the future match's watch link survives");
  eq(db.fixture_import_keys.length, 1, "the future match's import key survives");
  eq(db.fixture_import_keys[0].fixture_id, "ML-2");
  eq(db.teams.length, 1, "teams are never deleted");
  eq(db.team_aliases.length, 1, "team aliases are never deleted");
});

await testAsync("no orphaned import key remains, so the fixture can be re-imported", async () => {
  const db = makeDb({
    matches: [{ fixture_id: "ML-1", match_date: "2026-10-10", kickoff_time: "21:00" }],
    fixture_import_keys: [{ id: "k1", source_key: "sheet:1", fixture_id: "ML-1" }],
  });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  eq(result.deleted, 1);
  eq(db.fixture_import_keys.length, 0, "the now-orphaned import key must be gone");
});

await testAsync("historical match already past the cutoff is included", async () => {
  const db = makeDb({
    matches: [
      { fixture_id: "ML-OLD", match_date: "2025-01-01", kickoff_time: "18:00" },
      { fixture_id: "ML-OLD2", match_date: "2024-06-15", kickoff_time: "20:45" },
    ],
  });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  eq(result.deleted, 2, "both historical matches are removed");
  eq(db.matches.length, 0);
});

await testAsync("a match inside the six-hour window is not deleted", async () => {
  const db = makeDb({
    matches: [{ fixture_id: "ML-NOW", match_date: "2026-10-14", kickoff_time: "21:00" }],
    fixture_streams: [{ id: "s", fixture_id: "ML-NOW" }],
  });
  // Kickoff 18:00 UTC; now is 23:00 UTC → five hours later, still protected.
  const result = await runCleanup(db, new Date("2026-10-14T23:00:00Z"));
  eq(result.deleted, 0, "nothing deleted inside the grace window");
  eq(db.matches.length, 1, "the match survives");
  eq(db.fixture_streams.length, 1, "its stream survives");
});

await testAsync("nothing to do is a clean no-op", async () => {
  const db = makeDb({ matches: [{ fixture_id: "ML-F", match_date: "2027-01-01", kickoff_time: "21:00" }] });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  eq(result.deleted, 0);
  eq(result.expired, 0);
  eq(result.error, undefined, "a no-op is not an error");
});

console.log("match-cleanup: repeatable + batch-friendly");
await testAsync("running twice is idempotent (second run deletes nothing)", async () => {
  const db = makeDb({
    matches: [{ fixture_id: "ML-1", match_date: "2026-10-10", kickoff_time: "21:00" }],
    fixture_streams: [{ id: "s1", fixture_id: "ML-1" }],
  });
  const first = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  const second = await runCleanup(db, new Date("2026-10-14T12:00:00Z"));
  eq(first.deleted, 1, "first run deletes the expired match");
  eq(second.deleted, 0, "second run is a no-op");
  eq(db.matches.length, 0);
  eq(db.fixture_streams.length, 0);
});

await testAsync("a full batch reports hasMore so the caller drains the backlog", async () => {
  const db = makeDb({
    matches: Array.from({ length: 5 }, (_, i) => ({
      fixture_id: `ML-${i}`,
      match_date: "2026-10-10",
      kickoff_time: "21:00",
    })),
  });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"), 5);
  eq(result.deleted, 5);
  eq(result.hasMore, true, "a full all-expired batch signals more work");
  eq(db.matches.length, 0);
});

await testAsync("a partial batch reports hasMore:false", async () => {
  const db = makeDb({
    matches: Array.from({ length: 3 }, (_, i) => ({
      fixture_id: `ML-${i}`,
      match_date: "2026-10-10",
      kickoff_time: "21:00",
    })),
  });
  const result = await runCleanup(db, new Date("2026-10-14T12:00:00Z"), 200);
  eq(result.deleted, 3);
  eq(result.hasMore, false, "a partial batch means the backlog is drained");
});
test("default batch size is bounded", () => {
  assert(CLEANUP_BATCH_SIZE > 0 && CLEANUP_BATCH_SIZE <= 1000, "batch size must be a sane bound");
});

console.log("match-cleanup: unconfigured server fails closed");
await testAsync("no service-role client reports configured:false and deletes nothing", async () => {
  const result = await purgeExpiredMatches({ now: new Date("2026-10-14T12:00:00Z"), client: null });
  eq(result.configured, false);
  eq(result.deleted, 0);
  assert(/not configured/i.test(result.error ?? ""), "must explain the missing configuration");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("admin analytics on the homepage: source-level guards");
const homeSrc = readFileSync(path.join(ROOT, "src/components/home-page.tsx"), "utf8");
const panelSrc = readFileSync(path.join(ROOT, "src/components/admin-analytics-panel.tsx"), "utf8");
const sessionSrc = readFileSync(path.join(ROOT, "src/components/use-admin-session.ts"), "utf8");
const cronSrc = readFileSync(path.join(ROOT, "src/app/api/cron/match-cleanup/route.ts"), "utf8");
const collectSrc = readFileSync(path.join(ROOT, "src/app/api/analytics/collect/route.ts"), "utf8");
const statsSrc = readFileSync(path.join(ROOT, "src/app/api/analytics/stats/route.ts"), "utf8");

test("homepage renders the analytics panel only when an admin is confirmed", () => {
  assert(/AdminAnalyticsPanel/.test(homeSrc), "homepage must reuse the existing panel");
  assert(/const showAnalytics = isAdmin/.test(homeSrc), "visibility must derive from the admin flag");
  assert(/\{showAnalytics && \(/.test(homeSrc), "the panel must be conditionally rendered");
});
test("the admin flag can only come from the server-confirmed session", () => {
  assert(/useAdminSession/.test(homeSrc), "homepage must use the server-backed hook");
  assert(/isAdmin:\s*false/.test(sessionSrc), "the hook must start as not-admin");
  assert(/fetch\("\/api\/admin\/session"/.test(sessionSrc), "the hook must ask the server");
  // The only mention of localStorage must be the explanatory comment, never a
  // read that could be forged by a visitor.
  assert(!/localStorage\.(get|set)Item/.test(sessionSrc), "no client-side flag may be trusted");
});
test("the analytics panel itself is admin-gated by the endpoint it calls", () => {
  assert(/\/api\/analytics\/stats/.test(panelSrc), "panel reads the admin endpoint");
  assert(/requireAdminResponse\s*\(/.test(statsSrc), "that endpoint authorises server-side");
});
test("the panel handles loading, error and unavailable states", () => {
  assert(/status:\s*"loading"/.test(panelSrc), "must have a loading state");
  assert(/status:\s*"unavailable"/.test(panelSrc), "must have an unavailable/error state");
  assert(/configured/.test(panelSrc) && /available/.test(panelSrc), "must distinguish not-configured from unavailable");
  assert(/catch\s*\{/.test(panelSrc), "must handle a failed request");
});
test("homepage is not forced dynamic just for the panel", () => {
  assert(!/force-dynamic/.test(homeSrc), "the home page must stay cacheable");
});

console.log("cron endpoint: authorization + visitor exclusion");
test("cron route fails closed without a configured secret", () => {
  assert(/process\.env\.CRON_SECRET/.test(cronSrc), "must read the server secret");
  assert(/if\s*\(!secret\)/.test(cronSrc), "must check for a missing secret");
  assert(/503/.test(cronSrc), "an unconfigured endpoint must answer 503");
});
test("cron route requires a matching bearer secret, compared in constant time", () => {
  assert(/Bearer /.test(cronSrc), "must parse the Authorization header");
  assert(/safeEqual\s*\(/.test(cronSrc), "must compare the secret in constant time");
  assert(/401/.test(cronSrc), "a wrong secret must be rejected");
});
test("the secret is never exposed to the browser", () => {
  assert(!/NEXT_PUBLIC_CRON/.test(cronSrc + collectSrc), "no public cron secret");
});
test("cron invalidation keeps deleted matches out of caches and listings", () => {
  assert(/revalidateFixtureData\s*\(/.test(cronSrc), "must invalidate fixture caches after deletion");
});
test("collect route drops cron/automation requests so they are not visitors", () => {
  assert(/isCronRequest\s*\(/.test(collectSrc), "collect must recognise cron callers");
  assert(/CRON_SECRET/.test(collectSrc), "the recogniser must use the server secret");
  assert(/looksLikeBot\(userAgent\)/.test(collectSrc), "bots/automation are still filtered");
});
test("the cron endpoint never calls the analytics collect route", () => {
  // Match an actual call/fetch, not the explanatory comment in the header.
  assert(!/fetch\([^)]*analytics\/collect/.test(cronSrc), "cron must not record itself as a visitor");
});

// --- report -----------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
console.log(`\nmatch-cleanup tests: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`);
  process.exit(1);
}
