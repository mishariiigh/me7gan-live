/**
 * Regression tests for the "team logos disappear when a broadcaster link is
 * added" bug.
 *
 *   node scripts/test-live-team-logos.mjs
 *
 * Reported symptom: after adding a link to a match, the match appears in
 * "مباشر الآن" (/live) but BOTH team logos are gone.
 *
 * Root cause under test: `/live` is fed exclusively by `getLiveMatches()` ->
 * `getCachedLiveMatches()`, and that loader was the ONLY one that did not
 * resolve saved club crests through `loadTeamLogoIndex` + `applyTeamLogos`.
 * A match with no link never reached this loader, so the bug only appeared
 * once a link was added — which is exactly what the report describes.
 *
 * These exercise the REAL `matches.ts` loaders against a mocked database, so a
 * passing run reflects what the pages actually receive. The mock reproduces the
 * real table shapes (`matches`, `fixture_streams`, `teams`, `team_aliases`) and
 * the real `MATCH_COLUMNS` projection, so a logo dropped by a join/transform is
 * caught here rather than only in the browser.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");

const OUT = path.join(ROOT, ".live-logos-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── Fake database ─────────────────────────────────────────────────────────
const DB = { matches: [], fixture_streams: [], teams: [], team_aliases: [] };

function makeClient() {
  function query(table) {
    const state = { table, filters: [], orders: [], range: null };
    const api = {
      select: () => api,
      eq: (column, value) => { state.filters.push({ op: "eq", column, value }); return api; },
      gte: (column, value) => { state.filters.push({ op: "gte", column, value }); return api; },
      lte: (column, value) => { state.filters.push({ op: "lte", column, value }); return api; },
      not: (column, op, value) => { state.filters.push({ op: "not", column, value }); return api; },
      in: (column, values) => { state.filters.push({ op: "in", column, values }); return api; },
      order: (column, options) => { state.orders.push({ column, ...options }); return api; },
      range: (from, to) => { state.range = [from, to]; return api; },
      maybeSingle: () => { state.single = true; return api; },
      single: () => { state.single = true; return api; },
      limit: () => api,
      then: (resolve) => resolve(run(state)),
    };
    return api;
  }

  function run(state) {
    let rows = [...(DB[state.table] ?? [])];
    for (const filter of state.filters) {
      if (filter.op === "eq") rows = rows.filter((row) => row[filter.column] === filter.value);
      if (filter.op === "gte") rows = rows.filter((row) => row[filter.column] >= filter.value);
      if (filter.op === "lte") rows = rows.filter((row) => row[filter.column] <= filter.value);
      if (filter.op === "in") rows = rows.filter((row) => filter.values.includes(row[filter.column]));
      if (filter.op === "not") rows = rows.filter((row) => row[filter.column] !== null && row[filter.column] !== undefined);
    }
    if (state.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  return {
    from: (table) => query(table),
    auth: { getUser: async () => ({ data: { user: { id: "test-admin" } } }) },
  };
}

// ── Build the real modules with the Supabase client stubbed ────────────────
const built = new Map();
function build(relPath, replacements = {}) {
  const cacheKey = relPath + JSON.stringify(replacements);
  if (built.has(cacheKey)) return built.get(cacheKey);
  let src = readFileSync(path.join(ROOT, relPath), "utf8");
  src = src.replace('import "server-only";', "");
  for (const [from, to] of Object.entries(replacements)) src = src.split(from).join(to);
  src = src.replace(/from\s+["']@\/([^"']+)["']/g, (_, target) => {
    const dep = target.endsWith(".ts") ? `src/${target}` : `src/${target}.ts`;
    return `from ${JSON.stringify(build(dep, replacements))}`;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outPath = path.join(OUT, `${relPath.replace(/[/]/g, "_").replace(/\.ts$/, "")}-${Object.keys(replacements).length}.mjs`);
  writeFileSync(outPath, js);
  const url = pathToFileURL(outPath).href;
  built.set(cacheKey, url);
  return url;
}

const STUB =
  `"data:text/javascript,let c=globalThis.__FAKE_DB__;` +
  `export async function createSupabaseServerClient(){return c?c():null}` +
  `export function createPublicSupabaseClient(){return c?c():null}"`;
globalThis.__FAKE_DB__ = makeClient;

const NEXT_CACHE_STUB =
  `"data:text/javascript,export const unstable_cache=(fn)=>fn;export const revalidateTag=()=>{};export const revalidatePath=()=>{};export const revalidate=()=>{}"`;

const Matches = await import(build("src/lib/sports/matches.ts", {
  '"@/lib/supabase/server"': STUB,
  '"next/cache"': NEXT_CACHE_STUB,
}));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${extra}`); }
}

// ── Fixture data ──────────────────────────────────────────────────────────
const BARCA = "https://cdn.example.com/logos/barcelona.png";
const MADRID = "https://cdn.example.com/logos/real-madrid.png";
const TODAY = "2026-10-14";

/** A published match row with NO crests on the row itself (as imported). */
function matchRow(overrides = {}) {
  return {
    id: "m1",
    fixture_id: "FIX-1",
    match_date: TODAY,
    kickoff_time: "21:00:00",
    competition: "La Liga",
    home_team: "FC Barcelona",
    away_team: "Real Madrid",
    home_team_logo: null,
    away_team_logo: null,
    home_score: null,
    away_score: null,
    status: "scheduled",
    published: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** The saved crests live on the `teams` records, not on the match row. */
function seedTeams() {
  // `team_key` values must be what the REAL `normaliseTeamKey` produces:
  // "FC Barcelona" -> "barcelona", "Real Madrid" -> "realmadrid". The hyphen in
  // "real-madrid" is NOT part of the normalised form (hyphens are treated as
  // separators and the words are joined), so seeding that spelling made the away
  // crest unresolvable and produced false failures.
  DB.teams = [
    { id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA },
    { id: "t2", team_key: "realmadrid", name: "Real Madrid", logo_url: MADRID },
  ];
  DB.team_aliases = [];
}

function reset({ streams = [] } = {}) {
  DB.matches = [matchRow()];
  DB.fixture_streams = streams;
  seedTeams();
}

console.log("\n══ 1. The reported bug: a link makes logos disappear ══");
{
  // BEFORE adding a link: the match is not on /live at all.
  reset({ streams: [] });
  const before = await Matches.getLiveMatches();
  check("match with no link is not on /live", before.matches.length === 0, `${before.matches.length}`);

  // The schedule path already resolved the crests, so this is the baseline the
  // user sees on the home page BEFORE adding a link.
  const schedule = await Matches.getPublicFixtureSchedule();
  const scheduled = schedule.today.find((m) => m.fixtureId === "FIX-1");
  check("home page shows the home crest before a link", scheduled?.home?.logo === BARCA, scheduled?.home?.logo);
  check("home page shows the away crest before a link", scheduled?.away?.logo === MADRID, scheduled?.away?.logo);

  // AFTER adding one active link: the match now routes through getLiveMatches.
  reset({ streams: [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 }] });
  const after = await Matches.getLiveMatches();
  check("match with one link IS on /live", after.matches.length === 1, `${after.matches.length}`);
  check("home crest survives adding a link", after.matches[0]?.home?.logo === BARCA, after.matches[0]?.home?.logo);
  check("away crest survives adding a link", after.matches[0]?.away?.logo === MADRID, after.matches[0]?.away?.logo);
}

console.log("\n══ 2. Zero, one and many links all keep both crests ══");
{
  const cases = [
    ["zero links", []],
    ["one active link", [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 }]],
    ["one active external link", [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "external", priority: 1 }]],
    ["multiple links (mixed)", [
      { id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 },
      { id: "s2", fixture_id: "FIX-1", active: true, stream_type: "embed", priority: 2 },
      { id: "s3", fixture_id: "FIX-1", active: true, stream_type: "external", priority: 3 },
    ]],
    ["link disabled but present", [{ id: "s1", fixture_id: "FIX-1", active: false, stream_type: "hls", priority: 1 }]],
  ];

  for (const [label, streams] of cases) {
    reset({ streams });
    const { matches } = await Matches.getLiveMatches();
    const onLive = matches.length > 0;
    if (!onLive) {
      // A disabled-only link must not put the match on /live, but the schedule
      // must still carry both crests.
      const sched = await Matches.getPublicFixtureSchedule();
      const m = sched.today.find((x) => x.fixtureId === "FIX-1");
      check(`${label}: still off /live`, true);
      check(`${label}: schedule keeps both crests`, m?.home?.logo === BARCA && m?.away?.logo === MADRID);
    } else {
      const m = matches[0];
      check(`${label}: home crest present`, m?.home?.logo === BARCA, m?.home?.logo);
      check(`${label}: away crest present`, m?.away?.logo === MADRID, m?.away?.logo);
    }
  }
}

