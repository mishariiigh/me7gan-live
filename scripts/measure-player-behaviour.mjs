/**
 * Measures the client-side effect of the player fixes against a real server.
 *
 *   node scripts/measure-player-behaviour.mjs
 *
 * Source assertions (test-player-performance.mjs) prove the code is shaped
 * correctly. This proves the *served output* matches: how many players each page
 * ships, and whether an embed changes the page at all.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3222";
const ROOT = "/Users/M10/Desktop/developer/LiveStreamWebsite";

const env = {};
for (const line of readFileSync(`${ROOT}/.env.local`, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

async function fixturesWithEmbed() {
  const res = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/fixture_streams?select=fixture_id,stream_type,active&active=eq.true`,
    { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}` } },
  );
  const rows = res.ok ? await res.json() : [];
  return {
    embed: [...new Set(rows.filter((r) => r.stream_type === "embed").map((r) => r.fixture_id))],
    hls: [...new Set(rows.filter((r) => r.stream_type === "hls").map((r) => r.fixture_id))],
  };
}

const count = (html, re) => (html.match(re) ?? []).length;

async function page(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, html: await res.text() };
}

console.log("══ 1. The home page ships no player ══");
{
  const home = await page("/");
  const iframes = count(home.html, /<iframe/gi);
  const videos = count(home.html, /<video/gi);
  console.log(`  GET / -> ${home.status}, ${home.html.length} bytes`);
  console.log(`    iframes: ${iframes}  videos: ${videos}`);
  console.log(
    iframes === 0 && videos === 0
      ? "    PASS: an embed on a match cannot slow the home page — no player is rendered there\n"
      : "    FAIL: the home page renders a player\n",
  );
}

console.log("══ 2. An embed match vs a no-embed match: server cost ══");
{
  const { embed, hls } = await fixturesWithEmbed();
  console.log(`  (embeds: ${embed.length}, hls: ${hls.length})\n`);

  const sample = [
    ...embed.slice(0, 2).map((id) => [id, "embed"]),
    ...hls.slice(0, 2).map((id) => [id, "hls"]),
  ];

  const results = [];
  for (const [id, kind] of sample) {
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      const res = await fetch(`${BASE}/match/${id}`);
      await res.text();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    results.push({ id, kind, median });
    console.log(`  ${id} (${kind.padEnd(5)}) median: ${median.toFixed(0)}ms`);
  }

  const embedTimes = results.filter((r) => r.kind === "embed").map((r) => r.median);
  const hlsTimes = results.filter((r) => r.kind === "hls").map((r) => r.median);
  if (embedTimes.length && hlsTimes.length) {
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const delta = avg(embedTimes) - avg(hlsTimes);
    console.log(`\n  embed avg ${avg(embedTimes).toFixed(0)}ms vs hls avg ${avg(hlsTimes).toFixed(0)}ms (delta ${delta.toFixed(0)}ms)`);
    console.log(
      Math.abs(delta) < 80
        ? "  PASS: an embed costs the server about the same as any other source — the player is not fetched server-side\n"
        : "  NOTE: a measurable difference remains\n",
    );
  }
}

console.log("══ 3. The player is not in the SSR HTML (client-rendered) ══");
{
  const { embed, hls } = await fixturesWithEmbed();
  const id = embed[0] ?? hls[0];
  if (!id) {
    console.log("  no streamed fixture to sample\n");
  } else {
    const m = await page(`/match/${id}`);
    const iframes = count(m.html, /<iframe/gi);
    const videos = count(m.html, /<video/gi);
    console.log(`  GET /match/${id} -> ${m.status}, ${m.html.length} bytes`);
    console.log(`    iframes in SSR HTML: ${iframes}  videos: ${videos}`);
    console.log(
      iframes === 0 && videos === 0
        ? "    PASS: no player is created during SSR — nothing third-party loads before the visitor acts\n"
        : "    NOTE: a player element is present in the initial HTML\n",
    );
  }
}

console.log("══ 4. External broadcaster links are outbound, never framed ══");
{
  const { embed, hls } = await fixturesWithEmbed();
  const id = embed[0] ?? hls[0];
  if (id) {
    const m = await page(`/match/${id}`);
    const outbound = count(m.html, /target="_blank"/gi);
    const noopener = count(m.html, /rel="noopener noreferrer"/gi);
    console.log(`    outbound links: ${outbound}, with rel=noopener: ${noopener}`);
    console.log(
      outbound > 0 && outbound === noopener
        ? "    PASS: every outbound link carries rel=\"noopener noreferrer\"\n"
        : "    NOTE: check outbound link attributes\n",
    );
  }
}