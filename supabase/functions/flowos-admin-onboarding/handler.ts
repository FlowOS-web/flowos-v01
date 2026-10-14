// This module has no runtime imports so its security decisions can be tested offline.
export const PREVIEW_URL = "https://flowos-web.github.io/flowos-v01/v1-preview";
export const ALLOWED_ORIGIN = "https://flowos-web.github.io";
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
  contact_phone: string | null; website_url: string | null; logo_url: string | null;
  primary_color: string; notification_email: string | null;
};
export type Payload = { business: Business; owner_email: string; services: string[] };
export type ProvisionRecord = {
  business_id: string; slug: string; owner_email: string; owner_user_id: string;
  owner_existing: boolean; owner_setup_required: boolean; payload: Payload;
};
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
  onlyKeys(business, ["name", "slug", "industry", "tagline", "contact_phone", "website_url", "logo_url", "primary_color", "notification_email"], "Business");
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
function result(record: ProvisionRecord) {
  return {
    success: true, business_id: record.business_id, slug: record.slug,
    owner_email: record.owner_email, owner_user_id: record.owner_user_id,
    owner_existing: record.owner_existing, owner_setup_required: record.owner_setup_required,
    request_url: `${PREVIEW_URL}/request.html?b=${encodeURIComponent(record.slug)}`,
    dashboard_url: `${PREVIEW_URL}/dashboard.html?business_id=${encodeURIComponent(record.business_id)}`,
    settings_url: `${PREVIEW_URL}/settings.html?business_id=${encodeURIComponent(record.business_id)}`,
  };
}
function setupUrl(record: ProvisionRecord, token: string, type: "invite" | "recovery" = "invite"): string {
  const fragment = new URLSearchParams({ token_hash: token, type, business_id: record.business_id });
  return `${PREVIEW_URL}/activate.html#${fragment}`;
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
async function finish(client: AdminClient, actor: string, record: ProvisionRecord, pendingToken?: string) {
  const output: ReturnType<typeof result> & { setup_url?: string; setup_error?: string } = result(record);
  try {
    const owner = await ownerForRecord(client, actor, record);
    const type = setupType(owner, record);
    if (type) {
      const token = type === "invite" && pendingToken ? pendingToken : (await generateSetup(client, record.owner_email, owner.id, type)).token;
      output.setup_url = setupUrl(record, token, type);
    }
  } catch {
    output.setup_error = "Business created. Owner setup link is unavailable; use Generate setup link to retry.";
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
    if (origin === ALLOWED_ORIGIN) {
      headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
      headers["Access-Control-Allow-Headers"] = "authorization, apikey, x-client-info, content-type";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
    if (origin && origin !== ALLOWED_ORIGIN) return respond(403, { success: false, code: "origin_denied", error: "This origin is not allowed." });
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
        const generated = await generateSetup(client, owner.email, owner.id, type);
        return respond(200, { ...result(existing), setup_url: setupUrl(existing, generated.token, type) });
      }
      if (existing) {
        if (stableJson(existing.payload) !== stableJson(payload)) throw new HttpError(409, "request_changed", "This request ID was already used with different details. Restore them or start a new setup.");
        return respond(200, await finish(client, user.id, existing));
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
      return respond(200, await finish(client, user.id, record, record.owner_user_id === owner.id ? pendingToken : undefined));
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(503, "onboarding_unavailable", "Administrator setup is unavailable. Retry with the same request ID.");
      return respond(failure.status, { success: false, code: failure.code, error: failure.message });
    }
  };
}
