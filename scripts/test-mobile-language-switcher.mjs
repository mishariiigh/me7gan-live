/**
 * Regression test for the mobile language switcher.
 *
 * Bug: on the mobile layout the "EN" button rendered as a blank white square.
 * Root cause: the `@media (max-width: 640px)` block hid the shared
 * `.header-action-label` class with `display: none`. The language switcher's
 * label is its ONLY visible content (the button carries no icon), so hiding it
 * left an empty bordered square. The menu toggle next to it was unaffected
 * because it renders a hamburger icon.
 *
 * These assertions read the real `platform.css`, so they fail if the label is
 * ever hidden again at mobile widths — or if the mobile tap target regresses.
 */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/app/platform.css", import.meta.url), "utf8");
const header = readFileSync(new URL("../src/components/site-header.tsx", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

/**
 * The header's mobile rules live in one of SEVERAL `@media (max-width: 640px)`
 * blocks in this stylesheet (there are six, for different page sections).
 * Picking the first match would read an unrelated block, so we collect them all
 * and select the one that actually styles the header actions.
 */
function headerMobileBlock() {
  const query = "@media (max-width: 640px)";
  const all = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(query, from);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) { all.push(css.slice(open + 1, i)); break; }
      }
    }
    from = at + query.length;
  }
  const block = all.find((b) => b.includes(".menu-toggle .header-action-label"));
  if (!block) throw new Error("no mobile block styles .menu-toggle .header-action-label");
  return block;
}

const mobile = headerMobileBlock();

console.log("\n══ assertions ══");
{
  // 1. The bare class must no longer be hidden wholesale at mobile widths.
  //    Anchored to a selector-list boundary so the compound
  //    `.menu-toggle .header-action-label { display: none }` — which IS intended —
  //    does not count as hiding the bare label.
  const hidesBareLabel = /(?:^|[{};\n])\s*\.header-action-label\s*(?:,[^{]*)?\{[^}]*display:\s*none/.test(mobile);
  check("mobile CSS does not hide the bare .header-action-label", !hidesBareLabel);

  // 2. The menu toggle's label (which has an icon beside it) is still dropped.
  const hidesMenuLabel = /\.menu-toggle\s+\.header-action-label\s*\{[^}]*display:\s*none/.test(mobile);
  check("mobile CSS still hides the menu-toggle label (it has an icon)", hidesMenuLabel);

  // 3. The language button keeps its visible text label in the markup.
  const hasLabel = /<span className="header-action-label">[^<]*<\/span>/.test(header);
  check("language switcher renders a .header-action-label text span", hasLabel);

  // 4. Mobile tap target meets the 44px guideline.
  const action = mobile.match(/\.header-action\s*\{([^}]*)\}/);
  check("mobile .header-action rule exists", Boolean(action));
  if (action) {
    const minH = action[1].match(/min-height:\s*(\d+)px/);
    const minW = action[1].match(/min-width:\s*(\d+)px/);
    check("mobile .header-action min-height >= 44px", minH && Number(minH[1]) >= 44, minH ? minH[1] : "missing");
    check("mobile .header-action min-width >= 44px", minW && Number(minW[1]) >= 44, minW ? minW[1] : "missing");
  }

  // 5. Contrast: the label colour is a mid/dark blue on the light header surface.
  const labelRule = css.match(/(?:^|\n)\.header-action\s*\{([^}]*)\}/);
  check(".header-action base rule exists", Boolean(labelRule));
  if (labelRule) {
    check("label uses a theme colour variable (not transparent/inherit)", /color:\s*var\(/.test(labelRule[1]));
    check("label is not made transparent", !/color:\s*transparent/.test(labelRule[1]));
    // Contrast guard: the label colour must not be a light/white value, which
    // would be invisible on the light header surface. The button's own
    // `background: transparent` is intentional (it shows the header behind it).
    check(
      "label colour is not a light/white value",
      !/color:\s*(#f|#e|white|rgba?\(\s*255)/i.test(labelRule[1]),
    );
  }
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
