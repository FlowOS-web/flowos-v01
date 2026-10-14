import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ORIGIN, PREVIEW_URL, createHandler, validatePayload, type AdminClient, type ProvisionRecord } from "./handler.ts";

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
type MockOptions = {
  user?: unknown; authError?: unknown; authorized?: boolean; existing?: ProvisionRecord | null;
  owner?: { id: string; email: string; confirmed: boolean; has_password?: boolean } | null;
  generateError?: unknown; generateData?: unknown; provisionError?: unknown; provisionData?: ProvisionRecord;
  ownerAfterGenerateFailure?: { id: string; email: string; confirmed: boolean; has_password?: boolean } | null;
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
  if (opts.origin !== null) headers.origin = opts.origin ?? ALLOWED_ORIGIN;
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
  for (const method of ["POST", "OPTIONS"]) {
    const { response, calls } = await run({}, input(), { origin: "https://attacker.example", method });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(calls, []);
  }
});
test("approved preflight is allowed and response caching is disabled", async () => {
  const { response, calls } = await run({}, input(), { method: "OPTIONS", token: null });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, []);
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
  assert.equal(json.request_url, `${PREVIEW_URL}/request.html?b=new-service`);
  assert.equal(json.dashboard_url, `${PREVIEW_URL}/dashboard.html?business_id=${BUSINESS}`);
  assert.equal(json.setup_url, `${PREVIEW_URL}/activate.html#token_hash=${HASH}&type=invite&business_id=${BUSINESS}`);
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
  assert.equal(json.setup_url, `${PREVIEW_URL}/activate.html#token_hash=${HASH}&type=recovery&business_id=${BUSINESS}`);
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
