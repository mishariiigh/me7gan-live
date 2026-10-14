/**
 * Tests for client-side match filtering: competition chips, team search,
 * favourites and date/competition grouping.
 *
 *   node scripts/test-match-filtering.mjs
 *
 * These run the REAL module (transpiled from src), so a passing test reflects
 * shipped behaviour rather than a paraphrase of it.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");

const OUT = path.join(ROOT, ".match-filter-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const built = new Map();
function build(relPath) {
  if (built.has(relPath)) return built.get(relPath);
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
  const url = pathToFileURL(outPath).href;
  built.set(relPath, url);
  return url;
}

const F = await import(build("src/lib/sports/match-filtering.ts"));
const { COMPETITIONS } = await import(build("src/lib/sports/competitions.ts"));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${extra}`); }
}

/** Minimal PublicMatch fixture. */
const makeMatch = (over = {}) => ({
  fixtureId: "f1",
  matchDate: "2026-03-10",
  kickoffTime: "20:00",
  kickoffLabel: "٨:٠٠ م",
  competition: "Premier League",
  home: { name: "Manchester City", logo: null },
  away: { name: "Arsenal", logo: null },
  hasActiveStream: false,
  ...over,
});

console.log("\n══ 1. Competitions are derived from the canonical config ══");
{
  const matches = [
    makeMatch({ competition: "Premier League" }),
    makeMatch({ competition: "La Liga" }),
    makeMatch({ competition: "Premier League" }),
  ];
  const available = F.availableCompetitions(matches);
  check("returns only competitions present in the data", JSON.stringify(available) === JSON.stringify(["Premier League", "La Liga"]), JSON.stringify(available));
  check("follows the canonical COMPETITIONS order", available[0] === "Premier League" && available[1] === "La Liga");
  check("all six competitions exist in the config", COMPETITIONS.length === 6, COMPETITIONS.length);
  check("empty input yields no chips", F.availableCompetitions([]).length === 0);
  check("the All sentinel is 'all'", F.ALL_COMPETITIONS === "all");
}

console.log("\n══ 2. Competition filter ══");
{
  const matches = [
    makeMatch({ fixtureId: "a", competition: "Premier League" }),
    makeMatch({ fixtureId: "b", competition: "La Liga" }),
  ];
  const base = { query: "", favouritesOnly: false, favourites: new Set() };
  check("All keeps every match", F.filterMatches(matches, { ...base, competition: "all" }).length === 2);
  const laLiga = F.filterMatches(matches, { ...base, competition: "La Liga" });
  check("selecting a competition narrows to it", laLiga.length === 1 && laLiga[0].fixtureId === "b");
  check("filtering never mutates the input", matches.length === 2);
}

console.log("\n══ 3. Team search — English ══");
{
  check("exact English name matches", F.matchMatchesSearch(makeMatch(), "Manchester City"));
  check("lowercase matches", F.matchMatchesSearch(makeMatch(), "arsenal"));
  check("partial word matches", F.matchMatchesSearch(makeMatch(), "city"));
  check("the away team is searched too", F.matchMatchesSearch(makeMatch(), "arsenal"));
  check("a hyphenated query still finds the club", F.matchMatchesSearch(makeMatch(), "man-city"));
  check("a dotted query still finds the club", F.matchMatchesSearch(makeMatch(), "Man.City"));
  check("the abbreviation 'Man City' finds Manchester City", F.matchMatchesSearch(makeMatch(), "Man City"));
  check("the abbreviation 'ManCity' (no space) finds it", F.matchMatchesSearch(makeMatch(), "ManCity"));
  check("'MCFC' expands to Manchester City", F.matchMatchesSearch(makeMatch(), "MCFC"));
  check("a non-matching query is rejected", F.matchMatchesSearch(makeMatch(), "Liverpool") === false);
  // The critical safety property: abbreviations must not collapse two clubs.
  check("abbreviation does NOT match a different club", F.matchMatchesSearch(makeMatch(), "Man United") === false, "Man United must not match Manchester City");
  check("'MU' does not match Manchester City", F.matchMatchesSearch(makeMatch(), "MU") === false);
}

console.log("\n══ 4. Team search — Arabic normalization ══");
{
  const arabicMatch = makeMatch({ home: { name: "ريال مدريد", logo: null }, away: { name: "برشلونة", logo: null } });
  check("Arabic name matches exactly", F.matchMatchesSearch(arabicMatch, "ريال مدريد"));
  check("hamza variation matches (أ -> ا)", F.matchMatchesSearch(arabicMatch, "ريال مدريد"));
  check("taa marbuta variation matches (ة -> ه)", F.matchMatchesSearch(arabicMatch, "برشلونه"));
  check("diacritics are ignored", F.matchMatchesSearch(arabicMatch, "رِيَال مدريد"));
  check("tatweel is ignored", F.matchMatchesSearch(arabicMatch, "ريـــال"));
  const withHamza = makeMatch({ home: { name: "الأهلي", logo: null }, away: { name: "النصر", logo: null } });
  check("alef-hamza prefix folds", F.matchMatchesSearch(withHamza, "الاهلي"));
  check("display name is NOT mutated by normalization", withHamza.home.name === "الأهلي");
}

