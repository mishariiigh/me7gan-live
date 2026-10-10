import "server-only";
import { COMPETITIONS, isCompetition, type Competition } from "@/lib/sports/competitions";
import { parseCsv } from "@/lib/sports/csv-parse";
import { looksMisDecoded, repairMisDecoded } from "@/lib/sports/text-repair";
import type { FieldName } from "@/lib/sports/fixture-import-fields";

// Re-exported so the API route has a single import site for the parser and the
// field descriptors it needs.
export { FIELD_LABELS, REQUIRED_FIELDS } from "@/lib/sports/fixture-import-fields";
export type { FieldName } from "@/lib/sports/fixture-import-fields";

/**
 * Excel fixture import: parsing, column mapping, validation and key derivation.
 *
 * This module is pure with respect to the database — it turns a spreadsheet
 * into a validated plan. The route decides whether to preview or commit it.
 *
 * Everything here treats the uploaded file as hostile input: cell values are
 * coerced to strings before use, row counts are bounded, and no value is
 * trusted to be a valid date, time or competition.
 */

/** Hard limits so a malformed or oversized workbook cannot exhaust the server. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_ROWS = 2000;

export type ImportRow = {
  /** 1-based row number in the sheet, for error messages the admin can act on. */
  row: number;
  matchDate: string;
  kickoffTime: string;
  competition: Competition;
  homeTeam: string;
  awayTeam: string;
  /** Stable key taken from the sheet, when a recognised column is present. */
  providedKey: string | null;
  /** Key used to match an existing fixture. See `deriveSourceKey`. */
  sourceKey: string;
  sourceKind: "provided" | "natural";
};

export type RejectedRow = {
  row: number;
  /** Values as read, so the admin can see exactly what was wrong. */
  raw: Record<string, string>;
  reasons: string[];
};

export type ParseResult = {
  headers: string[];
  mapping: Record<FieldName, string | null>;
  rows: ImportRow[];
  rejected: RejectedRow[];
};

/* =========================================================================
   COLUMN DETECTION
   ========================================================================= */

/**
 * Words that identify a column, scored by how strongly they imply the field.
 *
 * Detection is scored rather than exact-matched because real exports name the
 * same thing many ways: "Fecha", "Kick-off Time (BST)", "Local Team",
 * "Home Team Name". An exact table can never enumerate those, so each header is
 * scored against these markers and the best candidate per field wins.
 */
const FIELD_MARKERS: Record<FieldName, { strong: string[]; weak: string[] }> = {
  matchDate: {
    strong: ["date", "fecha", "datum", "fecha", "data", "التاريخ", "تاريخ"],
    weak: ["day", "jour", "dia", "día", "اليوم"],
  },
  kickoffTime: {
    strong: ["time", "hora", "uhr", "zeit", "heures", "heure", "الوقت", "وقت", "التوقيت"],
    weak: ["kickoff", "kick-off", "kick off", "start", "ko", "alyawm"],
  },
  competition: {
    strong: ["competition", "competicion", "competición", "league", "liga", "tournament", "wettbewerb", "championnat", "البطولة", "الدوري", "المسابقة", "البطوله"],
    weak: ["division", "serie", "cup", "championship", "كأس"],
  },
  homeTeam: {
    strong: [
      "hometeam", "home", "local", "equipolocal", "casa", "heim", "heimteam", "domicile",
      "الفريقالاول", "الفريقالأول", "المضيف", "الفريقالمضيف", "الفريقالصاحب",
    ],
    weak: ["homeclub", "team1", "localteam", "host", "اول", "صاحبالمباراة"],
  },
  awayTeam: {
    strong: [
      "awayteam", "away", "visitante", "visitantes", "fuera", "gast", "gastteam", "exterieur",
      "الفريقالثاني", "الضيف", "الفريقالضيف", "الفريقالزائر",
    ],
    weak: ["awayclub", "team2", "guest", "ثاني", "الفريقالثانيه"],
  },
  key: {
    strong: [
      "matchnumber", "matchno", "matchnum", "fixtureid", "matchid", "matchkey", "fixturekey",
      "رقمالمباراة", "رقماللقاء", "المعرف", "معرفالمباراة",
    ],
    weak: ["eventid", "gameid", "id", "ref", "no", "number"],
  },
};

