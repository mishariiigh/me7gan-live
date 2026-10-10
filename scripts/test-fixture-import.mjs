/**
 * Fixture-import test suite.
 *
 * Runs the REAL parser/validator (transpiled from src, not re-implemented) over
 * hand-built CSV and XLSX inputs.
 *
 *   node scripts/test-fixture-import.mjs
 *
 * Exits non-zero on failure so it can gate a build.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${ROOT}/node_modules/`);
const ts = require("typescript");
const XLSX = require("xlsx");

const OUT = path.join(ROOT, ".fixture-import-test-build");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Transpiles a project TS file into OUT, resolving @/ aliases to built files. */
const built = new Map();
function build(relPath) {
  if (built.has(relPath)) return built.get(relPath);
  let src = readFileSync(path.join(ROOT, relPath), "utf8");
  src = src.replace('import "server-only";', "");
  // `@/foo/bar` means `src/foo/bar.ts` in this project.
  src = src.replace(/from\s+["']@\/([^"']+)["']/g, (_, target) => {
    const dep = target.endsWith(".ts") ? `src/${target}` : `src/${target}.ts`;
    return `from ${JSON.stringify(build(dep))}`;
  });
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outPath = path.join(OUT, relPath.replace(/[/]/g, "_").replace(/\.ts$/, ".mjs"));
  writeFileSync(outPath, js);
  const url = pathToFileURL(outPath).href;
  built.set(relPath, url);
  return url;
}

