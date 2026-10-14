/**
 * Regression tests for the embed/player performance fixes.
 *
 *   node scripts/test-player-performance.mjs
 *
 * Guards the two defects that made the site slow once an embed was added:
 *
 *  1. The player was destroyed and rebuilt on EVERY parent re-render, because
 *     `onFatalError` was an effect dependency with an unstable identity. Each
 *     rebuild aborted in-flight segment requests and re-fetched the manifest.
 *  2. The embed iframe was created immediately on page load, starting a whole
 *     third-party page load (its scripts, beacons and manifests) even when the
 *     visitor only wanted to read the fixture.
 *
 * ## Why source is comment-stripped before asserting
 *
 * These checks read source text, and the files are heavily commented — several
 * of them explain *why* we do NOT do something ("we never try to bypass
 * `X-Frame-Options`"). A naive regex then matches the explanation and reports a
 * false failure. Stripping comments first means every assertion tests executable
 * code, so a passing test cannot be satisfied by prose.
 */
import { readFileSync } from "node:fs";

const ROOT = "/Users/M10/Desktop/developer/LiveStreamWebsite";

/**
 * Removes comments from a source file, leaving code and string literals intact.
 *
 * Only comments are stripped. String literals are deliberately KEPT: JSX
 * attribute values (`className="player-placeholder"`, `target="_blank"`), CSS
 * class names and Arabic UI copy are all strings, and they are precisely what
 * several assertions need to verify. Stripping them made those checks
 * meaningless.
 *
 * The reason to strip anything at all is that these files explain *why* we do
 * not do certain things ("we never try to bypass `X-Frame-Options`"), and a
 * naive regex would match that explanation and report a false failure.
 */
function codeOnly(source) {
  return (
    source
      // Block comments.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Line comments, but not the `//` inside a URL like https://
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
  );
}

const read = (rel) => readFileSync(`${ROOT}/${rel}`, "utf8");

const hls = codeOnly(read("src/components/hls-player.tsx"));
const embed = codeOnly(read("src/components/embed-player.tsx"));
const player = codeOnly(read("src/components/fixture-stream-player.tsx"));
const service = codeOnly(read("src/lib/streaming/fixture-service.ts"));
const links = codeOnly(read("src/lib/streaming/official-watch-links.ts"));
const matchPage = codeOnly(read("src/app/match/[fixtureId]/page.tsx"));
const card = codeOnly(read("src/components/match-card.tsx"));

/** Raw sources, for assertions about documentation. */
const rawEmbed = read("src/components/embed-player.tsx");
const rawMatchPage = read("src/app/match/[fixtureId]/page.tsx");

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

console.log("\n══ 1. The player is NOT rebuilt on unrelated re-renders ══");
{
  // The HLS effect must not depend on the error callback.
  const depsLine = hls.match(/\}, \[([^\]]*)\]\);/g)?.find((d) => d.includes("src") && d.includes("retry"));
  check("the HLS effect depends on [src, retry] only", depsLine === "}, [src, retry]);", depsLine ?? "(not found)");
  check("onFatalError is NOT an effect dependency", !/\[onFatalError, src, retry\]/.test(hls));
  check("the error callback is read through a ref", /const fatalErrorRef = useRef\(onFatalError\)/.test(hls));
  check("the ref is updated in an effect, not during render", /useEffect\(\(\) => \{\s*fatalErrorRef\.current = onFatalError;\s*\}, \[onFatalError\]\)/.test(hls));
  check("fatal errors are raised via the ref", /fatalErrorRef\.current\?\.\(\)/.test(hls));

  // The parent's callback must also be stable.
  check("the parent exposes a stable fallback handler", /const moveToFallback = useCallback\(\(\) => \{[\s\S]{0,400}\}, \[\]\)/.test(player));
  check("it reads current values from a ref", /const latest = useRef\(\{ activeIndex: 0, sources: \[\] as AuthorizedFixtureStream\[\] \}\)/.test(player));
  check("the ref is written in an effect, not during render", /useEffect\(\(\) => \{\s*latest\.current = \{ activeIndex, sources \};\s*\}\)/.test(player));
}

