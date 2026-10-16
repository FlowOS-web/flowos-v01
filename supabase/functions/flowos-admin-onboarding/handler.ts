// This module has no runtime imports so its security decisions can be tested offline.
export const PUBLIC_SITE_URL = "https://gatebrook.work";
export const LEGACY_ORIGIN = "https://flowos-web.github.io";
const ALLOWED_ORIGINS = new Set([PUBLIC_SITE_URL, LEGACY_ORIGIN]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set([
  "activate", "admin", "api", "auth", "dashboard", "flowos", "index", "login", "logout",
  "onboarding", "privacy", "request", "settings", "signup", "support", "terms", "v1-preview", "www",
]);
const MAX_BODY_BYTES = 32_768;

type ObjectValue = Record<string, unknown>;
type RpcError = { code?: string; message?: string };
type Result<T> = { data: T; error: RpcError | null };
type AuthUser = { id: string; email?: string; is_anonymous?: boolean; email_confirmed_at?: string | null };
type Owner = { id: string; email: string; confirmed: boolean; has_password: boolean };
type LinkData = { user: AuthUser | null; properties: { hashed_token?: string; verification_type?: string } | null };
export type Business = {
  name: string; slug: string; industry: string | null; tagline: string | null;
  contact_phone: string | null; public_email: string | null; website_url: string | null; logo_url: string | null;
  primary_color: string; notification_email: string | null;
};
export type Payload = { business: Business; owner_email: string; services: string[] };
export type ProvisionRecord = {
  business_id: string; slug: string; owner_email: string; owner_user_id: string;
  owner_existing: boolean; owner_setup_required: boolean; payload: Payload;
};
export type Enrollment = {
  business_id: string; name: string; slug: string; industry: string | null;
  active: boolean; created_at: string; owner_email: string | null;
  owners: { user_id: string; email: string; confirmed: boolean; has_password: boolean }[];
  service_count: number; lead_count: number; request_id: string | null;
  setup_available: boolean; owner_setup_required: boolean;
};
type BusinessList = {
  businesses: Enrollment[]; total: number;
  counts: { active: number; inactive: number; total: number };
};
type BusinessDetails = {
  business: Enrollment; profile: ObjectValue | null;
  services: ObjectValue[]; leads: ObjectValue[]; total_leads: number;
};
const ENROLLMENT_FIELDS = ["business_id", "name", "slug", "industry", "active", "created_at", "owner_email",
  "service_count", "lead_count", "request_id", "setup_available", "owner_setup_required"];
const PROFILE_FIELDS = ["business_id", "slug", "display_name", "industry", "tagline", "active", "logo_url",
  "primary_color", "contact_phone", "public_email", "website_url"];
const SERVICE_FIELDS = ["id", "business_id", "name", "active", "sort_order"];
const LEAD_FIELDS = ["id", "business_id", "created_at", "customer_name", "phone", "email", "vehicle",
  "vehicle_type", "service", "service_location", "preferred_date", "notes", "status", "source", "estimated_value", "booked_revenue"];
export interface AdminClient {
  auth: {
    getUser(token: string): Promise<Result<{ user: AuthUser | null }>>;
    admin: { generateLink(params: { type: "invite" | "recovery"; email: string }): Promise<Result<LinkData>> };
  };
  rpc(name: string, params: ObjectValue): PromiseLike<Result<unknown>>;
}
export interface HandlerDependencies { client: AdminClient }

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_input", `${label} must be an object.`);
  }
  return value as ObjectValue;
}
function onlyKeys(value: ObjectValue, keys: string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HttpError(400, "invalid_input", `${label} contains an unsupported field.`);
  }
}
function field(value: unknown, label: string, max: number, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, "invalid_input", `${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, "invalid_input", `${label} must be text.`);
  const clean = value.trim().normalize("NFC");
  if (!clean) {
    if (required) throw new HttpError(400, "invalid_input", `${label} is required.`);
    return null;
  }
  if (clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new HttpError(400, "invalid_input", `${label} is too long or contains a control character.`);
  }
  return clean;
}
function email(value: unknown, label: string, required = false): string | null {
  const clean = field(value, label, 200, required)?.toLowerCase() ?? null;
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new HttpError(400, "invalid_input", `${label} must be a valid email address.`);
  }
  return clean;
}
function safeUrl(value: unknown, label: string, max: number): string | null {
  const clean = field(value, label, max);
  if (!clean) return null;
  try {
    const parsed = new URL(clean);
    if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("Invalid URL");
    }
  } catch {
    throw new HttpError(400, "invalid_input", `${label} must be an http or https URL without credentials.`);
  }
  return clean;
}
export function validatePayload(input: ObjectValue): Payload {
  onlyKeys(input, ["action", "request_id", "business", "owner_email", "services"], "Request");
  const business = object(input.business, "Business");
  onlyKeys(business, ["name", "slug", "industry", "tagline", "contact_phone", "public_email", "website_url", "logo_url", "primary_color", "notification_email"], "Business");
  const slug = field(business.slug, "Request link name", 60, true)!.toLowerCase();
  if (slug.length < 3 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || RESERVED_SLUGS.has(slug)) {
    throw new HttpError(400, "invalid_input", "Choose a request link name of 3–60 letters, numbers, and single hyphens.");
  }
  const color = (field(business.primary_color, "Brand color", 7) ?? "#6fa7ff").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new HttpError(400, "invalid_input", "Brand color must use #rrggbb.");
  if (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 20) {
    throw new HttpError(400, "invalid_input", "Add between 1 and 20 initial services.");
  }
  const services = input.services.map((service) => {
    if (typeof service !== "string") throw new HttpError(400, "invalid_input", "Service names must be text.");
    return field(service.replace(/\s+/g, " "), "Service name", 120, true)!;
  });
  if (new Set(services.map((service) => service.toLowerCase())).size !== services.length) {
    throw new HttpError(400, "invalid_input", "Service names must be unique.");
  }
  return {
    business: {
      name: field(business.name, "Business name", 120, true)!, slug,
      industry: field(business.industry, "Industry", 120),
      tagline: field(business.tagline, "Tagline", 280),
      contact_phone: field(business.contact_phone, "Public phone", 50),
      public_email: email(business.public_email, "Public contact email"),
      website_url: safeUrl(business.website_url, "Website", 300),
      logo_url: safeUrl(business.logo_url, "Logo", 500), primary_color: color,
      notification_email: email(business.notification_email, "Notification email"),
    },
    owner_email: email(input.owner_email, "Owner email", true)!, services,
  };
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(400, "invalid_input", "A valid request ID is required.");
  }
  return value.toLowerCase();
}
function businessId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(400, "invalid_input", "A valid business ID is required.");
  }
  return value.toLowerCase();
}
function integer(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_input", `${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value;
}
function listFilters(input: ObjectValue) {
  onlyKeys(input, ["action", "offset", "limit", "active", "search"], "Request");
  const active = input.active ?? null;
  if (active !== null && typeof active !== "boolean") {
    throw new HttpError(400, "invalid_input", "Active must be true, false, or null.");
  }
  if (input.search !== undefined && typeof input.search !== "string") {
    throw new HttpError(400, "invalid_input", "Search must be text.");
  }
  return {
    offset: integer(input.offset, "Offset", 0, 0, 100_000),
    limit: integer(input.limit, "Limit", 50, 1, 100), active,
    search: field(input.search, "Search", 120) ?? "",
  };
}
function detailFilters(input: ObjectValue) {
  onlyKeys(input, ["action", "business_id", "offset", "limit"], "Request");
  return {
    business: businessId(input.business_id),
    offset: integer(input.offset, "Offset", 0, 0, 100_000),
    limit: integer(input.limit, "Limit", 25, 1, 100),
  };
}
function sessionId(token: string, actor: string): string {
  try {
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("Malformed token");
    const part = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4)));
    // Parsing is only done after getUser authenticates this exact token. Claims
    // supply the session identifier; live authorization remains in Postgres.
    if (claims.sub !== actor || claims.role !== "authenticated" || !UUID.test(claims.session_id)) throw new Error("No user session");
    return claims.session_id;
  } catch { throw new HttpError(401, "invalid_session", "Sign in again to use administrator tools."); }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as ObjectValue;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function dbError(error: RpcError): HttpError {
  if (error.code === "23505" || error.code === "P0002") {
    return new HttpError(409, "conflict", "That request link name is taken, or this request ID was already used for different details.");
  }
  if (error.code === "42501") return new HttpError(403, "admin_required", "Administrator access is required.");
  if (error.code === "22023" || error.code === "23514") return new HttpError(400, "invalid_input", "Check the business and owner details and try again.");
  if (error.code === "P0003" || error.code === "53300") return new HttpError(429, "rate_limited", "Wait a moment before creating another business.");
  return new HttpError(503, "provision_unavailable", "Business setup could not be completed. Retry with the same request ID.");
}
async function rpc<T>(client: AdminClient, name: string, params: ObjectValue): Promise<T> {
  const { data, error } = await client.rpc(name, params);
  if (error) throw dbError(error);
  return data as T;
}
async function consoleRpc<T>(client: AdminClient, name: string, params: ObjectValue): Promise<T> {
  const { data, error } = await client.rpc(name, params);
  if (error) {
    if (error.code === "42501") throw dbError(error);
    if (error.code === "22023" || error.code === "23514") {
      throw new HttpError(400, "invalid_input", "Check the business filters and try again.");
    }
    throw new HttpError(503, "admin_data_unavailable", "Administrator business data is unavailable. Try again.");
  }
  return data as T;
}
function consoleUnavailable(): HttpError {
  return new HttpError(503, "admin_data_unavailable", "Administrator business data is unavailable. Try again.");
}
function consoleObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw consoleUnavailable();
  return value as ObjectValue;
}
function project(value: unknown, keys: string[]): ObjectValue {
  const source = consoleObject(value);
  const output: ObjectValue = {};
  for (const key of keys) {
    const item = source[key];
    if (item !== undefined && item !== null && !["string", "number", "boolean"].includes(typeof item)) throw consoleUnavailable();
    if (item !== undefined) output[key] = item;
  }
  return output;
}
function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function enrollment(value: unknown): ObjectValue {
  const source = consoleObject(value);
  const output = project(source, ENROLLMENT_FIELDS);
  if (typeof source.business_id !== "string" || !UUID.test(source.business_id) ||
    typeof source.name !== "string" || typeof source.slug !== "string" ||
    !(source.industry === null || typeof source.industry === "string") ||
    typeof source.active !== "boolean" || typeof source.created_at !== "string" ||
    !(source.owner_email === null || typeof source.owner_email === "string") ||
    !validCount(source.service_count) || !validCount(source.lead_count) ||
    !(source.request_id === null || typeof source.request_id === "string" && UUID.test(source.request_id)) ||
    typeof source.setup_available !== "boolean" || typeof source.owner_setup_required !== "boolean" || !Array.isArray(source.owners)) {
    throw consoleUnavailable();
  }
  output.owners = source.owners.map((value) => {
    const owner = project(value, ["user_id", "email", "confirmed", "has_password"]);
    if (typeof owner.user_id !== "string" || !UUID.test(owner.user_id) || typeof owner.email !== "string" ||
      typeof owner.confirmed !== "boolean" || typeof owner.has_password !== "boolean") throw consoleUnavailable();
    return owner;
  });
  return output;
}
function scopedRows(value: unknown, business: string, keys: string[]): ObjectValue[] {
  if (!Array.isArray(value)) throw consoleUnavailable();
  return value.map((item) => {
    const row = project(item, keys);
    if (row.business_id !== business) throw consoleUnavailable();
    return row;
  });
}
function businessList(value: BusinessList, limit: number) {
  const source = consoleObject(value);
  const counts = project(source.counts, ["active", "inactive", "total"]);
  if (!Array.isArray(source.businesses) || source.businesses.length > limit || !validCount(source.total) ||
    !validCount(counts.active) || !validCount(counts.inactive) || !validCount(counts.total)) throw consoleUnavailable();
  return { businesses: source.businesses.map(enrollment), total: source.total, counts };
}
function businessDetails(value: BusinessDetails, business: string, limit: number) {
  const source = consoleObject(value);
  const summary = enrollment(source.business);
  if (summary.business_id !== business || !validCount(source.total_leads)) throw consoleUnavailable();
  const profile = source.profile === null ? null : project(source.profile, PROFILE_FIELDS);
  if (profile && profile.business_id !== business) throw consoleUnavailable();
  const services = scopedRows(source.services, business, SERVICE_FIELDS);
  const leads = scopedRows(source.leads, business, LEAD_FIELDS);
  if (leads.length > limit) throw consoleUnavailable();
  return { business: summary, profile, services, leads, total_leads: source.total_leads };
}
function result(record: ProvisionRecord) {
  return {
    success: true, business_id: record.business_id, slug: record.slug,
    owner_email: record.owner_email, owner_user_id: record.owner_user_id,
    owner_existing: record.owner_existing, owner_setup_required: record.owner_setup_required,
    request_url: `${PUBLIC_SITE_URL}/request.html?b=${encodeURIComponent(record.slug)}`,
    dashboard_url: `${PUBLIC_SITE_URL}/dashboard.html?business_id=${encodeURIComponent(record.business_id)}`,
    settings_url: `${PUBLIC_SITE_URL}/settings.html?business_id=${encodeURIComponent(record.business_id)}`,
  };
}
function setupUrl(record: ProvisionRecord, token: string, type: "invite" | "recovery" = "invite"): string {
  const fragment = new URLSearchParams({ token_hash: token, type, business_id: record.business_id });
  return `${PUBLIC_SITE_URL}/activate.html#${fragment}`;
}
async function generateSetup(client: AdminClient, ownerEmail: string, expectedUser?: string, type: "invite" | "recovery" = "invite") {
  const { data, error } = await client.auth.admin.generateLink({ type, email: ownerEmail });
  if (error || !data?.user || !UUID.test(data.user.id) || data.user.email?.toLowerCase() !== ownerEmail ||
    (type === "invite" && data.user.email_confirmed_at) || (expectedUser && data.user.id !== expectedUser) ||
    data.properties?.verification_type !== type || !data.properties.hashed_token) {
    // Never relay raw Auth errors, URLs, OTPs, or tokens into errors or logs.
    throw new HttpError(502, "setup_unavailable", "The owner setup link could not be generated. Retry setup after the business is created.");
  }
  return { owner: { id: data.user.id, email: ownerEmail, confirmed: false, has_password: false }, token: data.properties.hashed_token };
}
function setupType(owner: Owner, record: ProvisionRecord): "invite" | "recovery" | null {
  if (!owner.confirmed) return "invite";
  // An interrupted activation can confirm the invite before the owner saves a
  // first password. Recovery is permitted only for this recorded, passwordless
  // onboarding state; already-active owners never receive credential tokens.
  if (record.owner_setup_required === true && owner.has_password === false) return "recovery";
  return null;
}
async function ownerForRecord(client: AdminClient, actor: string, record: ProvisionRecord): Promise<Owner> {
  const owner = await rpc<Owner | null>(client, "flowos_onboarding_owner", { p_actor: actor, p_email: record.owner_email });
  if (!owner || owner.id !== record.owner_user_id || owner.email.toLowerCase() !== record.owner_email) {
    throw new HttpError(409, "owner_changed", "The owner account has changed. Review its access before issuing a setup link.");
  }
  return owner;
}
async function setupAllowed(client: AdminClient, actor: string, request: string) {
  const allowed = await rpc<boolean>(client, "flowos_onboarding_setup_allowed", { p_actor: actor, p_request: request });
  if (allowed !== true) throw new HttpError(409, "owner_access_changed", "The owner's business access has changed. Review access before issuing a setup link.");
}
async function finish(client: AdminClient, actor: string, request: string, record: ProvisionRecord, pendingToken?: string) {
  const output: ReturnType<typeof result> & { setup_url?: string; setup_error?: string } = result(record);
  try {
    const owner = await ownerForRecord(client, actor, record);
    const type = setupType(owner, record);
    output.owner_setup_required = type !== null;
    if (type) {
      await setupAllowed(client, actor, request);
      const token = type === "invite" && pendingToken ? pendingToken : (await generateSetup(client, record.owner_email, owner.id, type)).token;
      output.setup_url = setupUrl(record, token, type);
    }
  } catch (error) {
    output.setup_error = error instanceof HttpError && ["owner_changed", "owner_access_changed"].includes(error.code)
      ? "Business created. Owner access has changed; review their current business access before retrying setup."
      : "Business created. Owner setup link is unavailable; use Generate setup link to retry.";
  }
  return output;
}
async function readJson(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required", "Send this request as JSON.");
  }
  const declaredSize = Number(req.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large", "The request is too large.");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_input", "Request details are required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large", "The request is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new HttpError(400, "invalid_input", "Request details must be valid JSON."); }
}