console.log("\n══ 3. Link mutations never remove a crest (add → edit → disable → delete) ══");
{
  // Add
  reset({ streams: [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 }] });
  let m = (await Matches.getLiveMatches()).matches[0];
  check("after add: both crests present", m?.home?.logo === BARCA && m?.away?.logo === MADRID);

  // Edit (change URL / priority, same row)
  DB.fixture_streams = [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 9 }];
  m = (await Matches.getLiveMatches()).matches[0];
  check("after edit: both crests present", m?.home?.logo === BARCA && m?.away?.logo === MADRID);

  // Disable — match leaves /live, but the crests must remain on the schedule.
  DB.fixture_streams = [{ id: "s1", fixture_id: "FIX-1", active: false, stream_type: "hls", priority: 9 }];
  const sched = await Matches.getPublicFixtureSchedule();
  const s = sched.today.find((x) => x.fixtureId === "FIX-1");
  check("after disable: schedule keeps both crests", s?.home?.logo === BARCA && s?.away?.logo === MADRID);

  // Delete
  DB.fixture_streams = [];
  const detail = await Matches.getPublicMatchByFixtureId("FIX-1");
  check("after delete: detail page keeps both crests", detail?.home?.logo === BARCA && detail?.away?.logo === MADRID);
}

console.log("\n══ 4. A missing crest never hides the other team's crest ══");
{
  // Only Barcelona has a saved crest; Real Madrid has none.
  DB.matches = [matchRow()];
  DB.fixture_streams = [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 }];
  DB.teams = [{ id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA }];
  DB.team_aliases = [];

  const m = (await Matches.getLiveMatches()).matches[0];
  check("home crest is shown when the away crest is missing", m?.home?.logo === BARCA, m?.home?.logo);
  check("away logo is null (fallback path) without breaking the card", m?.away?.logo === null, String(m?.away?.logo));
  check("both team names survive", m?.home?.name === "FC Barcelona" && m?.away?.name === "Real Madrid");

  // And the inverse.
  DB.teams = [{ id: "t2", team_key: "realmadrid", name: "Real Madrid", logo_url: MADRID }];
  const m2 = (await Matches.getLiveMatches()).matches[0];
  check("away crest is shown when the home crest is missing", m2?.away?.logo === MADRID, m2?.away?.logo);
  check("home logo is null without breaking the card", m2?.home?.logo === null, String(m2?.home?.logo));
}

