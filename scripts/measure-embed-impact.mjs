/**
 * Measures what an embed actually does to the site, using a real server.
 *
 *   node scripts/measure-embed-impact.mjs
 *
 * Answers, with evidence rather than assumption:
 *  1. Does the HOME page render any iframe/video player at all?
 *  2. Does the match page with an embed load third-party scripts?
 *  3. Is the match page cached or re-rendered per request?
 *  4. How many <iframe>/<video> elements does each page emit?
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3222";
const ROOT = "/Users/M10/Desktop/developer/LiveStreamWebsite";

const env = {};
for (const line of readFileSync(`${ROOT}/.env.local`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Reads published fixtures straight from Supabase so we can target real ones. */
async function listFixtures() {
  const res = await fetch(`${url}/rest/v1/matches?select=fixture_id&published=eq.true&limit=50`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return [];
  return (await res.json()).map((row) => row.fixture_id);
}

const count = (html, re) => (html.match(re) ?? []).length;

function report(label, html) {
  const iframes = count(html, /<iframe/gi);
  const videos = count(html, /<video/gi);
  const scripts = count(html, /<script[^>]+src=/gi);
  const thirdParty = count(html, /<script[^>]+src="https?:\/\/(?!localhost)/gi);
  console.log(`  ${label}`);
  console.log(`    iframes       : ${iframes}`);
  console.log(`    <video>       : ${videos}`);
  console.log(`    script tags   : ${scripts} (third-party: ${thirdParty})`);
  return { iframes, videos, scripts, thirdParty };
}

async function timed(path) {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const html = await res.text();
  return { ms: performance.now() - start, html, status: res.status };
}

console.log("══ 1. Home page: does it render a player? ══");
{
  const home = await timed("/");
  const r = report(`GET / (${home.status}, ${home.ms.toFixed(0)}ms, ${home.html.length} bytes)`, home.html);
  console.log(
    r.iframes === 0 && r.videos === 0
      ? "    -> no player on the home page: an embed cannot slow it down directly\n"
      : "    -> WARNING: the home page renders a player\n",
  );
}

console.log("══ 2. Match pages: player presence and cost ══");
{
  const fixtures = await listFixtures();
  console.log(`  (found ${fixtures.length} published fixtures)\n`);
  if (fixtures.length === 0) {
    console.log("  no fixtures to sample");
  } else {
    for (const id of fixtures.slice(0, 3)) {
      const page = await timed(`/match/${id}`);
      report(`GET /match/${id} (${page.status}, ${page.ms.toFixed(0)}ms, ${page.html.length} bytes)`, page.html);
      console.log("");
    }
  }
}

console.log("══ 3. Is the match page cached or re-rendered per request? ══");
{
  const fixtures = await listFixtures();
  if (fixtures[0]) {
    const times = [];
    for (let i = 0; i < 5; i += 1) times.push((await timed(`/match/${fixtures[0]}`)).ms);
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`  median of 5: ${median.toFixed(0)}ms  (${times.map((t) => t.toFixed(0)).join(", ")})`);
    console.log(
      median < 60
        ? "  -> served from cache\n"
        : "  -> rendered per request (force-dynamic): every visit re-queries Supabase\n",
    );
  }
}

console.log("══ 4. Does the match page load third-party scripts? ══");
{
  const fixtures = await listFixtures();
  if (fixtures[0]) {
    const page = await timed(`/match/${fixtures[0]}`);
    const srcs = [...page.html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
    const external = srcs.filter((s) => !s.startsWith("/"));
    console.log(`  script sources: ${srcs.length}`);
    external.forEach((s) => console.log(`    external: ${s}`));
    console.log(
      external.length === 0
        ? "  -> no third-party scripts are loaded by the page itself\n"
        : "  -> the page loads third-party scripts\n",
    );
  }
}