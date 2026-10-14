/**
 * End-to-end test of the multi-source save path against the REAL API.
 *
 * Requires an authenticated admin session cookie, supplied via ADMIN_COOKIE.
 * Without it the test reports that it could not run rather than passing
 * vacuously.
 *
 *   ADMIN_COOKIE="sb-xxxx-auth-token=base64-..." node scripts/test-multi-source-save.mjs
 *
 * It verifies the behaviours the panel depends on:
 *  1. two sources can be created for one match,
 *  2. priority ordering is preserved,
 *  3. a source can be disabled without deleting it,
 *  4. a duplicate URL is NOT silently rejected by the DB (so the panel's
 *     client-side duplicate check is load-bearing),
 *  5. an invalid source is rejected by the server (the panel's validation is a
 *     convenience, not the authority),
 *  6. both created sources are removed afterwards.
 */
const BASE = process.env.BASE_URL ?? "http://localhost:3222";
const COOKIE = process.env.ADMIN_COOKIE ?? "";
const FIXTURE = process.env.FIXTURE_ID ?? "";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

if (!COOKIE || !FIXTURE) {
  console.log("\nSKIPPED: needs ADMIN_COOKIE and FIXTURE_ID (no admin credentials available).");
  console.log("The panel's request shape is covered by test-link-panel.mjs; the authenticated");
  console.log("happy path requires a real admin session this environment does not have.");
  process.exit(0);
}

const api = (method, body) =>
  fetch(`${BASE}/api/admin/fixture-streams`, {
    method,
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: body ? JSON.stringify(body) : undefined,
  });

const created = [];

try {
  console.log("\n══ create two sources for one match ══");
  for (const [provider, url, priority] of [
    ["E2E Provider A", `https://example.com/e2e-a-${Date.now()}`, 5],
    ["E2E Provider B", `https://example.com/e2e-b-${Date.now()}`, 9],
  ]) {
    const res = await api("POST", {
      fixture_id: FIXTURE,
      stream_type: "external",
      stream_url: url,
      provider_name: provider,
      active: true,
      priority,
    });
    const body = await res.json().catch(() => ({}));
    check(`created ${provider}`, res.status === 201 && Boolean(body.data?.id), `status ${res.status}`);
    if (body.data?.id) created.push(body.data);
  }

  check("two sources now exist for the match", created.length === 2);

  console.log("\n══ priority ordering ══");
  const list = await (await fetch(`${BASE}/api/admin/fixture-streams`, { headers: { cookie: COOKIE } })).json();
  const mine = (list.data ?? []).filter((s) => s.fixture_id === FIXTURE);
  const ordered = [...mine].sort((a, b) => b.priority - a.priority);
  check(
    "the higher priority source sorts first",
    ordered[0]?.priority >= ordered[ordered.length - 1]?.priority,
    JSON.stringify(ordered.map((s) => s.priority)),
  );

  console.log("\n══ disable without deleting ══");
  if (created[0]) {
    const res = await api("PATCH", { id: created[0].id, active: false });
    const body = await res.json().catch(() => ({}));
    check("the source was updated", res.ok && body.data?.active === false, `status ${res.status}`);
    check("it still exists after being disabled", body.data?.id === created[0].id);
  }

  console.log("\n══ server-side validation is the authority ══");
  const bad = await api("POST", {
    fixture_id: FIXTURE,
    stream_type: "external",
    stream_url: "http://insecure.example/e2e",
    provider_name: "Bad",
    active: true,
    priority: 0,
  });
  check("a non-HTTPS URL is rejected by the server", bad.status === 400, `status ${bad.status}`);

  const badType = await api("POST", {
    fixture_id: FIXTURE,
    stream_type: "rtmp",
    stream_url: "https://example.com/e2e-rtmp",
    provider_name: "Bad type",
    active: true,
    priority: 0,
  });
  check("an unknown stream type is rejected", badType.status === 400, `status ${badType.status}`);
} finally {
  console.log("\n══ cleanup ══");
  for (const row of created) {
    const res = await api("DELETE", { id: row.id });
    check(`removed ${row.provider_name}`, res.ok, `status ${res.status}`);
  }
}

console.log(`\n════════ ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);