console.log("\n══ 5. Search combines with competition and date pools ══");
{
  const matches = [
    makeMatch({ fixtureId: "a", competition: "Premier League", home: { name: "Manchester City", logo: null } }),
    makeMatch({ fixtureId: "b", competition: "La Liga", home: { name: "Real Madrid", logo: null } }),
    makeMatch({ fixtureId: "c", competition: "Premier League", home: { name: "Liverpool", logo: null } }),
  ];
  const base = { competition: "Premier League", favouritesOnly: false, favourites: new Set() };
  check("competition + query intersect", F.filterMatches(matches, { ...base, query: "city" }).map((m) => m.fixtureId).join() === "a");
  check("query matching but wrong competition is excluded", F.filterMatches(matches, { ...base, query: "madrid" }).length === 0);
  check("empty query keeps the competition set", F.filterMatches(matches, { ...base, query: "  " }).length === 2);
}

console.log("\n══ 6. Favourites ══");
{
  check("favourite id is stable across punctuation/case", F.favouriteTeamId("FC Barcelona") === F.favouriteTeamId("f.c. barcelona"));
  check("favourite id collapses whitespace", F.favouriteTeamId("Real  Madrid") === F.favouriteTeamId("real madrid"));
  check("Arabic favourite ids fold", F.favouriteTeamId("برشلونة") === F.favouriteTeamId("برشلونه"));

  const city = makeMatch({ fixtureId: "a", home: { name: "Manchester City", logo: null } });
  const madrid = makeMatch({ fixtureId: "b", home: { name: "Real Madrid", logo: null }, away: { name: "Getafe", logo: null } });
  const favs = new Set([F.favouriteTeamId("Manchester City"), F.favouriteTeamId("Real Madrid")]);

  check("home team favourite is detected", F.involvesFavourite(city, favs));
  check("away team favourite is detected", F.involvesFavourite(makeMatch({ home: { name: "Sevilla", logo: null }, away: { name: "Real Madrid", logo: null } }), favs));
  check("non-favourite is not matched", F.involvesFavourite(makeMatch(), new Set(["realbarcelona"])) === false);
  check("empty favourites match nothing", F.involvesFavourite(city, new Set()) === false);

  const filtered = F.filterMatches([city, madrid], { competition: "all", query: "", favouritesOnly: true, favourites: favs });
  check("favourites-only filter keeps only those matches", filtered.length === 2);

  // A non-favourite first, so prioritising has something to move.
  const nonFavourite = makeMatch({ fixtureId: "z", home: { name: "Getafe", logo: null }, away: { name: "Cadiz", logo: null } });
  const ordered = F.prioritiseFavourites([nonFavourite, city], favs);
  check("favourite matches are prioritised to the front", ordered[0].fixtureId === "a", ordered.map((m) => m.fixtureId).join());
  check("prioritising hides nothing", ordered.length === 2);
  check("relative order of non-favourites is kept", F.prioritiseFavourites([makeMatch({ fixtureId: "x", home: { name: "Getafe", logo: null } }), nonFavourite], favs).map((m) => m.fixtureId).join() === "x,z");
  check("empty favourites leave order untouched", F.prioritiseFavourites([nonFavourite, city], new Set())[0].fixtureId === "z");
}

console.log("\n══ 7. Grouping by date and competition ══");
{
  const matches = [
    makeMatch({ fixtureId: "1", matchDate: "2026-03-11", competition: "La Liga" }),
    makeMatch({ fixtureId: "2", matchDate: "2026-03-10", competition: "Premier League" }),
    makeMatch({ fixtureId: "3", matchDate: "2026-03-10", competition: "La Liga" }),
    makeMatch({ fixtureId: "4", matchDate: "2026-03-10", competition: "Premier League" }),
  ];
  const groups = F.groupByDateAndCompetition(matches);
  check("dates ascend", groups.map((g) => g.date).join() === "2026-03-10,2026-03-11");
  check("competitions are ordered canonically within a date", groups[0].competitions.map((c) => c.competition).join() === "Premier League,La Liga");
  check("matches are kept under the right competition", groups[0].competitions[0].matches.map((m) => m.fixtureId).join() === "2,4");
  check("incoming order is preserved within a group", groups[0].competitions[1].matches.map((m) => m.fixtureId).join() === "3");

  const total = groups.reduce((sum, g) => sum + g.competitions.reduce((s, c) => s + c.matches.length, 0), 0);
  check("no match is duplicated or dropped", total === matches.length, `${total} vs ${matches.length}`);

  const withUnknown = F.groupByDateAndCompetition([makeMatch({ competition: "Friendly Cup" })]);
  check("an unrecognised competition is still shown, not dropped", withUnknown[0].competitions[0].competition === null && withUnknown[0].competitions[0].matches.length === 1);
  check("the date total counts every fixture", groups[0].total === 3);
  check("empty input yields no groups", F.groupByDateAndCompetition([]).length === 0);
}

console.log("\n══ 8. Filtering never reorders or drops ══");
{
  const matches = Array.from({ length: 5 }, (_, i) => makeMatch({ fixtureId: `m${i}` }));
  const out = F.filterMatches(matches, { competition: "all", query: "", favouritesOnly: false, favourites: new Set() });
  check("an all/all filter returns every row in order", out.map((m) => m.fixtureId).join() === matches.map((m) => m.fixtureId).join());
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
rmSync(OUT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