/** A header that names both teams (e.g. "Fixture", "Match", "المباراة"). */
const FIXTURE_MARKERS = ["fixture", "match", "partido", "encuentro", "المباراة", "مباراة"];

/** A header holding date and time together (e.g. "Date & Time", "Kickoff"). */
const COMBINED_MARKERS = ["datetime", "dateandtime", "kickoff", "kick-off", "fechahora", "التاريخوالوقت", "الموعد"];

/**
 * Scores how strongly a header names a given field.
 *
 * Returns 0 when nothing matches. Strong markers outrank weak ones, and an
 * exact alias match always wins so an unambiguous header is never displaced by
 * a coincidental substring in a neighbouring column.
 */
function scoreHeaderForField(header: string, field: FieldName): number {
  const h = normalise(header);
  if (!h) return 0;
  const { strong, weak } = FIELD_MARKERS[field];

  let score = 0;
  for (const marker of strong) {
    const m = normalise(marker);
    if (!m) continue;
    if (h === m) score = Math.max(score, 100);
    else if (h.startsWith(m) || h.endsWith(m)) score = Math.max(score, 70);
    else if (h.includes(m)) score = Math.max(score, 45);
  }
  if (score === 0) {
    for (const marker of weak) {
      const m = normalise(marker);
      if (!m) continue;
      if (h === m) score = Math.max(score, 60);
      else if (h.includes(m)) score = Math.max(score, 25);
    }
  }
  return score;
}

/** True when a header appears to hold both teams in one column. */
function looksLikeFixtureColumn(header: string): boolean {
  const h = normalise(header);
  return FIXTURE_MARKERS.some((marker) => {
    const m = normalise(marker);
    return h === m || h.endsWith(m) || h.endsWith(`${m}s`);
  });
}

/** True when a header appears to hold date and time together. */
function looksLikeCombinedColumn(header: string): boolean {
  const h = normalise(header);
  return COMBINED_MARKERS.some((marker) => h.replace(/[&+]/g, "").includes(normalise(marker)));
}

/** Best-matching header for a field above `threshold`, or null. */
function bestHeaderFor(headers: string[], field: FieldName, taken: Set<string>, threshold = 40) {
  let best: string | null = null;
  let bestScore = 0;
  for (const header of headers) {
    if (!header || taken.has(header)) continue;
    const score = scoreHeaderForField(header, field);
    if (score > bestScore && score >= threshold) { bestScore = score; best = header; }
  }
  return best;
}

/**
 * Normalises a value for comparison: lowercase, no spaces or punctuation, and
 * with Arabic letter variants folded together.
 *
 * Folding `أ إ آ` → `ا`, `ة` → `ه` and `ى` → `ي` matters because the same header
 * or team name is commonly written several ways. Without it, "دوري أبطال أوروبا"
 * and "دوري ابطال اوروبا" would be treated as different competitions.
 */
function normalise(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, "") // Arabic diacritics and tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\s_\-.]/g, "");
}

/** Turns any cell into a trimmed string. Objects/arrays become "". */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return "";
  return String(value).trim();
}

/**
 * Guesses the column mapping from a header row.
 *
 * Fields are resolved strongest-first so a specific column ("Home Team") is
 * claimed before a generic one can take it. "Team" alone is deliberately not a
 * marker, because it is ambiguous between home and away.
 *
 * A single column holding both teams ("Fixture", "Match", "Partido") is also
 * detected; the split is applied later, per row, in `splitFixtureColumn`.
 */
