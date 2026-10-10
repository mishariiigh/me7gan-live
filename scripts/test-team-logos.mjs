/**
 * Tests for persistent team logos and homepage date ranges.
 *
 *   node scripts/test-team-logos.mjs
 *
 * Runs the REAL modules (transpiled from src), not re-implementations, so a
 * passing test reflects the shipped behaviour.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");

const OUT = path.join(ROOT, ".team-logo-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = new Map();
/**
 * Transpiles a project module into a loadable .mjs file.
 *
 * `replacements` lets a caller swap an import for an inert stub, so a module
 * that depends on the Next runtime can still have its pure exports tested.
 */
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
  const outPath = path.join(
    OUT,
    `${relPath.replace(/[/]/g, "_").replace(/\.ts$/, "")}-${Object.keys(replacements).length}.mjs`,
  );
  writeFileSync(outPath, js);
  const url = pathToFileURL(outPath).href;
  built.set(cacheKey, url);
  return url;
}

const T = await import(build("src/lib/sports/team-identity.ts"));
const MT = await import(build("src/lib/sports/match-types.ts"));

// `team-logos.ts` imports the Supabase server client, which reaches into
// `next/headers` and cannot load outside the Next runtime. The pure helpers it
// exports are what these tests exercise, so the server-only pieces are stubbed
// with inert versions rather than skipped.
const L = await import(build("src/lib/sports/team-logos.ts", {
  '"@/lib/supabase/server"': `"data:text/javascript,export async function createSupabaseServerClient(){return null}"`,
}));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${extra}`); }
}

console.log("\n══ 1. Team identity: one club, many spellings ══");
{
  const sameClub = [
    ["FC Barcelona", "Barcelona"],
    ["FC Barcelona", "F.C. Barcelona"],
    ["FC Barcelona", "F.C.Barcelona"],
    ["FC Barcelona", "fc barcelona"],
    ["Atlético de Madrid", "Atletico Madrid"],
    ["Atlético de Madrid", "Atlético de Madrid "],
    ["Elche CF", "Elche"],
    ["Sevilla FC", "Sevilla"],
    ["València", "Valencia"],
    ["Real Betis", "real  betis"],
  ];
  for (const [a, b] of sameClub) {
    check(`${JSON.stringify(a)} == ${JSON.stringify(b)}`, T.isSameTeam(a, b),
      `keys ${T.normaliseTeamKey(a)} | ${T.normaliseTeamKey(b)}`);
  }
}

console.log("\n══ 2. Team identity: distinct clubs must NEVER merge ══");
{
  const distinct = [
    ["Manchester United", "Manchester City"],
    ["Real Madrid", "Atlético de Madrid"],
    ["Inter", "Inter Miami"],
    ["AC Milan", "Inter Milan"],
    ["Sevilla", "Real Betis"],
    ["Barcelona", "Barcelona SC"],
    ["Bayern Munich", "Borussia Dortmund"],
    ["Getafe", "Getafe B"],
  ];
  for (const [a, b] of distinct) {
    check(`${JSON.stringify(a)} != ${JSON.stringify(b)}`, !T.isSameTeam(a, b),
      `both collapse to ${T.normaliseTeamKey(a)}`);
  }
}

console.log("\n══ 3. Arabic club names ══");
{
  check("Arabic variants fold (أ/ا)", T.isSameTeam("الأهلي", "الاهلي"));
  check("Arabic tatweel ignored", T.isSameTeam("الاتحاد", "الاتــحاد"));
  check("distinct Arabic clubs stay apart", !T.isSameTeam("الأهلي", "الزمالك"));
}

console.log("\n══ 4. Logo lookup across spellings ══");
{
  // Simulates what loadTeamLogoIndex returns from the database.
  const index = new Map([["barcelona", "https://cdn.example/barca.png"]]);

  check("exact spelling resolves", L.lookupTeamLogo(index, "FC Barcelona") === "https://cdn.example/barca.png");
  check("short spelling resolves", L.lookupTeamLogo(index, "Barcelona") === "https://cdn.example/barca.png");
  check("dotted spelling resolves", L.lookupTeamLogo(index, "F.C. Barcelona") === "https://cdn.example/barca.png");
  check("unknown club resolves to null", L.lookupTeamLogo(index, "Getafe CF") === null);
}

console.log("\n══ 5. A logo used on home AND away fixtures ══");
{
  const index = new Map([
    ["barcelona", "https://cdn.example/barca.png"],
    ["elche", "https://cdn.example/elche.png"],
  ]);

  const asHome = L.applyTeamLogos(
    { home: { name: "FC Barcelona", logo: null }, away: { name: "Elche CF", logo: null } }, index);
  check("home club gets its crest", asHome.home.logo === "https://cdn.example/barca.png", asHome.home.logo);
  check("away club gets its crest", asHome.away.logo === "https://cdn.example/elche.png", asHome.away.logo);

  // The same club appearing as the away side in a different fixture.
  const asAway = L.applyTeamLogos(
    { home: { name: "Getafe CF", logo: null }, away: { name: "Barcelona", logo: null } }, index);
  check("same club gets the same crest when away", asAway.away.logo === "https://cdn.example/barca.png", asAway.away.logo);
  check("a club without a logo stays null", asAway.home.logo === null);
}

console.log("\n══ 6. Replacing a logo updates every fixture ══");
{
  const before = new Map([["barcelona", "https://cdn.example/old.png"]]);
  const after = new Map([["barcelona", "https://cdn.example/new.png"]]);
  const fixture = { home: { name: "FC Barcelona", logo: null }, away: { name: "Getafe", logo: null } };

  check("old logo applied", L.applyTeamLogos(fixture, before).home.logo === "https://cdn.example/old.png");
  check("replacement logo applied", L.applyTeamLogos(fixture, after).home.logo === "https://cdn.example/new.png");
}

console.log("\n══ 7. An existing fixture logo is never blanked ══");
{
  // A match carries its own logo, but the club has no stored logo yet.
  const emptyIndex = new Map();
  const fixture = { home: { name: "FC Barcelona", logo: "https://cdn.example/match-level.png" }, away: { name: "Getafe", logo: null } };
  const result = L.applyTeamLogos(fixture, emptyIndex);
  check("match-level logo preserved when no team logo exists",
    result.home.logo === "https://cdn.example/match-level.png", result.home.logo);

  // A stored club logo takes precedence, which is what makes replacement work.
  const index = new Map([["barcelona", "https://cdn.example/club.png"]]);
  check("stored club logo wins over the match-level one",
    L.applyTeamLogos(fixture, index).home.logo === "https://cdn.example/club.png");
}

console.log("\n══ 8. Logo upload validation constants ══");
{
  check("bucket is the existing event-media bucket", L.TEAM_LOGO_BUCKET === "event-media");
  check("crests are namespaced under team-logos/", L.TEAM_LOGO_PREFIX === "team-logos");
  check("SVG is NOT an accepted type (script risk)", !L.ALLOWED_LOGO_TYPES.has("image/svg+xml"));
  check("PNG accepted", L.ALLOWED_LOGO_TYPES.get("image/png") === "png");
  check("JPEG accepted", L.ALLOWED_LOGO_TYPES.get("image/jpeg") === "jpg");
  check("WebP accepted", L.ALLOWED_LOGO_TYPES.get("image/webp") === "webp");
  check("size ceiling is 2 MB", L.MAX_LOGO_BYTES === 2 * 1024 * 1024);
}

console.log("\n══ 9. Import never blanks a logo (structural) ══");
{
  const route = readFileSync(path.join(ROOT, "src/app/api/admin/fixtures/import/route.ts"), "utf8");

  // The update patch must only add a logo key when a stored logo exists.
  check("update conditionally sets the home logo", /if \(homeLogo\) patch\.home_team_logo = homeLogo;/.test(route));
  check("update conditionally sets the away logo", /if \(awayLogo\) patch\.away_team_logo = awayLogo;/.test(route));
  check("no unconditional logo: null in an update", !/patch\.\w*logo\w* = null/.test(route));
  check("import reads stored logos for each team", /resolveTeamLogo\(client, name\)/.test(route));
  check("import still never writes fixture_streams", !/from\("fixture_streams"\)/.test(route));
  check("import still has no DELETE", !/\.delete\(/.test(route));
}

console.log("\n══ 10. Logo upload touches only the teams table ══");
{
  const route = readFileSync(path.join(ROOT, "src/app/api/admin/teams/logo/route.ts"), "utf8");
  const writes = [...route.matchAll(/\.from\("([a-z_]+)"\)\s*\.(insert|update|delete|upsert)/g)].map((m) => m[1]);
  check("writes only to teams", writes.length > 0 && writes.every((t) => t === "teams"), JSON.stringify(writes));
  check("never writes matches", !/from\("matches"\)\s*\.(update|insert|delete)/.test(route));
  // Checked against real write calls, not the whole file: `fixture_streams`
  // legitimately appears in a comment explaining what this route does NOT do.
  check("every write targets teams only",
    writes.every((table) => table === "teams"), JSON.stringify(writes));
  check("no stream table appears in any query",
    !/\.from\("(fixture_streams|official_watch_links)"\)/.test(route));
  check("requires an admin session", /checkAdminRequest/.test(route));
  check("uploads to Storage, not a local path", /storage\s*\.from\(TEAM_LOGO_BUCKET\)\s*\.upload/.test(route));
}

console.log("\n══ 11. Week bounds are Monday..Sunday, timezone-safe ══");
{
  const cases = [
    // [today, expected Monday, expected Sunday, note]
    ["2026-08-26", "2026-08-24", "2026-08-30", "Wednesday"],
    ["2026-08-24", "2026-08-24", "2026-08-30", "Monday itself"],
    ["2026-08-30", "2026-08-24", "2026-08-30", "Sunday (end of week)"],
    ["2026-08-31", "2026-08-31", "2026-09-06", "next Monday"],
    ["2026-01-01", "2025-12-29", "2026-01-04", "across a year boundary"],
    ["2026-03-01", "2026-02-23", "2026-03-01", "Sunday spanning a month boundary"],
  ];
  for (const [today, start, end, note] of cases) {
    const bounds = MT.getWeekBounds(today);
    check(`${note}: ${today} -> Mon ${start}`, bounds.weekStartDate === start, bounds.weekStartDate);
    check(`${note}: ${today} -> Sun ${end}`, bounds.weekEndDate === end, bounds.weekEndDate);
  }
}

console.log("\n══ 12. Near-midnight fixtures are never mis-filed ══");
{
  // A kickoff at 00:30 belongs to its own stored calendar date. Because the
  // grouping compares ISO date strings, no conversion can move it.
  const bounds = MT.getWeekBounds("2026-08-26");
  check("a 00:30 fixture on the start date is inside the week",
    "2026-08-24" >= bounds.weekStartDate && "2026-08-24" <= bounds.weekEndDate);
  check("a 23:59 fixture on the end date is inside the week",
    "2026-08-30" >= bounds.weekStartDate && "2026-08-30" <= bounds.weekEndDate);
  check("the day after the week ends is excluded", "2026-08-31" > bounds.weekEndDate);
  check("the day before the week starts is excluded", "2026-08-23" < bounds.weekStartDate);

  // The schedule date itself must be derived in the project timezone.
  check("MATCH_TIMEZONE is Asia/Riyadh", MT.MATCH_TIMEZONE === "Asia/Riyadh");
  const riyadh = MT.getScheduleDate(new Date("2026-08-26T21:30:00Z"));
  check("21:30 UTC is already the next day in Riyadh", riyadh === "2026-08-27", riyadh);
  const early = MT.getScheduleDate(new Date("2026-08-26T00:30:00Z"));
  check("00:30 UTC is 03:30 Riyadh, same calendar day", early === "2026-08-26", early);
}

console.log("\n══ 13. Today and tomorrow sit inside the week window ══");
{
  const today = MT.getScheduleDate(new Date("2026-08-26T09:00:00Z"));
  const tomorrow = MT.getNextScheduleDate(today);
  const bounds = MT.getWeekBounds(today);
  check("today is inside its own week", today >= bounds.weekStartDate && today <= bounds.weekEndDate);
  check("tomorrow is inside the same week", tomorrow >= bounds.weekStartDate && tomorrow <= bounds.weekEndDate);
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
rmSync(OUT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
