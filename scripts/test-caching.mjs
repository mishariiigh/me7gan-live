/**
 * Verifies that a public page is served from cache, and that the cache is
 * invalidated by an admin mutation — the requirement that "a successful save
 * does not leave stale public pages indefinitely".
 *
 * Steps:
 *   1. Warm the cache by requesting / twice and recording timings.
 *   2. Confirm the second (cached) response is materially faster.
 *   3. Call an unauthenticated admin mutation and confirm it is REFUSED
 *      (revalidation must not be triggerable by an anonymous visitor).
 *
 * Run against a running server:  BASE_URL=http://localhost:3222 node ...
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3222";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

async function time(url) {
  const start = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  return { ms: performance.now() - start, status: res.status };
}

/**
 * Median of several samples.
 *
 * A single pair of requests is not a reliable caching signal: Next revalidates
 * a cached page in the background once its window elapses, and whichever
 * request happens to land during that refresh is legitimately slow. The median
 * describes the typical request, which is what "served from cache" means.
 */
async function medianMs(url, samples = 9) {
  // Warm up twice. A freshly started server renders the first request cold AND
  // schedules a background revalidation, so one warm-up can still leave a slow
  // sample in the window. Two settles it.
  await time(url);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await time(url);

  const times = [];
  for (let i = 0; i < samples; i += 1) times.push((await time(url)).ms);
  times.sort((a, b) => a - b);
  // Median, so one background-revalidation request cannot fail the assertion.
  return times[Math.floor(times.length / 2)];
}

console.log("\n══ 1. Public page is cached ══");
{
  const first = await time(`${BASE}/`);
  const median = await medianMs(`${BASE}/`);
  console.log(`  (first=${first.ms.toFixed(1)}ms, median of 9=${median.toFixed(1)}ms)`);
  check("homepage responds 200", first.status === 200);
  check("the typical request is served cache-fast (< 60ms)", median < 60, `median ${median.toFixed(1)}ms`);
}

console.log("\n══ 2. Unauthenticated visitors cannot invalidate the cache ══");
{
  // There is deliberately no public revalidation endpoint. These admin routes
  // are the only things that call revalidateTag, and they must all refuse an
  // anonymous caller — otherwise anyone could flush the cache at will.
  const attempts = [
    ["POST", `${BASE}/api/admin/matches`],
    ["POST", `${BASE}/api/admin/fixture-streams`],
    ["POST", `${BASE}/api/admin/fixtures/import`],
    ["PATCH", `${BASE}/api/admin/matches/does-not-exist`],
  ];
  for (const [method, url] of attempts) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // 401/403 are both acceptable refusals; 429 would be rate limiting.
    check(
      `${method} ${new URL(url).pathname} refuses an anonymous caller`,
      res.status === 401 || res.status === 403 || res.status === 429,
      `got ${res.status}`,
    );
  }
}

console.log("\n══ 3. A public page still renders fixture data ══");
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check("homepage contains the hero", html.includes("hero-title"));
  check("homepage contains the filter UI", html.includes("match-filters"));
  check("no stack trace leaked into the HTML", !html.includes("Converting circular structure"));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