console.log("\n══ 2. The iframe is not created until the visitor asks ══");
check("the embed is gated behind a click", /const \[started, setStarted\] = useState\(false\)/.test(embed));
check("a placeholder is shown first", /if \(!started\) \{/.test(embed) && /player-placeholder/.test(embed));
check("the placeholder is a real button", /<button[\s\S]{0,200}className="player-placeholder"/.test(embed));
check("the placeholder has an accessible label", /aria-label=\{isArabic \? "تشغيل البث داخل الموقع"/.test(embed));
check("the iframe renders only after the click", (() => {
  // Compare against the JSX guard, not the one inside the timer effect: the
  // effect's `if (!started) return;` appears earlier in the file and is a
  // different statement. The JSX guard is the one that decides whether the
  // <iframe> element is created at all.
  const jsxGuard = embed.indexOf("if (!started) {");
  const iframeElement = embed.indexOf("<iframe");
  return jsxGuard > 0 && iframeElement > 0 && jsxGuard < iframeElement;
})());
check("the load-detection timer only runs once started", /if \(!started\) return;/.test(embed));
check("it says the player loads on click", /يُحمّل المشغل عند الضغط فقط/.test(embed));
check("the provider name is shown when known", /providerName/.test(embed) && /providerName=\{activeSource\.provider_name\}/.test(player));

console.log("\n══ 3. No autoplay is introduced ══");
check("no autoplay attribute on the video", !/autoPlay/.test(hls));
check("no autoplay attribute on the iframe", !/autoPlay/.test(embed));
check("no autoplay query parameter is appended", !/[?&]autoplay=/i.test(embed) && !/[?&]autoplay=/i.test(player));
check("the video keeps native controls", /controls/.test(hls) && /playsInline/.test(hls));

console.log("\n══ 4. Cleanup is correct ══");
check("the HLS instance is destroyed on unmount", /hls\.destroy\(\)/.test(hls));
check("the instance ref is cleared", /hlsRef\.current = null/.test(hls));
check("the out-of-band stall timer is tracked and cleared", /let stallTimer: number \| null = null/.test(hls) && /if \(stallTimer !== null\) window\.clearTimeout\(stallTimer\)/.test(hls));
check("the native path removes its listener and releases the source", /video\.removeEventListener\("error", handleNativeError\)/.test(hls) && /video\.removeAttribute\("src"\)/.test(hls));
check("the unsupported-browser timer is cleared", /return \(\) => window\.clearTimeout\(unsupported\)/.test(hls));
check("the embed timer is cleared on unmount", /cancelled = true;\s*window\.clearTimeout\(timer\)/.test(embed));

console.log("\n══ 5. Caching: what is actually cached, precisely ══");
check("authorized streams are cached", /unstable_cache/.test(service));
check("official watch links are cached", /unstable_cache/.test(links));
check("both use the fixture tag so admin edits invalidate them", /FIXTURE_CACHE_TAG/.test(service) && /FIXTURE_CACHE_TAG/.test(links));
check("both use the anon client (visitor-independent public data)", /createPublicSupabaseClient/.test(service) && /createPublicSupabaseClient/.test(links));
check("the match page declares no dynamic override", !/export const dynamic/.test(matchPage));

// The match ROW is deliberately NOT cached. Asserting this keeps the comment in
// the page honest: it would be easy to assume "the whole match page is cached"
// and be wrong. Verified against the loader, not the comment.
{
  const matchesLib = codeOnly(read("src/lib/sports/matches.ts"));
  const loader = matchesLib.slice(matchesLib.indexOf("export async function getPublicMatchByFixtureId"));
  check(
    "the match row loader is NOT cached (still uses the session-aware client)",
    /createSupabaseServerClient\(\)/.test(loader) && !/unstable_cache/.test(loader.slice(0, 400)),
  );
  check(
    "the page comment states the match row is not cached",
    /the match row itself\s+-> NOT cached/.test(rawMatchPage),
  );
}

// Cached public data must never be user-specific. The anon client cannot read
// anything RLS hides, so sharing its result across visitors is correct.
check(
  "cached loaders read only public, anonymous data",
  /createPublicSupabaseClient/.test(service) && !/getServerUser|auth\.getUser/.test(service),
);
check(
  "no cached loader reads the request cookies",
  !/cookies\(\)/.test(service) && !/cookies\(\)/.test(links),
);

console.log("\n══ 6. The home page still renders no player ══");
check("the match card contains no iframe", !/<iframe/.test(card));
check("the match card contains no video element", !/<video/.test(card));
check("the match card imports no player", !/HlsPlayer|EmbedPlayer/.test(card));
check("the card offers a link to the match page instead", /href=\{`\/match\/\$\{match\.fixtureId\}`\}/.test(card));

console.log("\n══ 7. Broadcaster links stay outbound, priorities preserved ══");
check("external links open in a new tab", /target="_blank"/.test(player) && /rel="noopener noreferrer"/.test(player));
check("external sources are never routed to a player", /source\.stream_type !== "external"/.test(player));
check("a blocked embed offers an outbound fallback", /target="_blank"/.test(embed));
check("a blocked embed offers another source", /onFatalError\?\.\(\)/.test(embed));
check("we do not try to bypass framing restrictions", (() => {
  // Asserted against CODE only (comments and strings are stripped). The file
  // legitimately *mentions* X-Frame-Options to explain that we do not bypass
  // it — matching raw source would fail on that explanation, which is exactly
  // the false positive this comment-stripping avoids.
  const touchesHeaders = /X-Frame-Options|frame-ancestors/i.test(embed);
  const proxiesContent = /fetch\(|XMLHttpRequest|proxy/i.test(embed);
  return !touchesHeaders && !proxiesContent;
})(), `touchesHeaders=${/X-Frame-Options|frame-ancestors/i.test(embed)} proxies=${/fetch\(|proxy/i.test(embed)}`);
// And the intent is still documented, in the raw source. The phrase is wrapped
// across block-comment lines at an arbitrary point, so the match tolerates
// whitespace — including the newline and the leading `*` JSDoc adds — between
// every word rather than assuming where the break falls.
check(
  "the no-bypass policy is documented",
  /do\s*\*?\s*not\s*\*?\s*attempt\s*\*?\s*to\s*\*?\s*detect,\s*\*?\s*proxy,\s*\*?\s*scrape\s*\*?\s*or\s*\*?\s*bypass/.test(rawEmbed),
);
check("fallback ordering is preserved", /index \+ 1 < list\.length/.test(player) && /list\[index \+ 1\]\.id/.test(player));

console.log("\n══ 8. The Add Link modal is untouched ══");
{
  const editor = readFileSync(`${ROOT}/src/components/fixture-link-editor.tsx`, "utf8");
  check("it still portals to document.body", /createPortal/.test(editor));
  check("it still has the X and Close buttons", /aria-label=\{isArabic \? "إغلاق المحرر"/.test(editor) && /link-close-action/.test(editor));
  check("multi-source editing intact", /link-add-source/.test(editor) && /validateSource/.test(editor));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
process.exit(fail ? 1 : 0);