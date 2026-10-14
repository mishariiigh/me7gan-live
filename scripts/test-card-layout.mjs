/**
 * Computes the horizontal space available to a team name in a match card, at
 * real viewport widths, from the CSS values actually in `platform.css`.
 *
 * This is a geometry check, not a browser render: it parses the real grid
 * definition, padding and logo sizes out of the stylesheet so the numbers
 * reflect the shipped CSS rather than assumptions. It exists because a truncated
 * team name ("Barc......") is a *space* problem, and space can be measured.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/platform.css", import.meta.url), "utf8");

/**
 * Reads a `prop: value;` pair from the rule whose selector matches exactly.
 *
 * The selector must be followed by `{`, so `.match-card` does not accidentally
 * match the `.match-card-link` rule that appears earlier in the file.
 */
function ruleValue(selector, prop) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  const found = match[1].match(new RegExp(`(?:^|\\n|;)\\s*${prop}\\s*:\\s*([^;]+);`));
  if (!found) throw new Error(`${prop} not found in ${selector}`);
  return found[1].trim();
}

const px = (value) => Number.parseFloat(value);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ── Values read from the real stylesheet ────────────────────────────────────
const gridMin = px(ruleValue(".match-grid", "grid-template-columns").match(/minmax\((\d+)px/)[1]);
const cardPadding = px(ruleValue(".match-card", "padding"));
const logoMd = px(ruleValue(".team-md .team-logo", "width"));
const teamGap = px(ruleValue(".team", "gap"));

console.log("\n── values parsed from platform.css ──");
console.log(`  card min width : ${gridMin}px`);
console.log(`  card padding   : ${cardPadding}px`);
console.log(`  logo (md)      : ${logoMd}px`);
console.log(`  team gap       : ${teamGap}px`);

/**
 * Width available to one team name inside a card of `cardWidth`.
 *
 * The body is now a single stacked column, so a team row gets the full inner
 * width minus the logo and the row's gap to the name — the favourite star is
 * pushed to the far edge by `justify-content: space-between` and only consumes
 * space when the name is short enough not to need it.
 */
function nameWidth(cardWidth) {
  const inner = cardWidth - cardPadding * 2;
  return inner - logoMd - teamGap;
}

console.log("\n── name width by card width ──");
for (const w of [300, 320, 360, 420]) {
  const avail = nameWidth(w);
  console.log(`  card ${w}px -> ${avail.toFixed(0)}px for the name`);
}

console.log("\n══ assertions ══");
{
  // "Barcelona" at 14px semibold is roughly 70px wide; the previous layout gave
  // it ~67px at the minimum card width, which is exactly why it truncated.
  const minCard = nameWidth(gridMin);
  check(
    `at the minimum card width (${gridMin}px) a name gets >= 200px`,
    minCard >= 200,
    `${minCard.toFixed(0)}px`,
  );
  const bodyColumns = ruleValue(".match-card-body", "grid-template-columns");
  check(
    "the body is a single stacked column, not a 3-column grid",
    bodyColumns.replace(/\s+/g, " ").trim() === "minmax(0, 1fr)",
    bodyColumns,
  );

  check("names may wrap to two lines (line-clamp: 2 present)", /-webkit-line-clamp:\s*2/.test(css));
  check("overflow-wrap: anywhere is set for long unbroken names", /overflow-wrap:\s*anywhere/.test(css));
  check("there is a narrow-width fallback to a single line", /max-width:\s*420px[\s\S]{0,200}line-clamp:\s*1/.test(css));
  check("logos cannot shrink (flex: 0 0 auto on .team-logo)", /\.team-logo\s*\{[^}]*flex:\s*0 0 auto/.test(css));
  check("the team name takes the remaining width", /\.match-card-team-row > \.team\s*\{[^}]*flex:\s*1 1 auto/.test(css));
  check("no fixed 268px grid minimum remains", !/minmax\(268px/.test(css));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);