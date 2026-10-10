/**
 * Minimal, dependency-free CSV parser.
 *
 * Written by hand rather than pulling in a library because the requirements are
 * narrow and the failure modes matter:
 *
 * - A UTF-8 BOM (`\uFEFF`) is stripped. Excel writes one when a CSV is saved as
 *   "CSV UTF-8", and if it is left on the first header the column never matches.
 * - The delimiter is sniffed from the header region, so comma, semicolon and
 *   tab separated files all work. Semicolon is what Excel uses in locales where
 *   the comma is the decimal separator.
 * - Quoted fields may contain the delimiter, newlines and doubled quotes.
 */

export type Delimiter = "," | ";" | "\t" | "|";

/** Removes a leading BOM, if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Picks the delimiter that appears most consistently across the first lines.
 *
 * Counting on the whole file would be skewed by data rows containing commas in
 * team names, so only the first few lines are inspected and consistency across
 * them is required.
 */
export function sniffDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [",", ";", "\t", "|"];
  const lines = stripBom(text).split(/\r?\n/).filter((line) => line.trim() !== "");

  // Sample a few lines, but skip a leading title line when a later line looks
  // like data. A title such as "La Liga 2026 - FC Barcelona,,,,," is riddled
  // with trailing commas and would otherwise win over the real delimiter.
  const sample = pickSampleLines(lines);
  if (sample.length === 0) return ",";

  let best: Delimiter = ",";
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, delimiter));

    // Count how many sampled lines actually contain this delimiter, and the
    // most common occurrence count among those lines.
    const withDelimiter = counts.filter((n) => n > 0);
    if (withDelimiter.length === 0) continue;

    const frequency = new Map<number, number>();
    for (const n of withDelimiter) frequency.set(n, (frequency.get(n) ?? 0) + 1);
    let modalCount = 0;
    let modalLines = 0;
    for (const [count, hits] of frequency) {
      if (hits > modalLines || (hits === modalLines && count > modalCount)) {
        modalCount = count;
        modalLines = hits;
      }
    }

    // Score = how many lines agree on this delimiter, weighted by how many
    // columns it produces. Coverage of the sample matters more than raw count,
    // so a delimiter present in every data line beats one present in a single
    // punctuation-heavy title.
    const coverage = withDelimiter.length / sample.length;
    const score = modalLines * 10 + modalCount * 3 + coverage * 10;

    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/**
 * Chooses which lines to sniff.
 *
 * Drops a leading line that has only one populated field when a following line
 * has more, which is the signature of a title row above the real header.
 */
function pickSampleLines(lines: string[]): string[] {
  const head = lines.slice(0, 6);
  if (head.length > 1) {
    const populated = (line: string) =>
      line.split(/[,;\t|]/).filter((c) => c.trim() !== "").length;
    if (populated(head[0]) <= 1 && populated(head[1]) > 1) return head.slice(1);
  }
  return head;
}

/** Counts delimiter occurrences, ignoring any inside quoted fields. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { i += 1; continue; }
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/**
 * Parses CSV text into a matrix of strings.
 *
 * Handles quoted fields containing the delimiter, embedded newlines and escaped
 * `""` quotes. Rows may be ragged; the caller normalises the width.
 */
export function parseCsv(text: string, delimiter?: Delimiter): string[][] {
  const input = stripBom(text).replace(/^\uFEFF/, "");
  const sep = delimiter ?? sniffDelimiter(input);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }

    if (ch === sep) { row.push(field); field = ""; continue; }

    if (ch === "\r") {
      // Normalise CRLF and lone CR to a single row break.
      if (input[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
      continue;
    }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }

    field += ch;
  }

  // Flush the final field/row when the file does not end in a newline.
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }

  return rows.map((cells) => cells.map((value) => value.trim()));
}
