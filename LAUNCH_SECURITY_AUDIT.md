# Gatebrook — Pre-Launch Security & Billing Audit
Date: October 29, 2026 (US Central)
Project: Gatebrook.work
Status: **Not yet cleared for live customer acquisition.**

This audit examined the deployed Supabase Edge Functions, database RLS/privileges and subscription-gated SQL RPCs, the Gatebrook GitHub source, and the connected **live** Stripe account. It did not impersonate an existing customer, perform a live payment, or alter any real subscription.

## Security hardening completed and deployed

1. **Fail-closed customer intake:** The public request form and both customer-request DB handlers now require \`flowos_private.gatebrook_business_has_access\`. Cached \`businesses.active\` flags are not sufficient on their own. Review approval is also blocked when the business has no current entitlement. Applied migration \`202610300002_gatebrook_request_subscription_enforcement.sql\`. Verified all four functions contain the guard, and an incomplete live business returns no request form.
2. **Stripe webhook stale-event protection:** \`gatebrook-stripe-webhook\` version **13** now verifies the Stripe subscription is live, the metadata matches an authenticated business owner, and that a replacement subscription is linked to a **completed Stripe Checkout session** for that owner. Older canceled/failed subscriptions cannot overwrite a newer active subscription. Failed event-journal lookup returns a temporary error rather than bypassing duplicate checks.
3. **Dashboard access:** \`gatebrook-access\` version **12** now rejects missing/invalid subscription period dates. Only a currently active paid period or unexpired trial grants access (plus the existing deliberately seeded demo exemption). This aligns the Edge Function more closely with the database RLS check.
4. **Regression coverage:** \`tests/gatebrook-launch-security.test.cjs\` **11/11 passed** and \`tests/stripe-invoice-webhook.test.cjs\` **9/9 passed**. The source-inspection/mocked tests are not a substitute for live event delivery or a penetration test.

## Existing protections verified

- All ordinary public-schema tables reviewed have RLS enabled. The QA billing and email tables are additionally forced-RLS and do not grant direct anon/authenticated SELECT.
- Production signed webhook has signature verification and a five-minute timestamp tolerance; Stripe Live endpoint is enabled for \`checkout.session.completed\`, \`customer.subscription.created/updated/deleted\`, \`invoice.paid\` and \`invoice.payment_failed\`.
- Checkout verifies the user's Supabase Auth JWT and business ownership before creating Stripe sessions.
- Public lead submission includes Cloudflare Turnstile verification and server-side request validation/rate limiting.
- Stripe sandbox failure/renewal/cancellation flows were verified separately, with no live payments.
- Live Stripe recurring prices: **$149/month**, **$1,490/year**, active and in USD. Both returned \`tax_behavior=unspecified\`.

## Open launch blockers

### 1. Stripe self-service billing portal — **high priority**
The connected live Stripe account returned **zero billing-portal configurations**. Gatebrook's billing portal Edge Function creates portal sessions but does not specify a configuration. Configure and activate a **live** customer portal, explicitly permitting cancellation and selecting **end of paid period** as the cancellation timing. Test access to the portal after creating a legitimate test customer. Do not assume users can currently cancel through the app.
Dashboard: https://dashboard.stripe.com/settings/billing/portal
Documentation: https://docs.stripe.com/customer-management/configure-portal

### 2. Expired-user read-only mode — **product blocker**
The intended policy is: retain customer/business data and allow an expired subscriber to view it, but prevent edits, new requests and premium actions. Actual current implementation redirects an expired subscriber away from their workspace, and \`businesses\` / \`leads\` RLS SELECT policies require \`gatebrook_business_has_access\`, which becomes false after subscription expiration. This is not read-only access. Implement a separate view-versus-write entitlement model and dedicated expired-state UI; keep request creation and writes blocked. Regression-test a canceled/exhausted trial user against both SELECT and UPDATE.
**Do not simply remove the RLS entitlement gates without replacing them with owner-scoped policies.**

### 3. Password security — **recommended**
Supabase's security advisor reports **leaked-password protection disabled**. Supabase documentation says this specific feature requires Pro or higher; check the Supabase project's eligibility. At minimum, enforce strong password length/complexity, review MFA and password-reset/reauthentication behavior. If available, turn on breached-password checks.
Documentation: https://supabase.com/docs/guides/auth/password-security

### 4. Tax & invoicing — **must review before live charges**
Both live Stripe recurring prices have \`tax_behavior=unspecified\`, and neither live Checkout Edge Function currently sets \`automatic_tax[enabled]\`. Determine Gatebrook's applicable sales-tax obligations, product tax code and collection registrations with qualified guidance. Only enable tax collection in regions where registered and after testing price display and invoices.
Dashboard: https://dashboard.stripe.com/settings/tax
Documentation: https://docs.stripe.com/tax/set-up

### 5. Final production smoke tests
Using an authorized live account/payment method, explicitly verify real self-service signup, confirmation, payment capture, cancellation and period-end access; confirm production email delivery and support/contact processes. Do not claim a successful live transaction until completed. The real account currently has **no active paid subscriptions**, so live checkout remains unproven.

### 6. Separate QA from production infrastructure — **recommended before scaling**
Gatebrook QA currently uses separate tables/functions and a different Stripe sandbox, but **shares the same Supabase project and Auth tenant as production**. The QA clock runner and preview endpoints are deployed alongside live business endpoints. They require server-held secrets and allowlisted QA accounts, but a separate Supabase staging project would reduce blast radius further. Plan migration of QA to isolated staging credentials and review whether temporary test functions should remain deployed in the production project after launch.

## Reviewed Supabase advisor warnings

- **Public SECURITY DEFINER request form RPC:** \`gatebrook_get_public_request_form\` is intentionally anonymous to display public form configuration. It returns non-secret form fields, now only for an entitled active workspace. Revoking anonymous EXECUTE immediately would break public request forms; keep its output minimized and watch for future fields accidentally carrying private data.
- **Authenticated SECURITY DEFINER review RPC:** \`gatebrook_review_request\` is intentionally callable by a signed-in business owner. The function explicitly checks \`auth.uid()\`, owner membership, business ID and now current subscription entitlement before writing.
- **RLS enabled without policies:** Numerous backend-only QA and email journal tables use service-role authorization and direct client access is intentionally denied; no blanket policy should be added to silence the informational warning.
- **Performance:** Unindexed \`approved_lead_id\` foreign key, unused indexes and overlapping permissive policies are lower-priority optimizations once the launch blockers above are resolved.

## Recommended next development sequence

1. Configure the **live Stripe customer portal** and verify cancellation timing with a controlled test.
2. Implement **read-only access after subscription expiry**, with owner-scoped SELECT policies and no write access.
3. Review tax registrations, password-protection settings and support/notification delivery.
4. Run a final authorized end-to-end production checkout and cancellation smoke test; document evidence before public launch.

No keys or signing secrets should be added to GitHub, client JavaScript or this document.