export function detectMapping(headers: string[]): Record<FieldName, string | null> {
  const mapping = {
    matchDate: null, kickoffTime: null, competition: null,
    homeTeam: null, awayTeam: null, key: null,
  } as Record<FieldName, string | null>;

  const taken = new Set<string>();
  const claim = (field: FieldName, header: string | null) => {
    if (header && !taken.has(header) && mapping[field] === null) {
      mapping[field] = header;
      taken.add(header);
    }
  };

  // Most specific fields first, so generic headers are not stolen early.
  claim("homeTeam", bestHeaderFor(headers, "homeTeam", taken));
  claim("awayTeam", bestHeaderFor(headers, "awayTeam", taken));
  claim("competition", bestHeaderFor(headers, "competition", taken));
  claim("matchDate", bestHeaderFor(headers, "matchDate", taken));
  claim("kickoffTime", bestHeaderFor(headers, "kickoffTime", taken));
  claim("key", bestHeaderFor(headers, "key", taken, 60));

  return mapping;
}

/**
 * Finds an unmapped column that holds both teams in one cell, if one exists.
 *
 * Only returned when home and away were not detected separately, so a sheet with
 * proper columns is never overridden by a coincidence.
 */
export function detectFixtureColumn(
  headers: string[],
  mapping: Record<FieldName, string | null>,
): string | null {
  if (mapping.homeTeam || mapping.awayTeam) return null;
  const used = new Set(Object.values(mapping).filter(Boolean) as string[]);
  for (const header of headers) {
    if (!header || used.has(header)) continue;
    if (looksLikeFixtureColumn(header)) return header;
  }
  return null;
}

/**
 * Finds an unmapped column holding date and time together, if one exists.
 *
 * Only used when date and time were not detected as separate columns.
 */
export function detectCombinedColumn(
  headers: string[],
  mapping: Record<FieldName, string | null>,
): string | null {
  if (mapping.matchDate && mapping.kickoffTime) return null;

  // A combined header such as "Date & Time" is often claimed by the date field
  // first, because it contains the word "date". When that happens the *mapped*
  // column is itself the combined one, so it is returned here and the row reader
  // splits each cell into a date and a time.
  if (mapping.matchDate && looksLikeCombinedColumn(mapping.matchDate) && !mapping.kickoffTime) {
    return mapping.matchDate;
  }
  if (mapping.kickoffTime && looksLikeCombinedColumn(mapping.kickoffTime) && !mapping.matchDate) {
    return mapping.kickoffTime;
  }

  const used = new Set(Object.values(mapping).filter(Boolean) as string[]);
  for (const header of headers) {
    if (!header || used.has(header)) continue;
    if (looksLikeCombinedColumn(header)) return header;
  }
  return null;
}

/**
 * Splits a "Home vs Away" cell into its two team names.
 *
 * Recognises the separators real exports use: `vs`, `v`, `-`, `–`, `—`, `x`,
 * `@` and the Arabic `ضد`. Returns null when no separator is present, so the row
 * is reported rather than silently truncated.
 */
export function splitFixtureColumn(value: string): { homeTeam: string; awayTeam: string } | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  // "vs" first (case-insensitive), then the other separators.
  const patterns = [
    /\s+(?:vs\.?|v\.?)\s+/i,
    /\s+(?:ضد)\s+/,
    /\s+[@x×]\s+/i,
    /\s+[–—]\s*/,
    /\s+-\s+/,
  ];
  for (const pattern of patterns) {
    const parts = text.split(pattern);
    if (parts.length === 2) {
      const homeTeam = parts[0].trim();
      const awayTeam = parts[1].trim();
      if (homeTeam && awayTeam) return { homeTeam, awayTeam };
    }
  }
  return null;
}

/**
 * Splits a combined "date and time" value.
 *
 * Only the text after the date is treated as the time, and the result is only
 * accepted when it parses as a real time. That keeps a plain date column (or a
 * date containing dashes) from being mangled.
 */
