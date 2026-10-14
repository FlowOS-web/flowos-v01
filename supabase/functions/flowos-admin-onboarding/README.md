# FlowOS administrator provisioning

Deploy this function with JWT verification enabled. The browser sends the signed-in user's access token and public anon API key. The service role is read from Edge Function secrets; it never reaches a page or response. The function checks that token with Auth `getUser`, then checks platform administrator membership and the live `auth.sessions` row through `flowos_admin_authorize`. User-editable metadata grants no authority.

Only `https://flowos-web.github.io` is accepted as a browser origin. Server callers with no Origin header still need the same real administrator user and live session. Every response disables caching.

## Requests

`POST` JSON `{action:"provision",request_id:"<uuid>",business:{name,slug,industry,tagline,contact_phone,website_url,logo_url,primary_color,notification_email},owner_email,services:["Service"]}`. Keep the request ID across retries with identical details. The database performs business, public profile, initial service and owner membership insertion atomically; its advisory locks and unique constraints prevent duplicate tenants.

`GET` returns `{success:true,is_admin:true}` only after verifying the user and live administrator session.

`POST` JSON `{action:"list_businesses",offset:0,limit:50,active:true,search:""}` returns the durable enrollment directory and global enrollment counts. Set `active` to `null` for all or `false` for inactive businesses. Bounds are validated; search treats percent and underscore literally. Only current platform administrators can enumerate enrollments.

`POST` JSON `{action:"business_details",business_id:"<uuid>",offset:0,limit:25}` returns that business's current enrollment, public profile, services, and paginated leads. This is administrator support visibility through the protected server, not owner impersonation or a tenant RLS bypass granted to browser roles. Only projected fields are returned, and the handler independently checks all rows belong to the requested business. Owner setup generation additionally checks current membership, enrollment activity, and Auth state through `flowos_onboarding_setup_allowed` before returning any token.

`POST` JSON `{action:"setup_link",request_id:"<completed-request-uuid>"}` regenerates a setup link for the same unconfirmed owner on a completed provisioning record. If the invite was accepted but the first password was never saved, a recovery link can finish that interrupted activation only when the record says the owner originally needed setup and Auth still reports no password. An owner who already had a confirmed account at provisioning, or has since saved a password, cannot receive a credential token from this endpoint.

Confirmed existing owners receive membership and dashboard access; their credentials are untouched and no sign-in, password reset or recovery tokens are generated. New owners are created with an Auth invite link, without a password supplied by the administrator. Existing unconfirmed owners can be invited again. Auth generates a new confirmation token, which may replace an earlier invite. Setup links are one-time secrets: privately give the owner the displayed activation URL. Generating a link does not send an email. Tokens and passwords are never persisted in the provisioning database or logged by this function.

The activation URL uses `#token_hash=...&type=invite&business_id=...` (or `type=recovery` for the restricted interrupted-activation case) at the fixed preview activation page. The hash is exchanged by that page with `verifyOtp`; it does not depend on the project's redirect allowlist and is not placed in the initial GitHub Pages request URL.

Auth account creation and the tenant database transaction cannot share one transaction. If Auth succeeds and tenant provisioning fails, an unconfirmed account may remain without a tenant. The function withholds its setup link and leaves that account alone: deleting it could destroy an account another concurrent request is using. Retry using the same request ID and owner email; exact lookup reuses it safely. If tenant creation succeeds but link generation fails, the response still returns the business/request/dashboard links and a `setup_error`; retry `setup_link` without creating another business.

## Offline verification

Node.js 24 or newer can run `node --test supabase/functions/flowos-admin-onboarding/handler.test.ts` from the repository root. Tests use mocks and send no real invitation or email. They verify anonymous/non-admin denial, a revoked session, forged metadata, validation, atomic-RPC handoff, retry behavior, existing-owner credential protection, activation-link restrictions and sanitized errors.

Auth behavior was checked against [generateLink documentation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) and [the Auth implementation](https://github.com/supabase/auth/blob/master/internal/api/mail.go). The SDK import is pinned to `@supabase/supabase-js@2.117.3`.