export function createHandler({ client }: HandlerDependencies) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Vary": "Origin",
    };
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "authorization, apikey, x-client-info, content-type";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return respond(403, { success: false, code: "origin_denied", error: "This origin is not allowed." });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!["GET", "POST"].includes(req.method)) return respond(405, { success: false, code: "method_not_allowed", error: "Use GET or POST." });
    try {
      const auth = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
      if (!auth) throw new HttpError(401, "sign_in_required", "Sign in to use administrator tools.");
      const { data, error } = await client.auth.getUser(auth[1]);
      const user = data?.user;
      if (error || !user || !UUID.test(user.id) || user.is_anonymous) {
        throw new HttpError(401, "invalid_session", "Sign in again to use administrator tools.");
      }
      const session = sessionId(auth[1], user.id);
      const allowed = await rpc<boolean>(client, "flowos_admin_authorize", { p_actor: user.id, p_session: session });
      if (allowed !== true) throw new HttpError(403, "admin_required", "Administrator access is required, with a current signed-in session.");
      if (req.method === "GET") return respond(200, { success: true, is_admin: true });
      const input = object(await readJson(req), "Request");
      if (input.action === "list_businesses") {
        const filters = listFilters(input);
        const data = await consoleRpc<BusinessList>(client, "flowos_admin_businesses", {
          p_actor: user.id, p_offset: filters.offset, p_limit: filters.limit,
          p_active: filters.active, p_search: filters.search,
        });
        return respond(200, { success: true, ...businessList(data, filters.limit) });
      }
      if (input.action === "business_details") {
        const filters = detailFilters(input);
        const data = await consoleRpc<BusinessDetails | null>(client, "flowos_admin_business_details", {
          p_actor: user.id, p_business: filters.business, p_offset: filters.offset, p_limit: filters.limit,
        });
        if (data === null) throw new HttpError(404, "business_not_found", "This business could not be found.");
        return respond(200, { success: true, ...businessDetails(data, filters.business, filters.limit) });
      }
      if (!["provision", "setup_link"].includes(String(input.action))) throw new HttpError(400, "invalid_input", "Choose a supported administrator action.");
      const id = requestId(input.request_id);
      const payload = input.action === "provision" ? validatePayload(input) : null;
      if (!payload) onlyKeys(input, ["action", "request_id"], "Request");
      const existing = await rpc<ProvisionRecord | null>(client, "flowos_onboarding_get", { p_actor: user.id, p_request: id });
      if (input.action === "setup_link") {
        if (!existing) throw new HttpError(404, "request_not_found", "No completed business setup exists for this request ID.");
        const owner = await ownerForRecord(client, user.id, existing);
        const type = setupType(owner, existing);
        if (!type) throw new HttpError(409, "owner_already_active", "This owner account is already active. They can sign in at the dashboard.");
        await setupAllowed(client, user.id, id);
        const generated = await generateSetup(client, owner.email, owner.id, type);
        return respond(200, { ...result(existing), setup_url: setupUrl(existing, generated.token, type) });
      }
      if (existing) {
        if (stableJson(existing.payload) !== stableJson(payload)) throw new HttpError(409, "request_changed", "This request ID was already used with different details. Restore them or start a new setup.");
        return respond(200, await finish(client, user.id, id, existing));
      }
      let owner = await rpc<Owner | null>(client, "flowos_onboarding_owner", { p_actor: user.id, p_email: payload!.owner_email });
      let ownerExisting = !!owner;
      let pendingToken: string | undefined;
      if (!owner) {
        try {
          const generated = await generateSetup(client, payload!.owner_email);
          owner = generated.owner;
          pendingToken = generated.token;
        } catch (error) {
          // A concurrent request or a failed Auth after-create hook can leave a
          // real user behind. Re-read it; never delete an account on SQL failure.
          owner = await rpc<Owner | null>(client, "flowos_onboarding_owner", { p_actor: user.id, p_email: payload!.owner_email });
          if (!owner) throw error;
          ownerExisting = true;
        }
      }
      const record = await rpc<ProvisionRecord>(client, "flowos_onboarding_provision", {
        p_actor: user.id, p_request: id, p_owner: owner.id,
        p_owner_existing: ownerExisting, p_payload: payload,
      });
      // The atomic database function decides the winning record under its lock.
      // Discard a pre-generated token if another call won with a different user.
      return respond(200, await finish(client, user.id, id, record, record.owner_user_id === owner.id ? pendingToken : undefined));
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "onboarding_unavailable", "Administrator setup is unavailable. Retry with the same request ID.");
      return respond(failure.status, { success: false, code: failure.code, error: failure.message });
    }
  };
}