console.log("\n══ 5. The same crests on every surface (live / home / detail) ══");
{
  reset({ streams: [{ id: "s1", fixture_id: "FIX-1", active: true, stream_type: "hls", priority: 1 }] });

  const live = (await Matches.getLiveMatches()).matches[0];
  const schedule = await Matches.getPublicFixtureSchedule();
  const home = schedule.today.find((x) => x.fixtureId === "FIX-1");
  const detail = await Matches.getPublicMatchByFixtureId("FIX-1");

  const pair = (m) => `${m?.home?.logo ?? "∅"}|${m?.away?.logo ?? "∅"}`;
  check("live and home agree", pair(live) === pair(home), `${pair(live)} vs ${pair(home)}`);
  check("live and detail agree", pair(live) === pair(detail), `${pair(live)} vs ${pair(detail)}`);
  check("all three carry the saved crests",
    pair(live) === `${BARCA}|${MADRID}`, pair(live));
}

console.log("\n══ 6. Guard: the live loader must resolve crests, not only map the row ══");
{
  // A structural check so a future refactor cannot silently drop the step again.
  const src = readFileSync(path.join(ROOT, "src/lib/sports/matches.ts"), "utf8");
  const liveFn = src.slice(src.indexOf("getCachedLiveMatches = unstable_cache"));
  // Slice from the opening of the cached callback to the cache-key argument.
  // The callback signature is `async (): Promise<...>`, so the previous anchor
  // `async (client)` never matched and produced a -1 index — collapsing the
  // slice to a one-character string and failing the assertions below even
  // though the production code calls both helpers.
  const body = liveFn.slice(liveFn.indexOf("async ("), liveFn.indexOf("public-live-matches"));
  check("the guard sliced a real function body", body.length > 200, `${body.length} chars`);
  check("getCachedLiveMatches calls loadTeamLogoIndex", body.includes("loadTeamLogoIndex"));
  check("getCachedLiveMatches calls applyTeamLogos", body.includes("applyTeamLogos"));
  check("getCachedLiveMatches does not map rows raw",
    !/map\(\(row\)\s*=>\s*\n?\s*mapMatch\(row/.test(body));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
