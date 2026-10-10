/**
 * Repairs text that was decoded with the wrong character encoding.
 *
 * The problem
 * -----------
 * A CSV exported as UTF-8 but read as Mac Roman turns each UTF-8 byte into the
 * Mac Roman glyph for that byte. Because `0xC3` is `√` in Mac Roman, a
 * two-byte accented letter becomes a `√` followed by another symbol:
 *
 *   Martínez  ->  Mart√≠nez
 *   València  ->  Val√®ncia
 *   Atlético  ->  Atl√©tico
 *
 * The same bytes read as Windows-1252 instead produce `Ã` sequences
 * (`MartÃnez`), so both families are handled.
 *
 * Why this is guarded so heavily
 * ------------------------------
 * "Fix the encoding" is dangerous: a naive repair mangles names that were
 * already correct. This only rewrites a string when reinterpreting its bytes as
 * UTF-8 produces a *valid* result containing a genuine accented letter — and it
 * refuses whenever the operation would damage an already-decodable value. Text
 * with no mojibake marker is returned untouched, byte for byte.
 *
 * Known limit: when the second byte of an accented letter was a control
 * character, it is discarded before this code ever sees the string, leaving
 * `MartÃnez` with no way to tell `í` from `ì` or `î`. Such values are left as
 * they are rather than guessed at, and the affected rows are reported to the
 * admin so a human decides. Guessing here would silently invent a player's name.
 */

/**
 * Mac Roman's high range, indexed by byte value 0x80–0xFF.
 * Only the characters that can appear as a first/continuation byte of a UTF-8
 * sequence matter here, but the whole table is provided for correctness.
 */
const MAC_ROMAN_HIGH = [
  "Ä", "Å", "Ç", "É", "Ñ", "Ö", "Ü", "á", "à", "â", "ä", "ã", "å", "ç", "é", "è",
  "ê", "ë", "í", "ì", "î", "ï", "ñ", "ó", "ò", "ô", "ö", "õ", "ú", "ù", "û", "ü",
  "†", "°", "¢", "£", "§", "•", "¶", "ß", "®", "©", "™", "´", "¨", "≠", "Æ", "Ø",
  "∞", "±", "≤", "≥", "¥", "µ", "∂", "∑", "∏", "π", "∫", "ª", "º", "Ω", "æ", "ø",
  "¿", "¡", "¬", "√", "ƒ", "≈", "∆", "«", "»", "…", " ", "À", "Ã", "Õ", "Œ", "œ",
  "–", "—", "“", "”", "‘", "’", "÷", "◊", "ÿ", "Ÿ", "⁄", "€", "‹", "›", "ﬁ", "ﬂ",
  "‡", "·", "‚", "„", "‰", "Â", "Ê", "Á", "Ë", "È", "Í", "Î", "Ï", "Ì", "Ó", "Ô",
  " ", "Ò", "Ú", "Û", "Ù", "ı", "ˆ", "˜", "¯", "˘", "˙", "˚", "¸", "˝", "˛", "ˇ",
];

/** Reverse lookup: Mac Roman character -> its byte value. */
const MAC_ROMAN_BYTES = new Map<string, number>();
MAC_ROMAN_HIGH.forEach((char, index) => {
  // Later duplicates must not overwrite an earlier, more common mapping.
  if (!MAC_ROMAN_BYTES.has(char)) MAC_ROMAN_BYTES.set(char, 0x80 + index);
});

/**
 * Characters that only appear when UTF-8 has been decoded as Mac Roman or
 * Windows-1252. Their presence is the trigger for attempting a repair;
 * a string without any of them is never touched.
 */
const MOJIBAKE_MARKERS = /[√¬ÃÂÅÐ][\u0080-\u00ff\u2000-\u22ff]/;

/** True when a value carries the signature of a mis-decoded UTF-8 string. */
export function looksMisDecoded(value: string): boolean {
  if (!value) return false;
  // A lone √ in legitimate text (a maths symbol) is not enough on its own; the
  // marker must be followed by another high character, as mojibake always is.
  return MOJIBAKE_MARKERS.test(value);
}

