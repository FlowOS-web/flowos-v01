import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_ORIGIN, PUBLIC_SITE_URL, createHandler, validatePayload, type AdminClient, type ProvisionRecord } from "./handler.ts";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const BUSINESS = "44444444-4444-4444-8444-444444444444";
const REQUEST = "55555555-5555-4555-8555-555555555555";
const EMAIL = "owner@example.com";
const HASH = "test-invite-hash-never-log";
const jwt = (claims = {}) => `header.${Buffer.from(JSON.stringify({ sub: ACTOR, role: "authenticated", session_id: SESSION, ...claims })).toString("base64url")}.signature`;
const input = (overrides = {}) => ({
  action: "provision", request_id: REQUEST,
  business: { name: " New Service Co ", slug: "new-service", primary_color: "#6FA7FF" },
  owner_email: " OWNER@example.com ", services: [" Repairs ", "Installations"], ...overrides,
});
const canonical = () => validatePayload(input());
const record = (overrides = {}): ProvisionRecord => ({
  business_id: BUSINESS, slug: "new-service", owner_email: EMAIL,
  owner_user_id: OWNER, owner_existing: false, owner_setup_required: true, payload: canonical(), ...overrides,
});
const enrollment = (overrides = {}) => ({
  business_id: BUSINESS, name: "New Service Co", slug: "new-service", industry: null,
  active: true, created_at: "2026-10-13T18:00:00.000Z", owner_email: EMAIL,
  owners: [{ user_id: OWNER, email: EMAIL, confirmed: false, has_password: false }],
  service_count: 2, lead_count: 1, request_id: REQUEST, setup_available: true,
  owner_setup_required: true, ...overrides,
});
const businessList = () => ({ businesses: [enrollment()], total: 1, counts: { active: 1, inactive: 0, total: 1 } });
const details = (overrides = {}) => ({
  business: enrollment(),
  profile: { business_id: BUSINESS, slug: "new-service", display_name: "New Service Co", industry: null,
    tagline: null, active: true, logo_url: null, primary_color: "#6fa7ff", contact_phone: null, website_url: null },
  services: [{ id: "66666666-6666-4666-8666-666666666666", business_id: BUSINESS, name: "Repairs", active: true, sort_order: 0 }],
  leads: [{ id: "77777777-7777-4777-8777-777777777777", business_id: BUSINESS, created_at: "2026-10-13T18:01:00.000Z",
    customer_name: "Test Customer", phone: "555-0100", email: "customer@example.com", vehicle: null,
    vehicle_type: null, service: "Repairs", service_location: null, preferred_date: null,
    notes: "Please call", status: "New", source: "request", estimated_value: null, booked_revenue: null }],
  total_leads: 1, ...overrides,
});
type MockOptions = {
  user?: unknown; authError?: unknown; authorized?: boolean; existing?: ProvisionRecord | null;
  owner?: { id: string; email: string; confirmed: boolean; has_password?: boolean } | null;
  generateError?: unknown; generateData?: unknown; provisionError?: unknown; provisionData?: ProvisionRecord;
  ownerAfterGenerateFailure?: { id: string; email: string; confirmed: boolean; has_password?: boolean } | null;
  businessesData?: unknown; businessDetailsData?: unknown; consoleError?: unknown;
  setupAllowed?: boolean; setupAllowedError?: unknown;
};
function mock(options: MockOptions = {}) {
  const calls: { name: string; params?: unknown }[] = [];
  let generated = false;
  let owner = options.owner ? { has_password: options.owner.confirmed, ...options.owner } : null;
  const client = {
    auth: {
      getUser: async (token: string) => {
        calls.push({ name: "getUser", params: token });
        return { data: { user: options.user === undefined ? { id: ACTOR, email: "admin@example.com" } : options.user }, error: options.authError ?? null };
      },
      admin: {
        generateLink: async (params: { type: string }) => {
          calls.push({ name: "generateLink", params });
          generated = true;
          if (options.generateError) return { data: null, error: options.generateError };
          owner ??= { id: OWNER, email: EMAIL, confirmed: false, has_password: false };
          return { data: options.generateData ?? { user: { id: OWNER, email: EMAIL }, properties: { hashed_token: HASH, verification_type: params.type } }, error: null };
        },
      },
    },
    rpc: async (name: string, params: unknown) => {
      calls.push({ name, params });
      if (name === "flowos_admin_authorize") return { data: options.authorized ?? true, error: null };
      if (name === "flowos_onboarding_setup_allowed") return { data: options.setupAllowed ?? true, error: options.setupAllowedError ?? null };
      if (name === "flowos_admin_businesses") return { data: options.businessesData === undefined ? businessList() : options.businessesData, error: options.consoleError ?? null };
      if (name === "flowos_admin_business_details") return { data: options.businessDetailsData === undefined ? details() : options.businessDetailsData, error: options.consoleError ?? null };
      if (name === "flowos_onboarding_get") return { data: options.existing ?? null, error: null };
      if (name === "flowos_onboarding_owner") {
        const fallback = options.ownerAfterGenerateFailure ? { has_password: options.ownerAfterGenerateFailure.confirmed, ...options.ownerAfterGenerateFailure } : owner;
        return { data: generated && options.generateError ? fallback : owner, error: null };
      }
      if (name === "flowos_onboarding_provision") return { data: options.provisionData ?? record({ owner_existing: !!options.owner }), error: options.provisionError ?? null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  } as unknown as AdminClient;
  return { handler: createHandler({ client }), calls };
}
function request(body: unknown = input(), opts: { token?: string | null; origin?: string | null; method?: string; contentType?: string } = {}) {
  const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? jwt()}`;
  if (opts.origin !== null) headers.origin = opts.origin ?? PUBLIC_SITE_URL;
  return new Request("https://example.supabase.co/functions/v1/flowos-admin-onboarding", {
    method: opts.method ?? "POST", headers, body: ["OPTIONS", "GET"].includes(opts.method ?? "") ? undefined : JSON.stringify(body),
  });
}
async function run(options: MockOptions = {}, body: unknown = input(), reqOpts = {}) {
  const fixture = mock(options);
  const response = await fixture.handler(request(body, reqOpts));
  const json = response.status === 204 ? null : await response.json();
  return { ...fixture, response, json };
}
const mutations = (calls: { name: string }[]) => calls.filter(({ name }) => ["generateLink", "flowos_onboarding_provision"].includes(name));

test("missing authentication never reads admin data or creates an account", async () => {
  const { response, calls } = await run({}, input(), { token: null });
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});
test("expired or invalid token fails getUser before claims and RPC authorization", async () => {
  const { response, calls } = await run({ authError: { message: "invalid token" } });
  assert.equal(response.status, 401);
  assert.deepEqual(calls.map(({ name }) => name), ["getUser"]);
});
test("anonymous Supabase users cannot provision", async () => {
  const { response, calls } = await run({ user: { id: ACTOR, is_anonymous: true } });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
});
test("user metadata cannot make a business owner a platform administrator", async () => {
  const { response, calls } = await run({ authorized: false, user: { id: ACTOR, user_metadata: { role: "admin", platform_admin: true } } });
  assert.equal(response.status, 403);
  assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize"]);
});
test("a revoked session is denied even when getUser accepts the access token", async () => {
  const { response, calls } = await run({ authorized: false });
  assert.equal(response.status, 403);
  assert.deepEqual(calls[1].params, { p_actor: ACTOR, p_session: SESSION });
  assert.equal(mutations(calls).length, 0);
});
test("missing, wrong-role, or mismatched-sub JWT sessions fail closed", async () => {
  for (const claims of [{ session_id: undefined }, { role: "service_role" }, { sub: OWNER }]) {
    const { response, calls } = await run({}, input(), { token: jwt(claims) });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 1);
  }
});
test("unapproved origins and preflights are rejected without authentication calls", async () => {
  for (const origin of ["https://attacker.example", "http://gatebrook.work", "https://gatebrook.work:444", "https://gatebrook.work.attacker.example", "https://sub.gatebrook.work", "https://flowos-web.github.io.attacker.example", "null"]) {
    for (const method of ["POST", "OPTIONS"]) {
      const { response, calls } = await run({}, input(), { origin, method });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(calls, []);
    }
  }
});
test("approved preflight is allowed and response caching is disabled", async () => {
  for (const origin of [PUBLIC_SITE_URL, LEGACY_ORIGIN]) {
    const { response, calls } = await run({}, input(), { origin, method: "OPTIONS", token: null });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Origin");
    assert.deepEqual(calls, []);
  }
});

test("both site origins still require a verified administrator and emit canonical root links", async () => {
  for (const origin of [PUBLIC_SITE_URL, LEGACY_ORIGIN]) {
    const denied = await run({ authorized: false }, input(), { origin });
    assert.equal(denied.response.status, 403);
    assert.equal(mutations(denied.calls).length, 0);
    const { response, json } = await run({}, input(), { origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(json.request_url, "https://gatebrook.work/request.html?b=new-service");
    assert.equal(json.dashboard_url, `https://gatebrook.work/dashboard.html?business_id=${BUSINESS}`);
    assert.equal(json.settings_url, `https://gatebrook.work/settings.html?business_id=${BUSINESS}`);
    assert.equal(new URL(json.setup_url).origin, "https://gatebrook.work");
    assert.equal(new URL(json.setup_url).pathname, "/activate.html");
  }
});
test("GET reports administrator status only after real user and live session authorization", async () => {
  const { response, json, calls } = await run({}, input(), { method: "GET" });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { success: true, is_admin: true });
  assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize"]);
  const denied = await run({ authorized: false }, input(), { method: "GET" });
  assert.equal(denied.response.status, 403);
});
test("server callers without an Origin still require a real administrator", async () => {
  const { response } = await run({ authorized: false }, input(), { origin: null });
  assert.equal(response.status, 403);
});
test("input normalization matches persisted payload and creates one initial invitation", async () => {
  const { response, json, calls } = await run();
  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.request_url, `${PUBLIC_SITE_URL}/request.html?b=new-service`);
  assert.equal(json.dashboard_url, `${PUBLIC_SITE_URL}/dashboard.html?business_id=${BUSINESS}`);
  assert.equal(json.setup_url, `${PUBLIC_SITE_URL}/activate.html#token_hash=${HASH}&type=invite&business_id=${BUSINESS}`);
  assert.deepEqual(calls.find(({ name }) => name === "generateLink")!.params, { type: "invite", email: EMAIL });
  const params = calls.find(({ name }) => name === "flowos_onboarding_provision")!.params as Record<string, unknown>;
  assert.deepEqual(params, { p_actor: ACTOR, p_request: REQUEST, p_owner: OWNER, p_owner_existing: false, p_payload: canonical() });
  assert.equal((params.p_payload as ReturnType<typeof canonical>).business.primary_color, "#6fa7ff");
  assert.equal((params.p_payload as ReturnType<typeof canonical>).business.website_url, null);
  assert.equal(calls.filter(({ name }) => name === "generateLink").length, 1);
});
test("confirmed existing owner gets membership without any credential or invitation operation", async () => {
  const { response, json, calls } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: true } });
  assert.equal(response.status, 200);
  assert.equal(json.owner_existing, true);
  assert.equal(json.owner_setup_required, false);
  assert.equal(json.setup_url, undefined);
  assert.equal(json.setup_error, undefined);
  assert.deepEqual(mutations(calls).map(({ name }) => name), ["flowos_onboarding_provision"]);
});
test("unconfirmed existing owner gets its invite only after atomic provisioning succeeds", async () => {
  const { response, calls } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: false } });
  assert.equal(response.status, 200);
  assert.ok(calls.findIndex(({ name }) => name === "generateLink") > calls.findIndex(({ name }) => name === "flowos_onboarding_provision"));
});
test("new auth account is never deleted and its setup token is not returned after tenant failure", async () => {
  const { response, json, calls } = await run({ provisionError: { code: "23505", message: `secret ${HASH}` } });
  assert.equal(response.status, 409);
  assert.equal(json.setup_url, undefined);
  assert.ok(!JSON.stringify(json).includes(HASH));
  assert.equal(calls.some(({ name }) => /delete|updateUser|recover|magic/i.test(name)), false);
});
test("unconfirmed existing owner is not invited when a slug collision rolls back provisioning", async () => {
  const { response, calls } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: false }, provisionError: { code: "23505" } });
  assert.equal(response.status, 409);
  assert.equal(calls.some(({ name }) => name === "generateLink"), false);
});
test("same request ID and identical canonical payload reuses completed business", async () => {
  const { response, json, calls } = await run({ existing: record(), owner: { id: OWNER, email: EMAIL, confirmed: true } });
  assert.equal(response.status, 200);
  assert.equal(json.business_id, BUSINESS);
  assert.equal(json.owner_setup_required, false);
  assert.equal(mutations(calls).length, 0);
});
test("JSON key order does not turn an identical retry into a conflict", async () => {
  const payload = canonical();
  const reordered = { services: payload.services, owner_email: payload.owner_email, business: Object.fromEntries(Object.entries(payload.business).reverse()) };
  const { response } = await run({ existing: record({ payload: reordered }), owner: { id: OWNER, email: EMAIL, confirmed: true } });
  assert.equal(response.status, 200);
});
test("reusing a request ID with changed details returns conflict without mutations", async () => {
  const { response, calls } = await run({ existing: record() }, input({ services: ["A different service"] }));
  assert.equal(response.status, 409);
  assert.equal(mutations(calls).length, 0);
});
test("setup_link regenerates an unconfirmed invitation for a completed request", async () => {
  const { response, json, calls } = await run({ existing: record(), owner: { id: OWNER, email: EMAIL, confirmed: false } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 200);
  assert.ok(json.setup_url.includes(HASH));
  assert.deepEqual(mutations(calls).map(({ name }) => name), ["generateLink"]);
  assert.deepEqual(calls.find(({ name }) => name === "flowos_onboarding_setup_allowed")!.params, { p_actor: ACTOR, p_request: REQUEST });
  assert.ok(calls.findIndex(({ name }) => name === "flowos_onboarding_setup_allowed") < calls.findIndex(({ name }) => name === "generateLink"));
});
test("setup_link never produces sign-in or password-reset tokens for a confirmed owner", async () => {
  const { response, json, calls } = await run({ existing: record(), owner: { id: OWNER, email: EMAIL, confirmed: true } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 409);
  assert.equal(json.code, "owner_already_active");
  assert.equal(mutations(calls).length, 0);
});
test("interrupted first-password activation can recover only the recorded passwordless owner", async () => {
  const { response, json, calls } = await run({ existing: record({ owner_setup_required: true }), owner: { id: OWNER, email: EMAIL, confirmed: true, has_password: false } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 200);
  assert.equal(json.setup_url, `${PUBLIC_SITE_URL}/activate.html#token_hash=${HASH}&type=recovery&business_id=${BUSINESS}`);
  assert.deepEqual(calls.find(({ name }) => name === "generateLink")!.params, { type: "recovery", email: EMAIL });
});
test("confirmed passwordless account that was active before provisioning never receives a recovery token", async () => {
  const { response, calls } = await run({ existing: record({ owner_setup_required: false }), owner: { id: OWNER, email: EMAIL, confirmed: true, has_password: false } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 409);
  assert.equal(mutations(calls).length, 0);
});
test("recorded onboarding owner who has saved a password cannot receive another credential token", async () => {
  const { response, calls } = await run({ existing: record({ owner_setup_required: true }), owner: { id: OWNER, email: EMAIL, confirmed: true, has_password: true } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 409);
  assert.equal(mutations(calls).length, 0);
});
test("setup_link requires a completed tenant and the same exact owner account", async () => {
  let result = await run({}, { action: "setup_link", request_id: REQUEST });
  assert.equal(result.response.status, 404);
  assert.equal(mutations(result.calls).length, 0);
  result = await run({ existing: record(), owner: { id: ACTOR, email: EMAIL, confirmed: false } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(result.response.status, 409);
  assert.equal(mutations(result.calls).length, 0);
});
test("failed invite after successful tenant creation returns usable business with retry instruction", async () => {
  const { response, json } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: false }, generateError: { message: `Provider failure ${HASH}` } });
  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.business_id, BUSINESS);
  assert.ok(json.setup_error);
  assert.equal(json.setup_url, undefined);
  assert.ok(!JSON.stringify(json).includes(HASH));
});
test("Auth after-create failure or concurrent account creation can safely retry exact owner lookup", async () => {
  const { response, json, calls } = await run({ generateError: { code: "email_exists" }, ownerAfterGenerateFailure: { id: OWNER, email: EMAIL, confirmed: true } });
  assert.equal(response.status, 200);
  assert.equal(json.setup_url, undefined);
  assert.equal(calls.filter(({ name }) => name === "flowos_onboarding_provision").length, 1);
});
test("an invite for a different account is never returned", async () => {
  const { response, json } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: false }, generateData: { user: { id: ACTOR, email: EMAIL }, properties: { hashed_token: HASH, verification_type: "invite" } } });
  assert.equal(response.status, 200);
  assert.ok(json.setup_error);
  assert.equal(json.setup_url, undefined);
});
test("invalid slug, reserved names, duplicates, unsafe URLs and invalid fields fail before owner lookup", async () => {
  const business = input().business;
  const invalid = [
    input({ business: { ...business, slug: "ab" } }), input({ business: { ...business, slug: "one--two" } }),
    input({ business: { ...business, slug: "admin" } }), input({ business: { ...business, slug: "activate" } }),
    input({ services: ["Repair", " repair "] }), input({ services: [] }), input({ services: Array(21).fill("Service") }),
    input({ services: ["x".repeat(121)] }), input({ owner_email: "invalid" }),
    input({ business: { ...business, website_url: "javascript:alert(1)" } }),
    input({ business: { ...business, logo_url: "https://user:pass@example.com/logo.png" } }),
    input({ business: { ...business, name: "bad\u0000name" } }), input({ business: { ...business, primary_color: "red" } }),
    input({ business: { ...business, hidden_admin: true } }), input({ owner_password: "Do not accept passwords" }),
    input({ request_id: "bad" }), input({ action: "reset_password" }),
  ];
  for (const body of invalid) {
    const { response, calls } = await run({}, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(calls.some(({ name }) => name === "flowos_onboarding_owner"), false);
    assert.equal(mutations(calls).length, 0);
  }
});
test("non-JSON and oversized JSON are rejected without owner lookup", async () => {
  let result = await run({}, input(), { contentType: "text/plain" });
  assert.equal(result.response.status, 415);
  result = await run({}, { padding: "x".repeat(40_000) });
  assert.equal(result.response.status, 413);
  assert.equal(result.calls.some(({ name }) => name === "flowos_onboarding_owner"), false);
});
test("database rate limit and authorization errors are mapped without leaking database internals", async () => {
  for (const [code, status] of [["P0003", 429], ["42501", 403], ["22023", 400], ["XX000", 503]] as const) {
    const { response, json } = await run({ owner: { id: OWNER, email: EMAIL, confirmed: true }, provisionError: { code, message: `private SQL ${HASH}` } });
    assert.equal(response.status, status);
    assert.ok(!JSON.stringify(json).includes(HASH));
  }
});
test("business owners cannot list enrollments or read business details without live administrator authorization", async () => {
  for (const body of [{ action: "list_businesses" }, { action: "business_details", business_id: BUSINESS }]) {
    const { response, calls } = await run({ authorized: false,
      user: { id: ACTOR, user_metadata: { platform_admin: true } } }, body);
    assert.equal(response.status, 403);
    assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize"]);
    assert.equal(mutations(calls).length, 0);
  }
});
test("enumeration and detail calls require authenticated users and the same verified live session", async () => {
  for (const body of [{ action: "list_businesses" }, { action: "business_details", business_id: BUSINESS }]) {
    for (const token of [null, jwt({ session_id: undefined }), jwt({ role: "service_role" }), jwt({ sub: OWNER })]) {
      const { response, calls } = await run({}, body, { token });
      assert.equal(response.status, 401);
      assert.equal(calls.some(({ name }) => name.startsWith("flowos_admin_business")), false);
    }
    const revoked = await run({ authorized: false }, body);
    assert.equal(revoked.response.status, 403);
    assert.deepEqual(revoked.calls[1].params, { p_actor: ACTOR, p_session: SESSION });
  }
});
test("list enrollments supplies bounded defaults without any auth-account mutation or request ID", async () => {
  const { response, json, calls } = await run({}, { action: "list_businesses" });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { success: true, ...businessList() });
  assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize", "flowos_admin_businesses"]);
  assert.deepEqual(calls[2].params, { p_actor: ACTOR, p_offset: 0, p_limit: 50, p_active: null, p_search: "" });
  assert.equal(mutations(calls).length, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("list enrollments accepts active/inactive/all filters and normalized paginated search", async () => {
  for (const active of [true, false, null]) {
    const { response, calls } = await run({}, { action: "list_businesses", offset: 100_000, limit: 100,
      active, search: "  New Service \u0065\u0301  " });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[2].params, { p_actor: ACTOR, p_offset: 100_000, p_limit: 100, p_active: active, p_search: "New Service é" });
  }
  const empty = await run({ businessesData: { businesses: [], total: 0, counts: { active: 0, inactive: 0, total: 0 } } },
    { action: "list_businesses", offset: 0, limit: 1, search: " " });
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.json.businesses, []);
});
test("invalid enumeration filters and unexpected fields never reach business data RPCs", async () => {
  const invalid = [
    ...[-1, 100_001, 0.5, "0", null].map((offset) => ({ offset })),
    ...[0, 101, 1.5, "50", null].map((limit) => ({ limit })),
    ...["true", 0, [], {}].map((active) => ({ active })),
    ...[null, 1, [], {}, "x".repeat(121), "bad\u0000query"].map((search) => ({ search })),
    { request_id: REQUEST }, { owner_email: EMAIL }, { token: HASH }, { hidden_admin: true },
  ];
  for (const extra of invalid) {
    const { response, calls } = await run({}, { action: "list_businesses", ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize"]);
  }
});
test("business details restricts RPC data to the requested business and passes pagination", async () => {
  const { response, json, calls } = await run({}, { action: "business_details", business_id: BUSINESS, offset: 25, limit: 50 });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize", "flowos_admin_business_details"]);
  assert.deepEqual(calls[2].params, { p_actor: ACTOR, p_business: BUSINESS, p_offset: 25, p_limit: 50 });
  assert.deepEqual(json, { success: true, ...details() });
  assert.equal(mutations(calls).length, 0);
  const defaults = await run({}, { action: "business_details", business_id: BUSINESS.toUpperCase() });
  assert.deepEqual(defaults.calls[2].params, { p_actor: ACTOR, p_business: BUSINESS, p_offset: 0, p_limit: 25 });
});
test("invalid detail business IDs, pagination, and extra fields fail before details lookup", async () => {
  const invalid = [
    ...[undefined, null, "", "bad-id", ACTOR.replace("-4111-", "-0111-"), 123].map((business_id) => ({ business_id })),
    ...[-1, 100_001, 0.5, "0", null].map((offset) => ({ offset })),
    ...[0, 101, 1.5, "25", null].map((limit) => ({ limit })),
    { active: true }, { search: "business" }, { request_id: REQUEST }, { owner_user_id: OWNER },
  ];
  for (const extra of invalid) {
    const { response, calls } = await run({}, { action: "business_details", business_id: BUSINESS, ...extra });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.deepEqual(calls.map(({ name }) => name), ["getUser", "flowos_admin_authorize"]);
  }
});
test("unknown business details return a controlled 404 without onboarding or credential operations", async () => {
  const { response, json, calls } = await run({ businessDetailsData: null }, { action: "business_details", business_id: BUSINESS });
  assert.equal(response.status, 404);
  assert.deepEqual(json, { success: false, code: "business_not_found", error: "This business could not be found." });
  assert.equal(mutations(calls).length, 0);
  assert.equal(calls.some(({ name }) => name.startsWith("flowos_onboarding")), false);
});
test("console RPC errors are sanitized and map live authorization and validation failures", async () => {
  for (const body of [{ action: "list_businesses" }, { action: "business_details", business_id: BUSINESS }]) {
    for (const [code, status] of [["42501", 403], ["22023", 400], ["23514", 400], ["XX000", 503]] as const) {
      const { response, json, calls } = await run({ consoleError: { code, message: `private SQL token ${HASH}` } }, body);
      assert.equal(response.status, status);
      assert.equal(json.success, false);
      assert.ok(!JSON.stringify(json).includes(HASH));
      assert.ok(!JSON.stringify(json).includes("private SQL"));
      assert.equal(mutations(calls).length, 0);
    }
  }
});
test("enrollment list projects safe business and owner fields instead of exposing onboard payload or tokens", async () => {
  const summary = enrollment({ payload: canonical(), setup_url: HASH, password: HASH,
    owners: [{ user_id: OWNER, email: EMAIL, confirmed: false, has_password: false, password: HASH, hashed_token: HASH }] });
  const { response, json } = await run({ businessesData: { ...businessList(), businesses: [summary], payload: canonical(), setup_token: HASH } },
    { action: "list_businesses" });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { success: true, ...businessList() });
  assert.ok(!JSON.stringify(json).includes(HASH));
  assert.equal(json.businesses[0].payload, undefined);
});
test("business details project profile, service, and lead fields without internal payloads or credential secrets", async () => {
  const original = details();
  const extra = { payload: canonical(), setup_token: HASH, password: HASH };
  const { response, json } = await run({ businessDetailsData: { ...original, ...extra,
    business: { ...original.business, ...extra }, profile: { ...original.profile, ...extra },
    services: original.services.map((row) => ({ ...row, ...extra })), leads: original.leads.map((row) => ({ ...row, ...extra })) } },
    { action: "business_details", business_id: BUSINESS });
  assert.equal(response.status, 200);
  assert.deepEqual(json, { success: true, ...original });
  assert.ok(!JSON.stringify(json).includes(HASH));
});
test("a business-details RPC that violates tenant scope fails closed without any private row", async () => {
  const original = details();
  const violations = [
    { business: enrollment({ business_id: OWNER }) },
    { profile: { ...original.profile, business_id: OWNER } },
    { services: [{ ...original.services[0], business_id: OWNER }] },
    { leads: [{ ...original.leads[0], business_id: OWNER, notes: HASH }] },
  ];
  for (const violation of violations) {
    const { response, json } = await run({ businessDetailsData: details(violation) }, { action: "business_details", business_id: BUSINESS });
    assert.equal(response.status, 503);
    assert.equal(json.code, "admin_data_unavailable");
    assert.equal(json.business, undefined);
    assert.equal(json.leads, undefined);
    assert.ok(!JSON.stringify(json).includes(HASH));
  }
});
test("malformed console data, oversized pages, and nested secret-bearing projected fields fail closed", async () => {
  const invalidLists = [null, [], {},
    { ...businessList(), businesses: [enrollment({ business_id: "bad-id" })] },
    { ...businessList(), businesses: [enrollment({ owners: [{ user_id: OWNER, email: { token: HASH }, confirmed: false, has_password: false }] })] },
    { ...businessList(), businesses: [enrollment({ name: { token: HASH } })] },
    { ...businessList(), businesses: Array(51).fill(enrollment()) },
    { ...businessList(), total: -1 }, { ...businessList(), counts: { active: "1", inactive: 0, total: 1 } },
  ];
  for (const businessesData of invalidLists) {
    const { response, json } = await run({ businessesData }, { action: "list_businesses" });
    assert.equal(response.status, 503);
    assert.equal(json.businesses, undefined);
    assert.ok(!JSON.stringify(json).includes(HASH));
  }
  for (const businessDetailsData of [details({ leads: Array(26).fill(details().leads[0]) }),
    details({ profile: { ...details().profile, tagline: { token: HASH } } }), details({ total_leads: -1 })]) {
    const { response, json } = await run({ businessDetailsData }, { action: "business_details", business_id: BUSINESS });
    assert.equal(response.status, 503);
    assert.equal(json.leads, undefined);
    assert.ok(!JSON.stringify(json).includes(HASH));
  }
});
test("revoked owner membership or inactive business denies issuing invitation and interrupted-activation tokens", async () => {
  for (const owner of [{ id: OWNER, email: EMAIL, confirmed: false, has_password: false },
    { id: OWNER, email: EMAIL, confirmed: true, has_password: false }]) {
    const { response, json, calls } = await run({ existing: record(), owner, setupAllowed: false },
      { action: "setup_link", request_id: REQUEST });
    assert.equal(response.status, 409);
    assert.equal(json.code, "owner_access_changed");
    assert.equal(json.setup_url, undefined);
    assert.equal(mutations(calls).length, 0);
    assert.ok(!JSON.stringify(json).includes(HASH));
  }
});
test("completed-request retries cannot mint owner tokens after business access is revoked", async () => {
  const { response, json, calls } = await run({ existing: record(),
    owner: { id: OWNER, email: EMAIL, confirmed: false }, setupAllowed: false });
  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.business_id, BUSINESS);
  assert.equal(json.setup_url, undefined);
  assert.ok(json.setup_error.includes("review their current business access"));
  assert.equal(mutations(calls).length, 0);
});
test("initial pending invite token is not returned if membership or business changes before finishing", async () => {
  const { response, json, calls } = await run({ setupAllowed: false });
  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.business_id, BUSINESS);
  assert.equal(json.setup_url, undefined);
  assert.ok(json.setup_error.includes("review their current business access"));
  assert.ok(!JSON.stringify(json).includes(HASH));
  assert.deepEqual(mutations(calls).map(({ name }) => name), ["generateLink", "flowos_onboarding_provision"]);
  assert.ok(calls.findIndex(({ name }) => name === "flowos_onboarding_setup_allowed") > calls.findIndex(({ name }) => name === "flowos_onboarding_provision"));
});
test("failure to verify live business access cannot issue a credential token or disclose database internals", async () => {
  const { response, json, calls } = await run({ existing: record(), owner: { id: OWNER, email: EMAIL, confirmed: false },
    setupAllowedError: { code: "XX000", message: `private SQL ${HASH}` } }, { action: "setup_link", request_id: REQUEST });
  assert.equal(response.status, 503);
  assert.equal(json.setup_url, undefined);
  assert.equal(mutations(calls).length, 0);
  assert.ok(!JSON.stringify(json).includes(HASH));
});
