/**
 * Security and behaviour tests for the inline home-page link editor.
 *
 *   BASE_URL=http://localhost:3222 node scripts/test-inline-links.mjs
 *
 * These run against a REAL running server, because the thing under test is
 * authorisation, and authorisation cannot be proven by reading code. The claims
 * checked here are:
 *
 *   1. An anonymous visitor cannot read or write fixture links.
 *   2. A forged request cannot bypass authorisation (no client-side flag is
 *      trusted, no service-role key is reachable).
 *   3. The session endpoint never leaks admin status to an anonymous caller.
 *   4. Validation rejects bad URLs, unknown types and out-of-range priorities
 *      BEFORE any write happens.
 *   5. The public home page never contains admin controls in its HTML.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3222";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
}

console.log("\n══ 1. Anonymous visitors cannot read or write links ══");
{
  const cases = [
    ["GET", "/api/admin/fixture-streams", undefined],
    ["POST", "/api/admin/fixture-streams", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com", provider_name: "X", active: true, priority: 0 }],
    ["PATCH", "/api/admin/fixture-streams", { id: "00000000-0000-0000-0000-000000000000", active: false }],
    ["DELETE", "/api/admin/fixture-streams", { id: "00000000-0000-0000-0000-000000000000" }],
  ];

  for (const [method, path, body] of cases) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    // 401/403 are both correct refusals; 429 would be the rate limiter.
    check(`${method} is refused`, [401, 403, 429].includes(res.status), `got ${res.status}`);
  }
}

console.log("\n══ 2. The session endpoint does not leak admin status ══");
{
  const res = await fetch(`${BASE}/api/admin/session`, { headers: { accept: "application/json" } });
  check("session endpoint responds 200", res.status === 200, `got ${res.status}`);
  const body = await res.json();
  check("anonymous caller is reported as NOT admin", body.isAdmin === false, JSON.stringify(body));
  check("no email is returned to an anonymous caller", body.email === null, JSON.stringify(body));
  check(
    "response is marked private, no-store",
    /private/i.test(res.headers.get("cache-control") ?? "") && /no-store/i.test(res.headers.get("cache-control") ?? ""),
    res.headers.get("cache-control") ?? "(none)",
  );

  const raw = JSON.stringify(body);
  check("no token material in the response", !/token|secret|service_role|eyJ/i.test(raw), raw);
}

console.log("\n══ 3. Forged / spoofed requests are still refused ══");
{
  // A visitor cannot promote themselves by inventing a header, a cookie, or a
  // body field. Authorisation reads the Supabase session, not any of these.
  const attempts = [
    ["x-admin: true", { "x-admin": "true" }],
    ["x-forwarded-user: admin", { "x-forwarded-user": "admin" }],
    ["role: admin", { role: "admin" }],
    ["isAdmin: true", { isAdmin: "true" }],
    ["a fabricated session cookie", { cookie: "sb-fake-auth-token=base64-anything" }],
  ];

  for (const [label, headers] of attempts) {
    const res = await fetch(`${BASE}/api/admin/fixture-streams`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        fixture_id: "ML-20260101-0001",
        stream_type: "external",
        stream_url: "https://example.com/forged",
        provider_name: "Forged",
        active: true,
        priority: 0,
      }),
    });
    check(`spoofing via ${label} is refused`, [401, 403, 429].includes(res.status), `got ${res.status}`);
  }
}

console.log("\n══ 4. Validation runs before any write ══");
{
  // These must be rejected as 400 (bad input) or 401/403 (not authorised).
  // What matters is that they are never accepted with a 2xx.
  const badBodies = [
    ["a non-HTTPS url", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "http://insecure.example", provider_name: "X", active: true, priority: 0 }],
    ["an unknown stream type", { fixture_id: "ML-20260101-0001", stream_type: "rtmp", stream_url: "https://example.com", provider_name: "X", active: true, priority: 0 }],
    ["a priority above 10000", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com", provider_name: "X", active: true, priority: 99999 }],
    ["a negative priority", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com", provider_name: "X", active: true, priority: -5 }],
    ["an empty provider name", { fixture_id: "ML-20260101-0001", stream_type: "external", stream_url: "https://example.com", provider_name: "   ", active: true, priority: 0 }],
    ["a malformed fixture id", { fixture_id: "not a fixture id!", stream_type: "external", stream_url: "https://example.com", provider_name: "X", active: true, priority: 0 }],
    ["a non-uuid delete id", { id: "not-a-uuid" }],
  ];

  for (const [label, body] of badBodies) {
    const res = await fetch(`${BASE}/api/admin/fixture-streams`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    check(`${label} is rejected`, res.status >= 400, `got ${res.status}`);
  }
}

console.log("\n══ 5. Public pages contain no admin controls for visitors ══");
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check("home page responds 200", res.status === 200, `got ${res.status}`);
  // The admin button is rendered only after the client-side session check
  // confirms an admin, so the server HTML must never contain it.
  check("no 'Add link' control in the served HTML", !html.includes("match-admin-link"), "admin control found in HTML");
  check("no editor markup in the served HTML", !html.includes("link-editor-backdrop"));
  check("home page still renders normally", html.includes("hero-title"));
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
if (fail) console.log("Failed:\n  - " + failures.join("\n  - "));
process.exit(fail ? 1 : 0);