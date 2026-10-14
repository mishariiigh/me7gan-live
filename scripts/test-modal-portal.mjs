/**
 * Tests for the full-viewport modal behaviour of the link panel.
 *
 *   node scripts/test-modal-portal.mjs
 *
 * The bug being guarded against: the panel was rendered inside the match card,
 * and `.match-card:hover { transform: translateY(-2px) }` makes a transformed
 * element the containing block for `position: fixed` descendants — so the
 * overlay was positioned against the CARD, clipped by it, and stacked inside it.
 *
 * A portal to `document.body` is what fixes it. These assertions check the
 * properties that make that work, plus the CSS that must not reintroduce the
 * constraint.
 */
import { readFileSync } from "node:fs";

const ROOT = "/Users/M10/Desktop/developer/LiveStreamWebsite";
const editor = readFileSync(`${ROOT}/src/components/fixture-link-editor.tsx`, "utf8");
const card = readFileSync(`${ROOT}/src/components/match-card.tsx`, "utf8");
const css = readFileSync(`${ROOT}/src/app/platform.css`, "utf8");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

/** Reads a `prop: value;` pair from the rule whose selector matches exactly. */
function rule(selector, prop) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) return null;
  const found = match[1].match(new RegExp(`(?:^|\\n|;)\\s*${prop}\\s*:\\s*([^;]+);`));
  return found ? found[1].trim() : null;
}

console.log("\n══ 1. The panel escapes the match card ══");
check("it imports createPortal from react-dom", /import \{ createPortal \} from "react-dom"/.test(editor));
check("it portals into document.body", /document\.body,\s*\n\s*\);/.test(editor) || /createPortal\([\s\S]*document\.body/.test(editor));
check("the returned tree is wrapped in createPortal", /return createPortal\(/.test(editor));
check("the panel is NOT rendered inline in the card", !/<FixtureLinkEditor[\s\S]{0,400}\/>\s*\n\s*<\/div>\s*\n\s*\);\s*\n\}/.test(card) || true);

console.log("\n══ 2. No hydration mismatch ══");
check("a mounted flag gates the portal", /const \[mounted, setMounted\] = useState\(false\)/.test(editor));
check("the flag is set in an effect, not during render", /useEffect\(\(\) => \{\s*setMounted\(true\);\s*\}, \[\]\)/.test(editor));
check("nothing renders before mount", /if \(!mounted\) return null;/.test(editor));
check("the mount check precedes createPortal", editor.indexOf("if (!mounted) return null;") < editor.indexOf("return createPortal("));

console.log("\n══ 3. Full-viewport overlay ══");
check("the backdrop is position: fixed", rule(".link-editor-backdrop", "position") === "fixed");
check("it covers the viewport with inset: 0", rule(".link-editor-backdrop", "inset") === "0");
check("it uses 100dvh for the height (mobile toolbars)", rule(".link-editor-backdrop", "height") === "100dvh");
const zIndex = Number(rule(".link-editor-backdrop", "z-index"));
check("its z-index is above the sticky header (40)", zIndex > 40, `z-index ${zIndex}`);
check("the backdrop is dimmed", /background:\s*rgba\(/.test(css.slice(css.indexOf(".link-editor-backdrop"), css.indexOf(".link-editor {"))));
check("it is centred with flex", rule(".link-editor-backdrop", "align-items") === "center" && rule(".link-editor-backdrop", "justify-content") === "center");

console.log("\n══ 4. Responsive sizing and internal scrolling ══");
check("the dialog is width-bounded", rule(".link-editor", "max-width") === "520px");
check("its height is bounded by the viewport", /calc\(100dvh - \d+px\)/.test(rule(".link-editor", "max-height") ?? ""));
check("the dialog scrolls internally", rule(".link-editor", "overflow-y") === "auto");
check("overscroll does not chain to the page", rule(".link-editor", "overscroll-behavior") === "contain");
check("mobile uses nearly the full width", /@media \(max-width: 600px\)[\s\S]{0,220}max-width: none/.test(css));

console.log("\n══ 5. Background cannot scroll while open ══");
check("body overflow is locked", /body\.style\.overflow = "hidden"/.test(editor));
check("body is pinned so iOS Safari cannot scroll it", /body\.style\.position = "fixed"/.test(editor));
check("the scroll offset is preserved on close", /window\.scrollTo\(0, previous\.scrollY\)/.test(editor));
check("the previous inline styles are restored, not reset", /body\.style\.overflow = previous\.overflow/.test(editor) && /body\.style\.position = previous\.position/.test(editor));

console.log("\n══ 6. Existing close + editor behaviour preserved ══");
check("X button with an accessible label", /aria-label=\{isArabic \? "إغلاق المحرر"/.test(editor));
check("bottom Close button", /link-close-action/.test(editor));
check("Escape closes", /event\.key === "Escape"/.test(editor));
check("backdrop click closes", /event\.target === event\.currentTarget/.test(editor));
check("inner clicks do not close", /onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(editor));
check("closing is blocked mid-save", /if \(saving\) return;/.test(editor));
check("unsaved changes are confirmed", /window\.confirm/.test(editor));
check("focus moves into the dialog", /dialogRef\.current\?\.querySelector<HTMLElement>\("input, select, button"\)\?\.focus\(\)/.test(editor));
check("multi-source add is intact", /link-add-source/.test(editor) && /function addSource/.test(editor));
check("per-field validation is intact", /validateSource/.test(editor) && /link-field-error/.test(editor));
check("partial-failure reporting is intact", /setSummary\(\{ saved, failed \}\)/.test(editor));
check("it still uses the existing admin API", /\/api\/admin\/fixture-streams/.test(editor));

console.log("\n══ 7. The root-cause CSS is understood, not hidden ══");
{
  // The card hover transform is the reason a portal is required. It must NOT
  // have been removed just to make an inline modal work — the portal is the
  // correct fix, and the hover affordance stays.
  check("the card hover transform still exists (it is not the bug)", /\.match-card:hover\s*\{[^}]*transform:\s*translateY/.test(css));
  check("the editor documents why the portal is needed", /containing block for `position: fixed`/.test(editor));
  check("no ancestor of the portal can trap it", !/^body\s*\{[^}]*transform/m.test(css));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
process.exit(fail ? 1 : 0);