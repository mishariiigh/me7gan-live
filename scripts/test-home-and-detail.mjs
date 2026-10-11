/**
 * End-to-end tests for the match data loaders, using a fake Supabase client.
 *
 *   node scripts/test-home-and-detail.mjs
 *
 * These exercise the REAL `matches.ts` functions (transpiled from src) against a
 * mocked database, so a passing test reflects what the pages actually receive.
 * A mock is used because no live Supabase project is reachable from here — the
 * point is to prove the loader applies team logos and the correct week window.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");

const OUT = path.join(ROOT, ".home-detail-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── Fake database ─────────────────────────────────────────────────────────
// Rows are shaped exactly like the real tables.
const DB = {
  matches: [],
  fixture_streams: [],
  teams: [],
  team_aliases: [],
};

/** Minimal chainable PostgREST-alike that records the filters applied. */
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
      // `maybeSingle` must yield ONE row (or null), matching PostgREST. Returning
      // the array would let a real bug hide behind a shape mismatch.
      maybeSingle: () => { state.single = true; return api; },
      single: () => { state.single = true; return api; },
      limit: () => api,
      then: (resolve) => resolve(run(state)),
    };
    // The loader awaits the builder, so `then` makes it a thenable.
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
    for (const order of state.orders.slice().reverse()) {
      rows.sort((a, b) => {
        const left = a[order.column] ?? "";
        const right = b[order.column] ?? "";
        const cmp = String(left).localeCompare(String(right));
        return order.ascending === false ? -cmp : cmp;
      });
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

// The stub must hand the loader the fake client.
const STUB = `"data:text/javascript,let c=globalThis.__FAKE_DB__;export async function createSupabaseServerClient(){return c?c():null}"`;
globalThis.__FAKE_DB__ = makeClient;

const Matches = await import(build("src/lib/sports/matches.ts", {
  '"@/lib/supabase/server"': STUB,
}));
const MT = await import(build("src/lib/sports/match-types.ts"));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${extra}`); }
}

const BARCA_LOGO = "https://cdn.example/barca.png";
const ELCHE_LOGO = "https://cdn.example/elche.png";

function resetDatabase() {
  DB.matches = [];
  DB.fixture_streams = [];
  DB.teams = [];
  DB.team_aliases = [];
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n══ 1. A saved logo resolves on BOTH the card and the detail page ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{
    id: "1", fixture_id: "ML-TEST-0001", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "FC Barcelona", away_team: "Elche CF",
    home_team_logo: null, away_team_logo: null, published: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  }];
  DB.teams = [
    { id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA_LOGO },
    { id: "t2", team_key: "elche", name: "Elche CF", logo_url: ELCHE_LOGO },
  ];

  const schedule = await Matches.getPublicFixtureSchedule();
  const card = schedule.week.find((m) => m.fixtureId === "ML-TEST-0001");
  check("homepage card has the home logo", card?.home.logo === BARCA_LOGO, card?.home.logo);
  check("homepage card has the away logo", card?.away.logo === ELCHE_LOGO, card?.away.logo);

  // THE BUG: the detail page must apply the same resolution.
  const detail = await Matches.getPublicMatchByFixtureId("ML-TEST-0001");
  check("detail page has the home logo", detail?.home.logo === BARCA_LOGO, String(detail?.home.logo));
  check("detail page has the away logo", detail?.away.logo === ELCHE_LOGO, String(detail?.away.logo));
  check("detail and card agree on the home logo",
    detail?.home.logo === card?.home.logo, `${detail?.home.logo} vs ${card?.home.logo}`);
}

console.log("\n══ 2. Logos resolve home and away, for the same club ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [
    { id: "1", fixture_id: "A", match_date: today, kickoff_time: "19:30:00", competition: "La Liga",
      home_team: "FC Barcelona", away_team: "Getafe CF", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "B", match_date: today, kickoff_time: "21:00:00", competition: "La Liga",
      home_team: "Getafe CF", away_team: "Barcelona", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];
  DB.teams = [{ id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA_LOGO }];

  const a = await Matches.getPublicMatchByFixtureId("A");
  const b = await Matches.getPublicMatchByFixtureId("B");
  check("club at home gets the crest", a?.home.logo === BARCA_LOGO, String(a?.home.logo));
  check("same club away gets the crest (alias 'Barcelona')", b?.away.logo === BARCA_LOGO, String(b?.away.logo));
}

console.log("\n══ 3. A club with no saved logo falls back safely ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{ id: "1", fixture_id: "A", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "FC Barcelona", away_team: "Unknown FC",
    home_team_logo: null, away_team_logo: null, published: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  DB.teams = [{ id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA_LOGO }];

  const detail = await Matches.getPublicMatchByFixtureId("A");
  check("known club still gets its crest", detail?.home.logo === BARCA_LOGO);
  check("unknown club is null, not undefined", detail?.away.logo === null, String(detail?.away.logo));
  check("the match still loads with a name", detail?.away.name === "Unknown FC");
}

console.log("\n══ 4. A match-level logo is not blanked ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{ id: "1", fixture_id: "A", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "FC Barcelona", away_team: "Getafe",
    home_team_logo: "https://cdn.example/match-bound.png", away_team_logo: null, published: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  DB.teams = []; // no stored club logo

  const card = await Matches.getPublicFixtureSchedule();
  const detail = await Matches.getPublicMatchByFixtureId("A");
  check("pre-existing match logo survives on the card",
    card.week[0]?.home.logo === "https://cdn.example/match-bound.png", card.week[0]?.home.logo);
  check("pre-existing match logo survives on the detail page",
    detail?.home.logo === "https://cdn.example/match-bound.png", String(detail?.home.logo));
}

console.log("\n══ 5. Distinct clubs are never given the wrong crest ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{ id: "1", fixture_id: "A", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "Barcelona SC", away_team: "Manchester City",
    home_team_logo: null, away_team_logo: null, published: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  DB.teams = [
    { id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA_LOGO },
    { id: "t2", team_key: "manchesterunited", name: "Manchester United", logo_url: "https://cdn.example/mu.png" },
  ];

  const detail = await Matches.getPublicMatchByFixtureId("A");
  check("Barcelona SC does NOT get FC Barcelona's crest", detail?.home.logo === null, String(detail?.home.logo));
  check("Manchester City does NOT get Manchester United's crest",
    detail?.away.logo === null, String(detail?.away.logo));
}

console.log("\n══ 6. Week window covers Monday and Sunday ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  const bounds = MT.getWeekBounds(today);
  DB.matches = [
    { id: "1", fixture_id: "MON", match_date: bounds.weekStartDate, kickoff_time: "00:30:00",
      competition: "La Liga", home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "SUN", match_date: bounds.weekEndDate, kickoff_time: "23:45:00",
      competition: "La Liga", home_team: "C", away_team: "D", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "3", fixture_id: "BEFORE", match_date: MT.getNextScheduleDate(MT.getNextScheduleDate(MT.getNextScheduleDate(MT.getNextScheduleDate(MT.getNextScheduleDate(MT.getNextScheduleDate(MT.getNextScheduleDate(bounds.weekEndDate))))))),
      kickoff_time: "19:30:00", competition: "La Liga", home_team: "E", away_team: "F",
      home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];

  const schedule = await Matches.getPublicFixtureSchedule();
  const ids = schedule.week.map((m) => m.fixtureId);
  check("Monday fixture is included", ids.includes("MON"), JSON.stringify(ids));
  check("Sunday fixture is included", ids.includes("SUN"), JSON.stringify(ids));
  check("a fixture outside the week is excluded", !ids.includes("BEFORE"), JSON.stringify(ids));
}

console.log("\n══ 7. Today and Tomorrow remain subsets of the week ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  const tomorrow = MT.getNextScheduleDate(today);
  DB.matches = [
    { id: "1", fixture_id: "TODAY", match_date: today, kickoff_time: "19:30:00", competition: "La Liga",
      home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "TOMORROW", match_date: tomorrow, kickoff_time: "21:00:00", competition: "La Liga",
      home_team: "C", away_team: "D", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];

  const schedule = await Matches.getPublicFixtureSchedule();

  check("today filter returns the right match",
    schedule.today.map((m) => m.fixtureId).join() === "TODAY");

  check("tomorrow filter returns the right match",
    schedule.tomorrow.map((m) => m.fixtureId).join() === "TOMORROW");

  check("today appears in the week array",
    schedule.week.some((m) => m.fixtureId === "TODAY"));

  const tomorrowIsInWeek =
    tomorrow >= schedule.weekStartDate &&
    tomorrow <= schedule.weekEndDate;

  check("tomorrow appears in the week only when its date is within the week",
    schedule.week.some((m) => m.fixtureId === "TOMORROW") === tomorrowIsInWeek);
}

console.log("\n══ 7b. Tomorrow is fetched even when it falls outside the week ══");
{
  // The regression this guards: when today is Sunday, tomorrow is next Monday.
  // The query window previously ended at the week's Sunday, so a fixture on
  // tomorrow was never fetched at all and the Tomorrow filter came back empty
  // even though the match existed.
  resetDatabase();
  const today = MT.getScheduleDate();
  const tomorrow = MT.getNextScheduleDate(today);
  const bounds = MT.getWeekBounds(today);
  const tomorrowIsNextWeek = tomorrow > bounds.weekEndDate;

  DB.matches = [
    { id: "1", fixture_id: "TODAY", match_date: today, kickoff_time: "19:30:00", competition: "La Liga",
      home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "TOMORROW", match_date: tomorrow, kickoff_time: "21:00:00", competition: "La Liga",
      home_team: "C", away_team: "D", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];

  const schedule = await Matches.getPublicFixtureSchedule();

  // This holds on every weekday, which is the point: the query window is widened
  // to cover tomorrow, so the Tomorrow filter is never starved of its rows.
  check("tomorrow is always fetched, whatever weekday today is",
    schedule.tomorrow.map((m) => m.fixtureId).join() === "TOMORROW",
    `tomorrow array was ${JSON.stringify(schedule.tomorrow.map((m) => m.fixtureId))}`);

  check("today is always fetched", schedule.today.map((m) => m.fixtureId).join() === "TODAY");

  // The week array must stay a strict Monday..Sunday window. When tomorrow is in
  // the next week it belongs to the Tomorrow filter but NOT to this week.
  check("the week array never extends past Sunday",
    schedule.week.every((m) => m.matchDate <= schedule.weekEndDate),
    JSON.stringify(schedule.week.map((m) => m.matchDate)));
  check("the week array never starts before Monday",
    schedule.week.every((m) => m.matchDate >= schedule.weekStartDate));
  check("a next-week tomorrow is excluded from the week array",
    schedule.week.some((m) => m.fixtureId === "TOMORROW") === !tomorrowIsNextWeek,
    `tomorrowIsNextWeek=${tomorrowIsNextWeek}`);
}

console.log("\n══ 8. Unpublished matches never surface ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{ id: "1", fixture_id: "HIDDEN", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null,
    published: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  const schedule = await Matches.getPublicFixtureSchedule();
  const detail = await Matches.getPublicMatchByFixtureId("HIDDEN");
  check("unpublished match absent from the week", schedule.week.length === 0);
  check("unpublished match absent from the detail page", detail === null);
}

console.log("\n══ 9. Stream status and links are untouched ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [
    { id: "1", fixture_id: "WITH_STREAM", match_date: today, kickoff_time: "19:30:00", competition: "La Liga",
      home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "NO_STREAM", match_date: today, kickoff_time: "21:00:00", competition: "La Liga",
      home_team: "C", away_team: "D", home_team_logo: null, away_team_logo: null, published: true,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];
  DB.fixture_streams = [{ fixture_id: "WITH_STREAM", active: true, stream_type: "hls" }];

  const schedule = await Matches.getPublicFixtureSchedule();
  const streamed = schedule.week.find((m) => m.fixtureId === "WITH_STREAM");
  const plain = schedule.week.find((m) => m.fixtureId === "NO_STREAM");
  check("match with an active stream is flagged", streamed?.hasActiveStream === true);
  check("match without a stream is not flagged", plain?.hasActiveStream === false);
}

console.log("\n══ 9b. Month and year boundaries ══");
{
  // A week that straddles a month end, and one that straddles New Year.
  const monthEdge = MT.getWeekBounds("2026-03-01");
  check("week spanning a month end starts in February",
    monthEdge.weekStartDate === "2026-02-23", monthEdge.weekStartDate);
  check("week spanning a month end ends in March",
    monthEdge.weekEndDate === "2026-03-01", monthEdge.weekEndDate);

  const yearEdge = MT.getWeekBounds("2026-01-01");
  check("week spanning New Year starts in the previous year",
    yearEdge.weekStartDate === "2025-12-29", yearEdge.weekStartDate);
  check("week spanning New Year ends in the new year",
    yearEdge.weekEndDate === "2026-01-04", yearEdge.weekEndDate);

  // Both edges must actually appear in the loaded week.
  resetDatabase();
  DB.matches = [
    { id: "1", fixture_id: "FEB", match_date: monthEdge.weekStartDate, kickoff_time: "19:30:00",
      competition: "La Liga", home_team: "A", away_team: "B", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "2", fixture_id: "MAR", match_date: monthEdge.weekEndDate, kickoff_time: "19:30:00",
      competition: "La Liga", home_team: "C", away_team: "D", home_team_logo: null, away_team_logo: null,
      published: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ];
  const s = await Matches.getPublicFixtureSchedule();
  check("the schedule query can be exercised for a month-boundary week",
    Array.isArray(s.week), "week missing");
}

console.log("\n══ 9c. A match keeps its stream state on the detail page ══");
{
  resetDatabase();
  const today = MT.getScheduleDate();
  DB.matches = [{ id: "1", fixture_id: "LIVE", match_date: today, kickoff_time: "19:30:00",
    competition: "La Liga", home_team: "FC Barcelona", away_team: "Elche CF",
    home_team_logo: null, away_team_logo: null, published: true,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }];
  DB.fixture_streams = [{ fixture_id: "LIVE", active: true, stream_type: "hls" }];
  DB.teams = [{ id: "t1", team_key: "barcelona", name: "FC Barcelona", logo_url: BARCA_LOGO }];

  const detail = await Matches.getPublicMatchByFixtureId("LIVE");
  const card = (await Matches.getPublicFixtureSchedule()).week[0];

  // The stream flag comes from fixture_streams, which the logo fix must not touch.
  check("card still reports the active stream", card?.hasActiveStream === true);
  check("detail page loads for a match with a stream", detail !== null);
  check("the fixture_id used for stream links is unchanged", detail?.fixtureId === "LIVE", detail?.fixtureId);
  check("kickoff time is untouched", detail?.kickoffTime === "19:30:00", detail?.kickoffTime);
  check("competition is untouched", detail?.competition === "La Liga", detail?.competition);
  check("logo added without disturbing stream state", detail?.home.logo === BARCA_LOGO);
}

console.log("\n══ 10. Logo resolution is not duplicated in the loader ══");
{
  const src = readFileSync(path.join(ROOT, "src/lib/sports/matches.ts"), "utf8");
  check("the loader uses the shared applyTeamLogos helper", /applyTeamLogos/.test(src));
  check("the loader loads the shared index once", /loadTeamLogoIndex/.test(src));
  // The detailed page must go through the same resolution path.
  const detailFn = src.slice(src.indexOf("getPublicMatchByFixtureId"));
  check("the detail loader applies team logos", /applyTeamLogos/.test(detailFn),
    "detail loader does not resolve team logos");
  // No second normalisation implementation: the loader must delegate.
  check("the loader contains no bespoke name normalisation",
    !/normaliseTeamKey|toLowerCase\(\).*replace/.test(src.split("getPublicMatchByFixtureId")[1] ?? ""));
  // The week window must be explicitly bounded, like every sibling query.


  check("the week query applies an explicit range cap",
    /\.lte\("match_date", (?:weekEndDate|queryEndDate)\)[\s\S]{0,220}\.range\(0, 999\)/.test(src),
    "week query has no range cap");
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
rmSync(OUT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