export function splitDateAndTime(value: unknown): { matchDate: string | null; kickoffTime: string | null } {
  const text = cell(value);
  if (!text) return { matchDate: null, kickoffTime: null };

  // A real Date from SheetJS already carries both halves.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { matchDate: parseMatchDate(value), kickoffTime: parseKickoffTime(value) };
  }

  const match = /^(.+?)[\s,T]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)$/.exec(text);
  if (!match) return { matchDate: parseMatchDate(text), kickoffTime: null };

  const datePart = match[1].trim();
  const timePart = match[2].trim().replace(/\./g, "");
  const kickoffTime = parseKickoffTime(timePart);
  if (!kickoffTime) return { matchDate: parseMatchDate(text), kickoffTime: null };

  return { matchDate: parseMatchDate(datePart), kickoffTime };
}

/**
 * Parses a date cell into YYYY-MM-DD.
 *
 * Spreadsheets store dates in several incompatible ways: a real date serial
 * (with `cellDates` SheetJS gives a Date), an ISO string, or a day-first or
 * month-first string. Ambiguous numeric forms are resolved as day-first, which
 * matches how fixtures are written in the project's Arabic context.
 */
export function parseMatchDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = cell(value);
  if (!text) return null;

  // ISO / sortable: 2026-03-01
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return assemble(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Slashed or dotted: 01/03/2026 or 01.03.2026 (day-first).
  // The date may have a time appended ("27/08/2026 22:00"), which is ignored
  // here: the time half is read by parseKickoffTime / splitDateAndTime. This
  // keeps a single Date column with an embedded time working even when the
  // combined-column detector is not involved.
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)?\s*$/.exec(text);
  if (dmy) return assemble(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  // A bare Excel serial number, when the column is not formatted as a date.
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  // Last resort: whatever the runtime can parse, but only if unambiguous.
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(text)) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Validates a calendar date, rejecting impossible values like 2026-02-31. */
function assemble(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parses a time cell into HH:MM (24-hour).
 *
 * Excel times arrive as a fractional day (0.8125 = 19:30), as "19:30", or as
 * "7:30 PM". All three are handled.
 */
export function parseKickoffTime(value: unknown): string | null {
  // Fractional day from a spreadsheet time cell.
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
  }

  const text = cell(value);
  if (!text) return null;

  // A bare time, "19:30" or "7:30 PM".
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/.exec(text);
  if (!match) {
    // A combined cell such as "27/08/2026 22:00": search for the time half
    // rather than requiring the whole cell to be a time. This is what makes a
    // single Date column carrying a kick-off work without a time column.
    const trailing = /(?:^|\s|T)(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?\s*$/.exec(text);
    if (!trailing) return null;
    return normaliseHourMinute(trailing[1], trailing[2], trailing[3]);
  }

  return normaliseHourMinute(match[1], match[2], match[3]);
}

/** Converts captured hour/minute/meridiem into a validated HH:MM string. */
function normaliseHourMinute(hourText: string, minuteText: string, meridiemText?: string): string | null {
  let matchHour = Number(hourText);
  const minute = Number(minuteText);
  const meridiem = meridiemText?.toLowerCase().replace(/\./g, "");

  if (minute > 59) return null;
  if (meridiem) {
    if (matchHour < 1 || matchHour > 12) return null;
    if (meridiem === "pm" && matchHour !== 12) matchHour += 12;
    if (meridiem === "am" && matchHour === 12) matchHour = 0;
  } else if (matchHour > 23) {
    return null;
  }

  return `${String(matchHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Resolves a competition name to one of the supported competitions.
 *
 * Synonyms cover the common ways these leagues are written in spreadsheets.
 */
export function parseCompetition(value: unknown): Competition | null {
  const text = cell(value);
  if (!text) return null;
  if (isCompetition(text)) return text;

  const key = normalise(text);
  const synonyms: Record<string, Competition> = {
    epl: "Premier League",
    premierleague: "Premier League",
    englishpremierleague: "Premier League",
    الدوريالانجليزي: "Premier League",
    الدوريالإنجليزي: "Premier League",
    laliga: "La Liga",
    spanishlaliga: "La Liga",
    الدوريالاسباني: "La Liga",
    الدوريالإسباني: "La Liga",
    seriea: "Serie A",
    italianseriea: "Serie A",
    الدوريالايطالي: "Serie A",
    الدوريالإيطالي: "Serie A",
    bundesliga: "Bundesliga",
    germanbundesliga: "Bundesliga",
    الدوريالالماني: "Bundesliga",
    الدوريالألماني: "Bundesliga",
    ligue1: "Ligue 1",
    frenchligue1: "Ligue 1",
    الدوريالفرنسي: "Ligue 1",
    ucl: "UEFA Champions League",
    championsleague: "UEFA Champions League",
    uefachampionsleague: "UEFA Champions League",
    دوريابطالاوروبا: "UEFA Champions League",
    دوريأبطالأوروبا: "UEFA Champions League",
  };
  return synonyms[key] ?? null;
}

/**
 * Stable key for matching an existing fixture.
 *
 * A key supplied by the sheet always wins — it is the only form of matching that
 * survives a rescheduled date. Otherwise a natural key is derived from the
 * fixture's identity. Team names are normalised so "Manchester United",
 * "man utd" and "Manchester  United" do not create three rows.
 */
export function deriveSourceKey(input: {
  providedKey: string | null;
  matchDate: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
}): { sourceKey: string; sourceKind: "provided" | "natural" } {
  const provided = cell(input.providedKey);
  if (provided) {
    // The provided key is namespaced by competition. A bare "Match Number" is
    // NOT globally unique — match 6 exists in every league — so storing it alone
    // would make an unrelated fixture collide with this one on a later import.
    // Namespacing keeps the key stable across reschedules while leaving it
    // unambiguous across competitions.
    const scope = normalise(input.competition);
    return { sourceKey: `id:${scope}:${normalise(provided)}`, sourceKind: "provided" };
  }
  const parts = [
    input.matchDate,
    normalise(input.competition),
    normalise(input.homeTeam),
    normalise(input.awayTeam),
  ];
  return { sourceKey: `nat:${parts.join("|")}`, sourceKind: "natural" };
}

/**
 * Validates every data row.
 *
 * A row is rejected only if it cannot be represented in the database. Anything
 * accepted here is guaranteed to satisfy the `matches` table constraints.
 *
 * Optional `options` widen what can be understood:
 * - `fixtureColumn`     a single column holding "Home vs Away"
 * - `combinedColumn`    a single column holding date and time together
 * - `competitionOverride` a competition applied to every row when the file has
 *   no competition column (a single-league export)
 * - `headerRow`         the real header row number, so reported row numbers
 *   match what the admin sees in their spreadsheet
 */
export function validateRows(
  raw: string[][],
  headers: string[],
  mapping: Record<FieldName, string | null>,
  options: {
    fixtureColumn?: string | null;
    combinedColumn?: string | null;
    competitionOverride?: Competition | null;
    headerRow?: number;
  } = {},
): { rows: ImportRow[]; rejected: RejectedRow[]; warnings: Record<number, string[]> } {
  const rows: ImportRow[] = [];
  const rejected: RejectedRow[] = [];
  // Non-fatal notes keyed by row number, surfaced in the preview.
  const acceptedWarnings = new Map<number, string[]>();

  // Duplicate keys inside one workbook are a data error, not a merge decision.
  const seen = new Map<string, number>();

  const indexOf = (field: FieldName) => {
    const header = mapping[field];
    return header === null ? -1 : headers.indexOf(header);
  };
  const at = (record: string[], field: FieldName) => {
    const i = indexOf(field);
    return i === -1 ? "" : record[i] ?? "";
  };
  const fixtureIndex = options.fixtureColumn ? headers.indexOf(options.fixtureColumn) : -1;
  let combinedIndex = options.combinedColumn ? headers.indexOf(options.combinedColumn) : -1;

  // When no dedicated combined column was identified and the kick-off has no
  // column of its own, the mapped date column is itself the combined source.
  // This is the common case for a header literally called "Date" whose cells
  // read "27/08/2026 22:00" — the date half is parsed as the date and the time
  // half supplies the kick-off, without inventing a second column.
  if (combinedIndex === -1 && !mapping.kickoffTime && mapping.matchDate) {
    combinedIndex = headers.indexOf(mapping.matchDate);
  }

  for (let r = 0; r < raw.length; r += 1) {
    const record = raw[r];
    // Reported rows match the spreadsheet's own numbering, so an error pointing
    // at row 17 is row 17 in Excel even when a title row precedes the headers.
    const rowNumber = r + (options.headerRow ?? 1) + 1;

    const rawValues: Record<string, string> = {};
    headers.forEach((header, i) => {
      rawValues[header] = cell(record?.[i]);
    });

    // A completely empty row is padding, not an error worth reporting. Checked
    // on the cells rather than the whole-record strings so a row that is only
    // spaces or tabs is treated as blank too.
    if (record.every((value) => String(value ?? "").trim() === "")) continue;
    if (Object.values(rawValues).every((value) => value === "")) continue;

    const reasons: string[] = [];

    // Date and time may come from one column ("2026-03-01 19:30") or two.
    let matchDate = parseMatchDate(at(record, "matchDate"));
    let kickoffTime = parseKickoffTime(at(record, "kickoffTime"));
    if (combinedIndex !== -1 && (!matchDate || !kickoffTime)) {
      const split = splitDateAndTime(record[combinedIndex]);
      matchDate = matchDate ?? split.matchDate;
      kickoffTime = kickoffTime ?? split.kickoffTime;
    }

    if (!matchDate) reasons.push("تاريخ غير صالح أو مفقود (Invalid or missing date)");
    if (!kickoffTime) reasons.push("وقت غير صالح أو مفقود (Invalid or missing kickoff time)");

    // The competition comes from a column when present, otherwise from the
    // admin's explicit single-league selection for this import.
    const competition =
      parseCompetition(at(record, "competition")) ?? options.competitionOverride ?? null;
    if (!competition) {
      reasons.push(
        `بطولة غير مدعومة (Unsupported competition). المدعوم: ${COMPETITIONS.join("، ")}`,
      );
    }

    // Teams may be two columns or one "Home vs Away" column. Names are passed
    // through the mojibake repair so UTF-8 read with the wrong codec does not
    // store "Mart√≠nez" as a team name. Correct text is returned unchanged.
    let homeTeam = repairMisDecoded(cell(at(record, "homeTeam")));
    let awayTeam = repairMisDecoded(cell(at(record, "awayTeam")));
    if (fixtureIndex !== -1 && (!homeTeam || !awayTeam)) {
      const split = splitFixtureColumn(record[fixtureIndex] ?? "");
      if (split) {
        homeTeam = homeTeam || repairMisDecoded(split.homeTeam);
        awayTeam = awayTeam || repairMisDecoded(split.awayTeam);
      } else if (!homeTeam && !awayTeam) {
        reasons.push(
          "تعذر فصل الفريقين من عمود واحد. استخدم صيغة \"المضيف ضد الضيف\" (Could not split the teams; use \"Home vs Away\")",
        );
      }
    }

    if (!homeTeam) reasons.push("الفريق المضيف مفقود (Missing home team)");
    else if (homeTeam.length > 120) reasons.push("اسم الفريق المضيف طويل جداً (Home team name too long)");

    if (!awayTeam) reasons.push("الفريق الضيف مفقود (Missing away team)");
    else if (awayTeam.length > 120) reasons.push("اسم الفريق الضيف طويل جداً (Away team name too long)");

    if (homeTeam && awayTeam && normalise(homeTeam) === normalise(awayTeam)) {
      reasons.push("الفريقان متطابقان (Home and away team are the same)");
    }

    // A name that still carries mojibake after repair was damaged beyond recovery
    // (its continuation byte was already discarded). It is imported as-is but
    // flagged, so the admin can correct it in the console rather than discovering
    // a mangled name on the public site later.
    const corruptNames = [homeTeam, awayTeam].filter((name) => name && looksMisDecoded(name));
    const warnings = corruptNames.length
      ? [`اسم فريق بترميز تالف — راجعه بعد الاستيراد (Team name looks mis-encoded: ${corruptNames.join("، ")})`]
      : [];

    if (reasons.length || !matchDate || !kickoffTime || !competition) {
      rejected.push({ row: rowNumber, raw: rawValues, reasons });
      continue;
    }

    // Non-fatal notes are attached to the accepted row so the preview can show
    // them without blocking the import.
    if (warnings.length) acceptedWarnings.set(rowNumber, warnings);

    const providedKey = cell(at(record, "key")) || null;
    const { sourceKey, sourceKind } = deriveSourceKey({
      providedKey, matchDate, competition, homeTeam, awayTeam,
    });

    const duplicateOf = seen.get(sourceKey);
    if (duplicateOf !== undefined) {
      rejected.push({
        row: rowNumber,
        raw: rawValues,
        reasons: [`مكرر داخل الملف — نفس مباراة السطر ${duplicateOf} (Duplicate row within this file)`],
      });
      continue;
    }
    seen.set(sourceKey, rowNumber);

    rows.push({ row: rowNumber, matchDate, kickoffTime, competition, homeTeam, awayTeam, providedKey, sourceKey, sourceKind });
  }

  return { rows, rejected, warnings: Object.fromEntries(acceptedWarnings) };
}

/* =========================================================================
   WORKBOOK / CSV READING
   ========================================================================= */

export type SheetRead = {
  headers: string[];
  raw: string[][];
  /** Name of the sheet (or file, for CSV) that supplied the data. */
  sheetName: string;
  /** 1-based row number where the header row was found. */
  headerRow: number;
  /** Every sheet name in the workbook, so the admin can pick another. */
  sheetNames: string[];
};

/**
 * Scores how plausible a row is as the header row.
 *
 * A league export often has a title row ("La Liga 2026 - FC Barcelona") above
 * the real headers. Assuming row 1 is the header makes detection fail on those
 * files, so the first rows are scored and the best one is chosen.
 */
function scoreHeaderRow(cells: string[]): number {
  const nonEmpty = cells.map((c) => c.trim()).filter((c) => c !== "");

  // A header row has at least three separate labels. A title row is one long
  // cell ("La Liga 2026 - FC Barcelona") and must never be mistaken for one,
  // even though it mentions a competition name that would otherwise score.
  if (nonEmpty.length < 3) return 0;

  let score = 0;
  for (const header of nonEmpty) {
    // A header label is short. A long cell is prose, not a column name, so it
    // contributes nothing and the row is not treated as headers.
    if (header.length > 40) return 0;

    for (const field of Object.keys(FIELD_MARKERS) as FieldName[]) {
      score += scoreHeaderForField(header, field) > 0 ? 10 : 0;
    }
    if (looksLikeFixtureColumn(header)) score += 8;
    if (looksLikeCombinedColumn(header)) score += 6;
  }
  return score;
}

/**
 * Locates the header row within a matrix.
 *
 * Scans the first 15 rows and returns the highest-scoring one. Falls back to
 * row 1 when nothing scores, so the admin still sees headers to map by hand.
 */
export function findHeaderRow(matrix: string[][]): number {
  const limit = Math.min(matrix.length, 15);
  let bestIndex = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i += 1) {
    const score = scoreHeaderRow(matrix[i] ?? []);
    if (score > bestScore) { bestScore = score; bestIndex = i; }
  }
  return bestScore > 0 ? bestIndex : 0;
}

/** Converts a matrix into headers + body rows, given the header row index. */
function matrixToRows(matrix: string[][], headerIndex: number): { headers: string[]; raw: string[][] } {
  const headerCells = [...(matrix[headerIndex] ?? [])];
  // Drop trailing empty header columns produced by stray formatting.
  while (headerCells.length && headerCells[headerCells.length - 1] === "") headerCells.pop();

  // A blank header cell above real data is common (unnamed column); label it so
  // it can still be chosen in the manual mapping UI.
  const headers = headerCells.map((h, i) => (h === "" ? `Column ${i + 1}` : h));

  const body = matrix.slice(headerIndex + 1);
  // Trailing blank rows are an artefact of spreadsheet formatting, not data.
  while (body.length && (body[body.length - 1] ?? []).every((v) => cell(v) === "")) body.pop();

  const raw = body.slice(0, MAX_ROWS).map((row) =>
    Array.from({ length: headers.length }, (_, i) => cell((row ?? [])[i])),
  );

  return { headers, raw };
}

/** True when a buffer looks like a CSV/text file rather than a zip-based xlsx. */
function looksLikeText(buffer: Buffer): boolean {
  // .xlsx is a ZIP archive and always starts with "PK". A CSV never does.
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return false;
  // Reject anything with NUL bytes; those are binary, not text.
  const window = buffer.subarray(0, Math.min(buffer.length, 2048));
  return !window.includes(0);
}

/**
 * Reads fixtures from an uploaded file.
 *
 * Supports `.xlsx`/`.xlsm`/`.xls` workbooks and plain `.csv`/`.tsv` text.
 * For workbooks every sheet is examined and the one that yields the best header
 * row is used, so a schedule is found on a second tab named "Calendario" just as
 * readily as on the first.
 */
export async function readSheetRows(buffer: Buffer, wantedSheet?: string): Promise<SheetRead> {
  const isText = looksLikeText(buffer);

  if (isText) {
    // Decode as UTF-8 and strip a BOM. Excel writes a BOM when saving "CSV UTF-8".
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const matrix = parseCsv(text);
    if (matrix.length === 0) {
      return { headers: [], raw: [], sheetName: "CSV", headerRow: 1, sheetNames: ["CSV"] };
    }
    const headerIndex = findHeaderRow(matrix);
    const { headers, raw } = matrixToRows(matrix, headerIndex);
    return { headers, raw, sheetName: "CSV", headerRow: headerIndex + 1, sheetNames: ["CSV"] };
  }

  // Imported dynamically so this Node-only parser is never pulled into a
  // browser bundle, and so the route only pays for it when a file is uploaded.
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    return { headers: [], raw: [], sheetName: "", headerRow: 1, sheetNames: [] };
  }

  // A requested sheet wins; otherwise score every sheet and keep the best.
  const candidates = wantedSheet && sheetNames.includes(wantedSheet) ? [wantedSheet] : sheetNames;

  let best: SheetRead | null = null;
  let bestScore = -Infinity;

  for (const name of candidates) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" })
      .map((row) => (row as unknown[]).map((v) => cell(v)));
    if (matrix.length === 0) continue;

    const headerIndex = findHeaderRow(matrix);
    const { headers, raw } = matrixToRows(matrix, headerIndex);
    const score = scoreHeaderRow(matrix[headerIndex] ?? []);

    if (score > bestScore || best === null) {
      bestScore = score;
      best = { headers, raw, sheetName: name, headerRow: headerIndex + 1, sheetNames };
    }
    // An unambiguous sheet is used immediately rather than scoring the rest.
    if (score >= 80) break;
  }

  return best ?? { headers: [], raw: [], sheetName: sheetNames[0], headerRow: 1, sheetNames };
}