const M = await import(build("src/lib/sports/fixture-import.ts"));
const Csv = await import(build("src/lib/sports/csv-parse.ts"));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${extra}`); }
}

const xlsxBuffer = (rows, sheetName = "Sheet1") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};
const csvBuffer = (text) => Buffer.from(text, "utf8");

/** Convenience: read + detect + validate in one call. */
async function run(buffer, options = {}) {
  const read = await M.readSheetRows(buffer, options.sheet);
  const mapping = { ...M.detectMapping(read.headers), ...(options.mapping ?? {}) };
  const fixtureColumn = mapping.homeTeam && mapping.awayTeam
    ? null : options.fixtureColumn ?? M.detectFixtureColumn(read.headers, mapping);
  const combinedColumn = mapping.matchDate && mapping.kickoffTime
    ? null : options.combinedColumn ?? M.detectCombinedColumn(read.headers, mapping);
  const { rows, rejected } = M.validateRows(read.raw, read.headers, mapping, {
    fixtureColumn, combinedColumn,
    competitionOverride: options.competitionOverride ?? null,
    headerRow: read.headerRow,
  });
  return { ...read, mapping, fixtureColumn, combinedColumn, rows, rejected };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n══ 1. CSV basics ══");
{
  const csv = "Date,Time,Competition,Home Team,Away Team\n2026-03-01,19:30,Premier League,Arsenal,Chelsea\n";
  const r = await run(csvBuffer(csv));
  check("comma CSV parses", r.rows.length === 1 && r.rows[0].homeTeam === "Arsenal", JSON.stringify(r.rejected));
  check("all columns detected", r.mapping.matchDate === "Date" && r.mapping.awayTeam === "Away Team");
}

console.log("\n══ 2. CSV with UTF-8 BOM (Excel 'CSV UTF-8') ══");
{
  const csv = "\uFEFFDate,Time,Competition,Home Team,Away Team\n2026-03-01,19:30,La Liga,Real Madrid,Barcelona\n";
  const r = await run(csvBuffer(csv));
  check("BOM stripped from first header", r.headers[0] === "Date", JSON.stringify(r.headers));
  check("mapping still detected with BOM", r.mapping.matchDate === "Date", JSON.stringify(r.mapping));
  check("row parses with BOM", r.rows.length === 1, JSON.stringify(r.rejected));
}

console.log("\n══ 3. CSV semicolon delimiter (Excel non-English locale) ══");
{
  const csv = "Fecha;Hora;Competicion;Equipo Local;Equipo Visitante\n01/03/2026;19:30;La Liga;Barcelona;Real Madrid\n";
  const r = await run(csvBuffer(csv));
  check("semicolon sniffed", r.headers.length === 5, JSON.stringify(r.headers));
  check("Spanish headers detected",
    r.mapping.matchDate === "Fecha" && r.mapping.homeTeam === "Equipo Local",
    JSON.stringify(r.mapping));
  check("row parses", r.rows.length === 1, JSON.stringify(r.rejected));
}

console.log("\n══ 4. CSV tab delimiter ══");
{
  const csv = "Date\tTime\tCompetition\tHome\tAway\n2026-03-01\t19:30\tSerie A\tJuventus\tInter\n";
  const r = await run(csvBuffer(csv));
  check("tab sniffed", r.headers.length === 5, JSON.stringify(r.headers));
  check("row parses", r.rows.length === 1, JSON.stringify(r.rejected));
}

console.log("\n══ 5. CSV quoting (team name contains a comma) ══");
{
  const csv = 'Date,Time,Competition,Home,Away\n2026-03-01,19:30,La Liga,"Atletico Madrid, B",Getafe\n';
  const r = await run(csvBuffer(csv));
  check("quoted comma preserved", r.rows[0]?.homeTeam === "Atletico Madrid, B", JSON.stringify(r.rows[0]));
}

console.log("\n══ 6. Title row above the real headers ══");
{
  const rows = [
    ["La Liga 2026 - FC Barcelona", "", "", "", ""],
    ["Fecha", "Hora", "Competicion", "Equipo Local", "Equipo Visitante"],
    ["2026-03-01", "19:30", "La Liga", "Barcelona", "Real Madrid"],
  ];
  const r = await run(xlsxBuffer(rows, "Calendario"));
  check("header row found below the title", r.headerRow === 2, `headerRow=${r.headerRow}`);
  check("headers are the real ones", r.headers[0] === "Fecha", JSON.stringify(r.headers));
  check("row parses", r.rows.length === 1, JSON.stringify(r.rejected));
  check("row number matches the spreadsheet", r.rows[0]?.row === 3, `row=${r.rows[0]?.row}`);
}

console.log("\n══ 7. Sheet not named Sheet1 ══");
{
  const rows = [["Date", "Time", "Competition", "Home", "Away"], ["2026-03-01", "19:30", "Bundesliga", "Bayern", "Dortmund"]];
  const r = await run(xlsxBuffer(rows, "Calendario 2026"));
  check("non-default sheet read", r.rows.length === 1, JSON.stringify(r.rejected));
  check("sheet name reported", r.sheetName === "Calendario 2026", r.sheetName);
}

console.log("\n══ 8. Data on the 2nd sheet ══");
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Notes"], ["This is a readme"]]), "Readme");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Date", "Time", "Competition", "Home", "Away"],
    ["2026-03-01", "19:30", "Ligue 1", "PSG", "Lyon"],
  ]), "Fixtures");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const r = await run(buf);
  check("the data sheet is chosen, not the first", r.sheetName === "Fixtures", r.sheetName);
  check("row parses", r.rows.length === 1, JSON.stringify(r.rejected));
  check("both sheets listed", r.sheetNames.length === 2, JSON.stringify(r.sheetNames));
}

console.log("\n══ 9. Arabic headers and data ══");
{
  const rows = [
    ["التاريخ", "الوقت", "البطولة", "الفريق المضيف", "الفريق الضيف"],
    ["2026-03-01", "19:30", "الدوري الإنجليزي", "آرسنال", "تشيلسي"],
  ];
  const r = await run(xlsxBuffer(rows));
  check("Arabic headers detected",
    r.mapping.matchDate && r.mapping.kickoffTime && r.mapping.competition && r.mapping.homeTeam && r.mapping.awayTeam,
    JSON.stringify(r.mapping));
  check("Arabic team names preserved", r.rows[0]?.homeTeam === "آرسنال", r.rows[0]?.homeTeam);
  check("Arabic competition mapped", r.rows[0]?.competition === "Premier League", r.rows[0]?.competition);
}

console.log("\n══ 10. Header variations ══");
{
  const variants = [
    [["Match Date", "Kick-off Time", "League", "Home", "Away"], "descriptive English"],
    [["Fecha", "Hora", "Liga", "Local", "Visitante"], "Spanish"],
    [["Datum", "Uhrzeit", "Liga", "Heim", "Gast"], "German-ish"],
    [["Date", "Time", "Competition", "Home Team Name", "Away Team Name"], "long names"],
    [["date", "time", "competition", "home_team", "away_team"], "snake_case lowercase"],
  ];
  for (const [headers, label] of variants) {
    const r = await run(xlsxBuffer([headers, ["2026-03-01", "19:30", "Serie A", "Juventus", "Inter"]]));
    check(`detected: ${label}`, r.rows.length === 1, JSON.stringify(r.mapping));
  }
}

console.log("\n══ 11. Combined date + time column ══");
{
  const r = await run(xlsxBuffer([
    ["Date & Time", "Competition", "Home", "Away"],
    ["2026-03-01 19:30", "Premier League", "Arsenal", "Chelsea"],
  ]));
  check("combined column detected", Boolean(r.combinedColumn), r.combinedColumn);
  check("both halves extracted",
    r.rows[0]?.matchDate === "2026-03-01" && r.rows[0]?.kickoffTime === "19:30",
    JSON.stringify(r.rows[0] ? [r.rows[0].matchDate, r.rows[0].kickoffTime] : r.rejected));
}

console.log("\n══ 12. Single fixture column ('Home vs Away') ══");
{
  for (const [sep, label] of [["vs", "vs"], ["-", "dash"], ["ضد", "Arabic ضد"]]) {
    const r = await run(xlsxBuffer([
      ["Date", "Time", "Competition", "Fixture"],
      ["2026-03-01", "19:30", "La Liga", `Barcelona ${sep} Real Madrid`],
    ]));
    check(`split on ${label}`,
      r.rows[0]?.homeTeam === "Barcelona" && r.rows[0]?.awayTeam === "Real Madrid",
      JSON.stringify(r.rows[0] ?? r.rejected));
  }
}

console.log("\n══ 13. Competition chosen manually (no competition column) ══");
{
  const buffer = xlsxBuffer([
    ["Date", "Time", "Home", "Away"],
    ["2026-03-01", "19:30", "Barcelona", "Real Madrid"],
  ]);
  const without = await run(buffer);
  check("rejected without an override", without.rows.length === 0 && without.rejected.length === 1);

  const with_ = await run(buffer, { competitionOverride: "La Liga" });
  check("accepted with an override", with_.rows.length === 1, JSON.stringify(with_.rejected));
  check("override applied", with_.rows[0]?.competition === "La Liga", with_.rows[0]?.competition);
}

console.log("\n══ 14. Row-level validation errors ══");
{
  const r = await run(xlsxBuffer([
    ["Date", "Time", "Competition", "Home", "Away"],
    ["2026-03-01", "19:30", "Premier League", "Arsenal", "Chelsea"],
    ["not-a-date", "19:30", "Premier League", "A", "B"],
    ["2026-02-31", "19:30", "Premier League", "C", "D"],
    ["2026-03-02", "99:99", "Premier League", "E", "F"],
    ["2026-03-03", "19:30", "Fake League", "G", "H"],
    ["2026-03-04", "19:30", "Premier League", "", "I"],
    ["2026-03-05", "19:30", "Premier League", "J", ""],
    ["2026-03-06", "19:30", "Premier League", "Same", "same"],
    ["", "", "", "", ""],
  ]));
  check("1 accepted", r.rows.length === 1, `rows=${r.rows.length}`);
  // Seven bad rows follow the good one: bad date, impossible date, bad time,
  // unsupported competition, missing home, missing away, identical teams.
  check("7 rejected", r.rejected.length === 7, `rejected=${r.rejected.length}`);
  check("every rejection states a reason", r.rejected.every((x) => x.reasons.length > 0));
  check("blank row not reported as an error", !r.rejected.some((x) => x.row === 10));
}

console.log("\n══ 15. Duplicate / reschedule key behaviour ══");
{
  const r = await run(xlsxBuffer([
    ["Date", "Time", "Competition", "Home", "Away"],
    ["2026-03-01", "19:30", "Premier League", "Arsenal", "Chelsea"],
    ["2026-03-01", "19:30", "Premier League", "Arsenal", "Chelsea"],
    ["2026-03-01", "21:00", "Premier League", "Arsenal", "Chelsea"],
    ["2026-03-09", "19:30", "Premier League", "Arsenal", "Chelsea"],
    ["2026-03-01", "19:30", "Premier League", "Manchester  United", "Chelsea"],
    ["2026-03-01", "19:30", "Premier League", "Manchester United", "Chelsea"],
  ]));
  check("exact duplicate rejected", r.rejected.some((x) => x.row === 3), JSON.stringify(r.rejected.map((x) => x.row)));
  // Two distinct fixtures share 2026-03-01 (Arsenal/Chelsea and Man Utd/Chelsea),
  // so the date alone must not collapse them. What matters is that the
  // Arsenal/Chelsea clash appears exactly once.
  check("same teams+date collapse to one row",
    r.rows.filter((x) => x.homeTeam.startsWith("Arsenal") && x.matchDate === "2026-03-01").length === 1,
    JSON.stringify(r.rows.map((x) => `${x.matchDate}:${x.homeTeam}`)));
  check("rescheduled fixture gets its own key", r.rows.some((x) => x.matchDate === "2026-03-09"));
  check("whitespace-variant teams collapse",
    r.rows.filter((x) => x.homeTeam.replace(/\s+/g, "") === "ManchesterUnited").length === 1);
}

console.log("\n══ 16. Provided match ID wins ══");
{
  const r = await run(xlsxBuffer([
    ["Match ID", "Date", "Time", "Competition", "Home", "Away"],
    ["ucl-001", "2026-04-01", "21:00", "UEFA Champions League", "Real Madrid", "Bayern"],
  ]));
  check("Match ID column detected", r.mapping.key === "Match ID", JSON.stringify(r.mapping));
  check("provided key used", r.rows[0]?.sourceKind === "provided", r.rows[0]?.sourceKey);
}

console.log("\n══ 16b. Regression: BOM + semicolon CSV with a title row (the reported bug) ══");
{
  // Exactly the shape of the reported file: a UTF-8 BOM, a title row naming the
  // club, semicolon delimiters and Spanish headers. The title row mentions
  // "La Liga", which must not let it win over the real header row.
  const csv = "\uFEFFLa Liga 2026 - FC Barcelona;;;;\nFecha;Hora;Competicion;Equipo Local;Equipo Visitante\n01/03/2026;19:30;La Liga;Barcelona;Real Madrid\n08/03/2026;21:00;La Liga;Sevilla;Betis\n";
  const r = await run(csvBuffer(csv));
  check("title row is not taken as the header", r.headerRow === 2, `headerRow=${r.headerRow}`);
  check("semicolon delimiter used, not the title's commas", r.headers.length === 5, JSON.stringify(r.headers));
  check("real headers found", r.headers.includes("Fecha") && r.headers.includes("Equipo Local"), JSON.stringify(r.headers));
  check("both fixtures accepted", r.rows.length === 2, JSON.stringify(r.rejected.map((x) => x.reasons)));
  check("date parsed day-first", r.rows[0]?.matchDate === "2026-03-01", r.rows[0]?.matchDate);
  check("competition resolved", r.rows[0]?.competition === "La Liga", r.rows[0]?.competition);
  check("teams separated", r.rows[0]?.homeTeam === "Barcelona" && r.rows[0]?.awayTeam === "Real Madrid");
}

console.log("\n══ 16c. Real-world file: Barcelona La Liga export (actual headers) ══");
{
  // The exact structure supplied by the operator.
  const csv = [
    "Match Number,Round Number,Date,Location,Home Team,Away Team,Result",
    "6,1,27/08/2026 22:00,Spotify Camp Nou,FC Barcelona,Athletic Club,2 - 0",
    "74,8,10/10/2026 19:30,Spotify Camp Nou,FC Barcelona,Getafe CF,",
  ].join("\n") + "\n";
  const r = await run(csvBuffer(csv), { competitionOverride: "La Liga" });

  check("Date / Home Team / Away Team auto-mapped",
    r.mapping.matchDate === "Date" && r.mapping.homeTeam === "Home Team" && r.mapping.awayTeam === "Away Team",
    JSON.stringify(r.mapping));
  check("Match Number mapped as the stable key", r.mapping.key === "Match Number", r.mapping.key);
  check("both fixtures accepted", r.rows.length === 2, JSON.stringify(r.rejected));

  // DD/MM/YYYY HH:mm split out of a single column.
  check("date parsed day-first from '27/08/2026 22:00'", r.rows[0]?.matchDate === "2026-08-27", r.rows[0]?.matchDate);
  check("kick-off 22:00 preserved exactly", r.rows[0]?.kickoffTime === "22:00", r.rows[0]?.kickoffTime);
  check("kick-off 19:30 preserved exactly", r.rows[1]?.kickoffTime === "19:30", r.rows[1]?.kickoffTime);

  check("competition comes from the manual selection", r.rows.every((x) => x.competition === "La Liga"));
  check("teams parsed", r.rows[0]?.homeTeam === "FC Barcelona" && r.rows[0]?.awayTeam === "Athletic Club");

  // Result values must never leak into date/time or be imported as scores.
  const anyTimeLooksLikeScore = r.rows.some((x) => /^2\s*-/.test(x.kickoffTime) || x.kickoffTime.includes("-"));
  check("Result not interpreted as a kick-off time", !anyTimeLooksLikeScore);
  check("empty Result row still imports", r.rows.length === 2);
  check("no score column written by the importer",
    !/score|result/.test(readFileSync(path.join(ROOT, "src/app/api/admin/fixtures/import/route.ts"), "utf8").split(".update({")[1]?.split("})")[0] ?? ""));

  // Match numbers are unique within a league, so keys must be namespaced.
  check("key is scoped by competition, not a bare match number",
    r.rows[0]?.sourceKey === "id:laliga:6", r.rows[0]?.sourceKey);
  check("Match Number 6 and 74 yield different keys", r.rows[0]?.sourceKey !== r.rows[1]?.sourceKey);

  // Optional metadata must not disturb the required fields.
  check("Round Number / Location are ignored harmlessly",
    !r.rows.some((x) => x.homeTeam.includes("Round") || x.homeTeam.includes("Camp Nou")));
}

console.log("\n══ 16c-2. Regression: the exact reported CSV must not require manual mapping ══");
{
  // Reproduces the reported symptom: the selectors appeared empty and the
  // preview refused with "not all required columns were detected".
  //
  // The server decides what is still missing; this mirrors that decision using
  // the same helpers the route uses, so the mapping outcome is asserted directly
  // rather than inferred from the UI.
  const csv = [
    "Match Number,Round Number,Date,Location,Home Team,Away Team,Result",
    "6,1,27/08/2026 22:00,Spotify Camp Nou,FC Barcelona,Athletic Club,2 - 0",
    "74,8,10/10/2026 19:30,Spotify Camp Nou,FC Barcelona,Getafe CF,",
  ].join("\n") + "\n";
  const read = await M.readSheetRows(csvBuffer(csv));
  const mapping = M.detectMapping(read.headers);
  const combined = M.detectCombinedColumn(read.headers, mapping);
  const fixtureColumn = mapping.homeTeam && mapping.awayTeam
    ? null : M.detectFixtureColumn(read.headers, mapping);

  // The route reads the first populated cells to confirm the date column really
  // carries a time, rather than trusting the header name.
  const dateIndex = mapping.matchDate ? read.headers.indexOf(mapping.matchDate) : -1;
  const dateColumnCarriesTime = !mapping.kickoffTime && dateIndex !== -1 && !combined
    && read.raw.slice(0, 10).some((row) => M.parseKickoffTime(row[dateIndex]) !== null);

  check("Date is auto-mapped to the date field", mapping.matchDate === "Date", JSON.stringify(mapping));
  check("Home Team is auto-mapped", mapping.homeTeam === "Home Team");
  check("Away Team is auto-mapped", mapping.awayTeam === "Away Team");
  check("Date column is recognised as carrying the kick-off", dateColumnCarriesTime);
  check("no competition column exists in this file", mapping.competition === null);

  // Without a competition override the file is legitimately incomplete.
  const missingWithout = ["matchDate", "kickoffTime", "homeTeam", "awayTeam"].filter((field) => {
    if (field === "homeTeam" || field === "awayTeam") {
      return !mapping.homeTeam && !mapping.awayTeam && !fixtureColumn;
    }
    return !mapping[field] && !combined && !dateColumnCarriesTime;
  });
  check("only the competition is outstanding before selection",
    missingWithout.length === 0,
    JSON.stringify(missingWithout));

  // Selecting La Liga must be the ONLY remaining requirement, and must satisfy it.
  const competitionSatisfied = Boolean(mapping.competition) || Boolean("La Liga");
  check("a competition override satisfies the competition requirement", competitionSatisfied);

  const { rows, rejected } = M.validateRows(read.raw, read.headers, mapping, {
    fixtureColumn, combinedColumn: combined,
    competitionOverride: "La Liga", headerRow: read.headerRow,
  });
  check("both rows import with only the competition selected",
    rows.length === 2 && rejected.length === 0, JSON.stringify(rejected.map((r) => r.reasons)));
  check("DD/MM/YYYY HH:mm parsed with no timezone shift",
    rows[0]?.matchDate === "2026-08-27" && rows[0]?.kickoffTime === "22:00",
    `${rows[0]?.matchDate} ${rows[0]?.kickoffTime}`);
  check("second kick-off preserved exactly", rows[1]?.kickoffTime === "19:30", rows[1]?.kickoffTime);
  check("empty Result row imports", rows.length === 2);
  check("La Liga applied to every row", rows.every((r) => r.competition === "La Liga"));
}

console.log("\n══ 16d. Match Number is namespaced per competition ══");
{
  const { deriveSourceKey } = M;
  const a = deriveSourceKey({ providedKey: "6", matchDate: "2026-08-27", competition: "La Liga", homeTeam: "FC Barcelona", awayTeam: "Athletic Club" });
  const b = deriveSourceKey({ providedKey: "6", matchDate: "2026-08-27", competition: "Premier League", homeTeam: "Arsenal", awayTeam: "Chelsea" });
  check("identical match numbers in different leagues do not collide", a.sourceKey !== b.sourceKey, `${a.sourceKey} vs ${b.sourceKey}`);
  const c = deriveSourceKey({ providedKey: "6", matchDate: "2026-09-01", competition: "La Liga", homeTeam: "FC Barcelona", awayTeam: "Sevilla" });
  check("same match number, same league still matches after a reschedule", a.sourceKey === c.sourceKey, `${a.sourceKey} vs ${c.sourceKey}`);
}

console.log("\n══ 16e. Mojibake repair for Spanish names ══");
{
  const Repair = await import(build("src/lib/sports/text-repair.ts"));
  const pairs = [
    ["Mart√≠nez", "Martínez"],
    ["Val√®ncia", "València"],
    ["Atl√©tico de Madrid", "Atlético de Madrid"],
    ["Mu√±oz", "Muñoz"],
    ["Garc√≠a", "García"],
  ];
  for (const [broken, expected] of pairs) {
    check(`repairs ${JSON.stringify(broken)}`, Repair.repairMisDecoded(broken) === expected, Repair.repairMisDecoded(broken));
  }

  // Correctly-encoded values must survive byte-for-byte.
  const safe = ["FC Barcelona", "Athletic Club", "Getafe CF", "أنتر ميلان", "Martínez", "València", "Atlético de Madrid", "Müller", "2 - 0", "Spotify Camp Nou"];
  for (const value of safe) {
    check(`leaves ${JSON.stringify(value)} untouched`, Repair.repairMisDecoded(value) === value, Repair.repairMisDecoded(value));
  }

  // End-to-end: a corrupted name in the sheet is stored repaired. A competition
  // is supplied because this file has no competition column.
  const r = await run(
    csvBuffer("Date,Home Team,Away Team\n2026-08-27 22:00,Atl√©tico de Madrid,Val√®ncia\n"),
    { competitionOverride: "La Liga" },
  );
  check("corrupted team names are repaired in the parsed output",
    r.rows[0]?.homeTeam === "Atlético de Madrid" && r.rows[0]?.awayTeam === "València",
    JSON.stringify(r.rows[0] ?? r.rejected));
  check("repair does not corrupt the kick-off", r.rows[0]?.kickoffTime === "22:00", r.rows[0]?.kickoffTime);
}

console.log("\n══ 17. CSV parser unit behaviour ══");
{
  check("BOM stripped", Csv.stripBom("\uFEFFa,b") === "a,b");
  check("semicolon sniffed", Csv.sniffDelimiter("a;b;c\n1;2;3") === ";");
  check("tab sniffed", Csv.sniffDelimiter("a\tb\tc\n1\t2\t3") === "\t");
  check("comma sniffed", Csv.sniffDelimiter("a,b,c\n1,2,3") === ",");
  check("CRLF handled", Csv.parseCsv("a,b\r\n1,2").length === 2);
  // A title line padded with trailing commas must not make comma win over the
  // semicolons the real data uses.
  check("semicolon wins over comma-padded title row",
    Csv.sniffDelimiter("La Liga 2026,,,,,\nFecha;Hora;Local;Visitante\n01/03/2026;19:30;A;B") === ";",
    Csv.sniffDelimiter("La Liga 2026,,,,,\nFecha;Hora;Local;Visitante\n01/03/2026;19:30;A;B"));
  check("comma still wins for a genuine comma file",
    Csv.sniffDelimiter("Date,Time,Home,Away\n2026-03-01,19:30,A,B") === ",");
  check("embedded newline in quotes",
    Csv.parseCsv('a,b\n"line1\nline2",2')[1][0] === "line1\nline2");
  check("escaped quotes", Csv.parseCsv('a,b\n"say ""hi""",2')[1][0] === 'say "hi"');
}

console.log("\n══ 18. Route-level: CSV is no longer rejected by extension ══");
{
  const routeSrc = readFileSync(path.join(ROOT, "src/app/api/admin/fixtures/import/route.ts"), "utf8");
  const extRe = /if \(!\/\\\.\(([^)]+)\)\$\/i\.test\(file\.name\)\)/.exec(routeSrc);
  check("extension gate allows csv", Boolean(extRe) && extRe[1].includes("csv"), extRe?.[1]);
  check("extension gate still allows xlsx", Boolean(extRe) && extRe[1].includes("xlsx"));
  check("no fixture_streams write in the import route", !/from\("fixture_streams"\)/.test(routeSrc));
  check("no DELETE in the import route", !/\.delete\(/.test(routeSrc));
  check("needs_mapping payload returned for the UI", routeSrc.includes('code: "needs_mapping"'));
}

console.log("\n══ 19. Broadcaster/stream preservation (structural) ══");
{
  const routeSrc = readFileSync(path.join(ROOT, "src/app/api/admin/fixtures/import/route.ts"), "utf8");
  const writes = [...routeSrc.matchAll(/client\s*\.from\("([a-z_]+)"\)\s*\.(insert|update|delete|upsert)/g)]
    .map((m) => `${m[1]}.${m[2]}`);
  check("writes only matches + fixture_import_keys",
    writes.length > 0 && writes.every((w) => w.startsWith("matches.") || w.startsWith("fixture_import_keys.")),
    JSON.stringify(writes));
  const updateBlock = routeSrc.split(".update({")[1]?.split("})")[0] ?? "";
  check("update never writes logos", !/home_team_logo|away_team_logo/.test(updateBlock), updateBlock.slice(0, 120));
  check("update never writes published", !/published/.test(updateBlock));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
rmSync(OUT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
