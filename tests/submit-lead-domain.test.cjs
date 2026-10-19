// Run the deployed submission handler with fixture-only Cloudflare and database
// adapters. Any unexpected external request fails instead of sending mail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");

const BUSINESS = "44444444-4444-4444-8444-444444444444";
const source = fs.readFileSync(path.join(__dirname, "../supabase/functions/submit-lead/index.ts"), "utf8")
  .replace(/^import \{ withSupabase \} from "npm:@supabase\/server@1";\r?\n/, "")
  .replace("export default {", "module.exports = {");
const javascript = stripTypeScriptTypes(source);

function fixture({ hostname = "gatebrook.work", verified = true, active = true, service = true } = {}) {
  const calls = { verification: 0, tables: [], inserts: [], rpcs: [] };
  const db = {
    from(table) {
      calls.tables.push(table);
      return {
        select() { return this; },
        eq() { return this; },
        insert(row) { calls.inserts.push({ table, row }); return this; },
        async maybeSingle() {
          if (table === "businesses") return { data: active ? { id: BUSINESS, name: "Fixture service", owner_email: null, active: true } : null, error: null };
          if (table === "business_services") return { data: service ? { id: "fixture-service" } : null, error: null };
          if (table === "business_request_forms") return { data: null, error: null };
          throw new Error("Unexpected fixture lookup: " + table);
        },
        async single() { return { data: { id: "fixture-row" }, error: null }; },
      };
    },
  };
  db.rpc = async (name, args) => {
    calls.rpcs.push({ name, args });
    if (name === "gatebrook_validate_request_fields") return { data: true, error: null };
    if (name === "gatebrook_receive_request_custom") return { data: { disposition: "accepted", lead_id: "55555555-5555-4555-8555-555555555555" }, error: null };
    throw new Error("Unexpected RPC: " + name);
  };
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, Request, Response, Headers,
    Deno: { env: { get: name => name === "TURNSTILE_SECRET_KEY" ? "fixture-secret" : undefined } },
    withSupabase: (options, handler) => {
      assert.equal(options.auth, "none");
      return req => handler(req, { supabaseAdmin: db });
    },
    fetch: async (url) => {
      assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify", "no email or other external service may be called");
      calls.verification++;
      return Response.json({ success: verified, hostname });
    },
    console: { error() {}, warn() {} },
  }, { filename: "submit-lead/index.ts" });
  return {
    calls,
    async submit(overrides = {}) {
      const response = await module.exports.fetch(new Request("https://fixture.supabase.co/functions/v1/submit-lead", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnstile_token: "fixture-token", business_id: BUSINESS, customer_name: "Fixture Customer", phone: "555-0100", service: "Repairs", ...overrides }),
      }));
      return { response, json: await response.json() };
    },
  };
}

test("verified custom-domain and legacy hostname submissions reach guarded lead storage", async () => {
  for (const hostname of ["gatebrook.work", "flowos-web.github.io"]) {
    const f = fixture({ hostname });
    const { response, json } = await f.submit({ custom_answers: { urgency: "Emergency" } });
    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(f.calls.inserts.length, 0, "lead creation must happen atomically inside the protected intake RPC");
    assert.deepEqual(f.calls.rpcs.map(call => call.name), ["gatebrook_validate_request_fields", "gatebrook_receive_request_custom"]);
    assert.equal(f.calls.rpcs[1].args.p_business_id, BUSINESS);
    assert.deepEqual(f.calls.rpcs[1].args.p_answers, { urgency: "Emergency" });
  }
});

test("verified tokens for every unapproved hostname are rejected before database access", async () => {
  for (const hostname of [undefined, "", "attacker.example", "gatebrook.work.attacker.example", "sub.gatebrook.work", "gatebrook.work:443", "https://gatebrook.work", "flowos-web.github.io.attacker.example"]) {
    const f = fixture({ hostname: hostname === undefined ? null : hostname });
    const { response } = await f.submit();
    assert.equal(response.status, 403);
    assert.deepEqual(f.calls.tables, []);
    assert.deepEqual(f.calls.inserts, []);
  }
});

test("a trusted hostname never bypasses failed or missing Turnstile verification", async () => {
  const failed = fixture({ verified: false });
  assert.equal((await failed.submit()).response.status, 403);
  assert.deepEqual(failed.calls.tables, []);
  const missing = fixture();
  assert.equal((await missing.submit({ turnstile_token: "" })).response.status, 400);
  assert.equal(missing.calls.verification, 0);
  assert.deepEqual(missing.calls.tables, []);
});

test("trusted hostname still rejects inactive businesses and unavailable tenant services", async () => {
  for (const options of [{ active: false }, { service: false }]) {
    const f = fixture(options);
    assert.equal((await f.submit()).response.status, options.active === false ? 404 : 400);
    assert.deepEqual(f.calls.inserts, []);
  }
});