/**
 * Converts a string back to the bytes it would have had before mis-decoding.
 *
 * ASCII passes through untouched. Everything else is looked up in the supplied
 * table. That lookup must take priority over the character's own code point:
 * `®` is U+00AE, but as Mac Roman mojibake it stands for byte 0xA8, so treating
 * it as 0xAE would silently mis-repair `Val√®ncia` into `Valîncia`.
 *
 * When no table is supplied the code point is used directly (Latin-1).
 */
function toBytes(value: string, table: Map<string, number> | null): number[] | null {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x7f) { bytes.push(code); continue; }

    if (table) {
      const mapped = table.get(char);
      if (mapped !== undefined) { bytes.push(mapped); continue; }
      // Not in the Mac Roman table; fall back to the code point when it is a
      // single byte, so a stray higher character does not abort the repair.
      if (code <= 0xff) { bytes.push(code); continue; }
      return null;
    }

    if (code <= 0xff) { bytes.push(code); continue; }
    return null; // Unmappable: cannot be a byte.
  }
  return bytes;
}

/** Decodes bytes as UTF-8, returning null when the sequence is not valid UTF-8. */
function decodeUtf8Strict(bytes: number[]): string | null {
  const buffer = Buffer.from(bytes);
  const decoded = buffer.toString("utf8");
  // Buffer.toString replaces invalid sequences with U+FFFD; reject those.
  if (decoded.includes("\uFFFD")) return null;
  // Round-trip check: re-encoding must reproduce the same bytes exactly.
  if (Buffer.from(decoded, "utf8").compare(buffer) !== 0) return null;
  return decoded;
}

/** Counts accented Latin letters, used to score how "repaired" a result looks. */
function accentedLetterCount(value: string): number {
  return (value.match(/[À-ÖØ-öø-ÿ]/g) ?? []).length;
}

/** Counts mojibake markers, used to score how broken a candidate still is. */
function markerCount(value: string): number {
  return (value.match(/[√¬ÃÂ]/g) ?? []).length;
}

/**
 * Repairs one string if it was mis-decoded as Mac Roman or Windows-1252.
 *
 * Returns the original string when:
 *  - it carries no mojibake marker (the common case, including Arabic text);
 *  - the bytes do not form valid UTF-8;
 *  - the repair would introduce replacement characters;
 *  - the repair does not actually improve the text.
 */
export function repairMisDecoded(value: string): string {
  if (!value || !looksMisDecoded(value)) return value;

  const candidates: string[] = [];

  // Mac Roman first: it is what produces the √≠ / √® / √© pattern in the file.
  const macBytes = toBytes(value, MAC_ROMAN_BYTES);
  if (macBytes) {
    const decoded = decodeUtf8Strict(macBytes);
    if (decoded) candidates.push(decoded);
  }

  // Latin-1 / Windows-1252 fallback: the same corruption presents as Ã© / Ã­.
  const latinBytes = toBytes(value, null);
  if (latinBytes) {
    const decoded = decodeUtf8Strict(latinBytes);
    if (decoded) candidates.push(decoded);
  }

  // A Mac Roman sequence whose continuation byte was a discarded control
  // character leaves `Ã` with nothing after it. Those are unrecoverable: the
  // information is gone. They are deliberately NOT guessed at, because picking
  // between í ì î ï would be inventing data.
  if (/[ÃÂ]\s|[ÃÂ][^\u0080-\uffff]|[ÃÂ]$/.test(value)) return value;

  if (candidates.length === 0) return value;

  // Choose the candidate that removes the most markers and yields the most
  // accented letters. Anything that is not clearly better is discarded.
  let best = value;
  let bestScore = markerCount(value) * 2 - accentedLetterCount(value);
  for (const candidate of candidates) {
    const score = markerCount(candidate) * 2 - accentedLetterCount(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Only accept a change that strictly reduced the corruption.
  return best !== value && markerCount(best) < markerCount(value) ? best : value;
}

/**
 * Applies `repairMisDecoded` to a value that may or may not be a string.
 * Non-strings pass through unchanged.
 */
export function repairValue(value: unknown): unknown {
  return typeof value === "string" ? repairMisDecoded(value) : value;
}
