/**
 * Team name normalisation and identity.
 *
 * A team's logo must follow the team, not the fixture, so every name that refers
 * to the same club has to collapse to one stable key. At the same time the
 * normalisation must never merge genuinely different clubs.
 *
 * The rules below are deliberately conservative:
 *
 *   "FC Barcelona"      -> "barcelona"
 *   "F.C. Barcelona"    -> "barcelona"
 *   "Barcelona"         -> "barcelona"
 *   "Atlético de Madrid"-> "atleticodemadrid"
 *   "Manchester United" -> "manchesterunited"   (NEVER "manchester")
 *   "Manchester City"   -> "manchestercity"     (stays distinct)
 *
 * Only a small set of *leading* noise words is stripped (`fc`, `cf`, `sc`, …),
 * because club prefixes are conventional and carry no identity. Generic words
 * that do carry identity in some clubs and not others (`united`, `city`,
 * `real`) are deliberately NOT stripped — dropping them would merge
 * Manchester United with Manchester City.
 */
/**
 * Prefixes stripped from the front of a name only. These are conventional club
 * designators that do not distinguish one club from another.
 */
const LEADING_NOISE = [
    "fc", "cf", "sc", "ac", "as", "afc", "cd", "ca", "rc", "ud", "sd", "sv", "vfl", "vfb", "tsg", "bsc",
];
/**
 * Designators that are unambiguous when trailing: nobody is *named* "CF".
 * These are stripped from either end.
 */
const SAFE_TRAILING_NOISE = ["fc", "cf", "afc", "cd", "ca", "rc", "ud", "sd"];
/**
 * Designators that carry real identity when trailing and are therefore kept.
 * `SC` is the important case: "Barcelona SC" is a different club from
 * "Barcelona", so stripping it would merge two real teams onto one crest.
 */
const AMBIGUOUS_TRAILING = ["sc", "ac", "as", "sv", "bsc"];
/** Words removed anywhere in the name: pure grammatical glue. */
const GLUE_WORDS = ["de", "del", "of", "the", "and", "y", "e", "di", "da", "do", "el", "la", "le"];
/**
 * Normalises a team name into a stable key.
 *
 * Arabic letters are folded (أ إ آ → ا, ة → ه, ى → ي) so a name written with
 * different diacritics or letter forms resolves to one key, matching the
 * convention already used by the fixture importer.
 */
export function normaliseTeamKey(name) {
    const value = String(name ?? "")
        .trim()
        .toLowerCase()
        // Arabic diacritics, tatweel and letter variants.
        .replace(/[ًٌٍَُِّْـ]/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ة/g, "ه")
        .replace(/ى/g, "ي")
        // Latin diacritics: é -> e, ñ -> n, ü -> u, ç -> c.
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ç/g, "c")
        // Possessives.
        .replace(/[’']s\b/g, "")
        // Abbreviation dots are removed *without* leaving a separator, so "F.C."
        // collapses to "fc" and can then be recognised as a club designator.
        // Replacing them with a space produced the tokens "f" and "c", which is
        // why "F.C. Barcelona" previously failed to match "FC Barcelona".
        .replace(/\./g, "")
        // Remaining punctuation separates words, including the Arabic comma.
        .replace(/[,'"`´،؛;:!?()[\]{}&/\\|_+*]/g, " ")
        .replace(/-+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!value)
        return "";
    let words = value.split(" ").filter(Boolean);
    // Drop a leading club designator ("fc barcelona" -> "barcelona").
    if (words.length > 1 && LEADING_NOISE.includes(words[0]))
        words = words.slice(1);
    // A trailing designator is stripped only when it is unambiguous
    // ("elche cf" -> "elche", "sevilla fc" -> "sevilla"). Ambiguous ones are kept,
    // so "barcelona sc" stays distinct from "barcelona" — Barcelona (Spain) and
    // Barcelona SC (Ecuador) are separate clubs and must not share a crest.
    if (words.length > 1 &&
        SAFE_TRAILING_NOISE.includes(words[words.length - 1]) &&
        !AMBIGUOUS_TRAILING.includes(words[words.length - 1])) {
        words = words.slice(0, -1);
    }
    // Remove grammatical glue words.
    const meaningful = words.filter((word) => !GLUE_WORDS.includes(word));
    if (meaningful.length > 0)
        words = meaningful;
    // A club designator written without a space ("f.c.barcelona" after the dots
    // are stripped) is one token, and the checks above only match whole tokens.
    // Strip a known designator prefix from the joined form so it folds together
    // with "fc barcelona". The remainder must stay long enough to be a real name,
    // so "acmilan" keeps enough to avoid collapsing to something meaningless.
    if (words.length === 1) {
        const joined = words[0];
        for (const noise of LEADING_NOISE) {
            if (joined.startsWith(noise) && joined.length - noise.length >= 4) {
                words = [joined.slice(noise.length)];
                break;
            }
        }
    }
    return words.join("");
}
/**
 * Candidate names to try when resolving an imported name to a saved team.
 *
 * Returned in priority order: the exact normalised key first, then a few
 * conservative reductions. Each candidate is still looked up explicitly in the
 * database, so nothing is merged unless a human recorded that alias.
 */
export function candidateKeys(name) {
    const raw = String(name ?? "").trim();
    if (!raw)
        return [];
    const seen = new Set();
    const push = (value) => {
        const key = normaliseTeamKey(value);
        if (key)
            seen.add(key);
    };
    push(raw);
    // Strip a trailing club designator that survived normalisation of a long name,
    // and the whole-name case where only a designator plus one word exist.
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length > 2) {
        push(words.slice(1).join(" ")); // "fc barcelona" -> "barcelona"
        push(words.slice(0, -1).join(" ")); // "barcelona fc" -> "barcelona"
    }
    // Arabic definite article at the start ("النصر" vs "نصر").
    push(raw.replace(/^ال/, ""));
    return [...seen];
}
/** True when two names refer to the same normalised team identity. */
export function isSameTeam(a, b) {
    const left = normaliseTeamKey(a);
    const right = normaliseTeamKey(b);
    return Boolean(left) && left === right;
}
