# Gatebrook QA — isolated sandbox subscription test

**Updated:** October 29, 2026  
**Implementation:** Dedicated QA functions and tables in the existing Supabase project, separate Stripe **Gatebrook QA** sandbox.  
**Status:** Code deployed; sandbox webhook created; **three QA secrets must still be entered in Supabase**.

## QA links

- [QA checkout page](https://gatebrook.work/qa.html)
- [QA dashboard preview](https://gatebrook.work/qa-dashboard.html)
- [Supabase Edge Functions](https://supabase.com/dashboard/project/mxyikhxpzijrdrgowmxr/functions)
- [Stripe sandboxes](https://dashboard.stripe.com/sandboxes)
- [Stripe account/API keys](https://dashboard.stripe.com/apikeys)

**Production stays untouched:** The regular Gatebrook site still uses the original live Stripe credentials and live billing functions. No sandbox subscription can unlock the production dashboard. This setup shares only the Supabase Auth user directory with production; it does **not** offer the isolation of a completely separate staging Supabase project.

## Already configured

| Component | Identifier | State |
|---|---|---|
| Stripe account | Gatebrook QA (`acct_1UW2IXH6B0zVSPUK`) | Connected, sandbox mode |
| QA monthly price | `price_1UW2J0H6B0zVSPUKp4kjPn1z` | $149/month test only |
| QA annual price | `price_1UW2IzH6B0zVSPUKLnfJI8nj` | $1,490/year test only |
| Sandbox webhook | `we_1UW2i7H6B0zVSPUKNRm4cRlN` | Enabled, requires signing secret configured in Supabase |
| Webhook URL | `https://mxyikhxpzijrdrgowmxr.supabase.co/functions/v1/gatebrook-qa-webhook` | Deployed |
| Checkout API | `gatebrook-qa-checkout` | Deployed |
| Status API | `gatebrook-qa-status` | Deployed |
| Webhook API | `gatebrook-qa-webhook` | Deployed |
| QA database | `gatebrook_qa_testers/workspaces/subscriptions/events` | Created, RLS enabled, no direct public or signed-in table grants |
| QA tester | Existing confirmed account `jp920975@gmail.com` | Allowlisted |

The prior sandbox-hosted trial `sub_1UW2XNH6B0zVSPUK5cZuJ8TV` is separate from this QA integration: it has no QA workspace metadata and cannot activate the new QA dashboard. It is left unchanged.

## Action required — add exactly three secrets

1. In the **Gatebrook QA sandbox**, go to Developers / API keys and copy the **test** publishable key `pk_test_...` and **test** secret key `sk_test_...` (or a suitably scoped `rk_test_...` restricted key).
2. In the **Gatebrook QA sandbox**, find **Workbench → Webhooks →** the Gatebrook QA endpoint with ID `we_1UW2i7H6B0zVSPUKNRm4cRlN`. Reveal that endpoint's signing secret `whsec_...`. Do **not** use the signing secret from Gatebrook Live.
3. In Supabase project `mxyikhxpzijrdrgowmxr`, open **Edge Functions → Secrets** and create or update:

| Secret name in Supabase | Value to paste into Supabase |
|---|---|
| `GATEBROOK_QA_STRIPE_SECRET_KEY` | The Gatebrook QA sandbox `sk_test_...` or `rk_test_...` |
| `GATEBROOK_QA_STRIPE_PUBLISHABLE_KEY` | The same sandbox's `pk_test_...` |
| `GATEBROOK_QA_WEBHOOK_SECRET` | The Gatebrook QA webhook's `whsec_...` |

**Never paste any secret key or signing secret into ChatGPT, GitHub, a web page, or a screenshot.** The QA functions check for test-mode prefixes and will refuse live keys. The sandbox Price IDs are already configured server-side; do not add new prices.

If using a restricted API key, permit the sandbox Checkout Session and Subscription read/write operations needed by the functions. The webhook function also reads subscriptions and Checkout Sessions.

## First connected test

1. Sign in to Gatebrook with the allowlisted tester account (use the normal Account page if necessary).
2. Go to [QA checkout](https://gatebrook.work/qa.html), select **7-day trial**, and choose **Start free test trial**.
3. In Stripe's embedded form, enter only the test Visa `4242 4242 4242 4242`, a future expiration and any 3-digit CVC. Stripe's card testing guide: https://docs.stripe.com/testing
4. Finish checkout; the return URL is `qa.html?checkout=success`.
5. Stripe sends the signed sandbox webhook to `gatebrook-qa-webhook`. On [QA checkout](https://gatebrook.work/qa.html), use **Check status** after the webhook has been delivered.
6. Confirm **Trial active** and open the [QA dashboard](https://gatebrook.work/qa-dashboard.html).
7. Check Supabase `public.gatebrook_qa_subscriptions` for `status='trialing'` and `stripe_subscription_id`. Verify the production `public.gatebrook_subscriptions` record count/status is unchanged.

If checkout shows **"Sandbox checkout is not configured yet"**, check the three secret names and make sure the keys are from the same Gatebrook QA sandbox. If a customer session succeeds but the QA dashboard stays locked, look at the sandbox webhook's delivery logs and Supabase `gatebrook-qa-webhook` function logs.

## Boundaries and security notes

- QA functions read/write only the `gatebrook_qa_*` tables. The production dashboard continues to check `gatebrook_subscriptions`; QA does not bypass it.
- QA requires a signed-in allowlisted tester before checkout; never use Supabase `user_metadata` for authorization.
- The webhook independently verifies its HMAC signing secret, `livemode:false`, the Stripe subscription, the matching QA checkout session, workspace ownership, and the tester allowlist before updating state.
- Unpaid sessions do not grant access. Duplicate processed events are recorded in `gatebrook_qa_events`.
- The isolated QA tables use RLS **without client-side policies on purpose** (default deny), and ordinary authenticated clients have no direct SELECT privilege. Server-side service-role functions enforce all access.
- The Stripe test card is valid **only in sandbox**. Never use it on the live `checkout.html` page.
- Test-only QA dashboard content is an **access gate preview**, not the full production service-business dashboard.
- No production test or real payment has been performed as part of this new Gatebrook QA flow.

## Verification completed

- QA database tables exist; RLS and forced RLS are on; `anon` and `authenticated` have no direct read access; `service_role` can read.
- Three QA functions are deployed in Supabase.
- Stripe accepted the exact `ui_mode=embedded_page` + seven-day trial parameters in sandbox and returned a `cs_test_...` session with client secret, with $0 due.
- `tests/qa-isolation.test.cjs`: **12/12 mock/static checks passed**.
- `tests/checkout-flow.test.cjs`: **12/12 mock/static checks passed**.
- Live Stripe product, prices and existing subscription records were not modified.
- **Pending:** actual in-page QA checkout, signed test webhook delivery, access-unlock verification, trial renewal and cancellation behavior.

Run source checks with Node.js 20+:

```bash
node --test tests/qa-isolation.test.cjs tests/checkout-flow.test.cjs
```

## After first connected test

Verify failed/declined simulated payments, trial expiry (Stripe test clocks), paid-period cancellation, duplicate webhooks and access expiry. Then test the real production dashboard flow in a fully separate staging project before public launch. Review Stripe's [subscription tax guidance](https://docs.stripe.com/billing/taxes/collect-taxes) and tax registration requirements before enabling automatic collection on live billing.

## Remaining separate production security findings

Supabase's security advisor reports unrelated existing warnings: public `SECURITY DEFINER` function access and leaked-password protection disabled. These weren't changed for QA; review them before launch: https://supabase.com/docs/guides/database/database-linter.


## 2026-10-29 — isolated failed-payment sandbox test

- Created an independent **Stripe Gatebrook QA sandbox-only** customer (no email) and an independent $149/month subscription with Stripe's `pm_card_chargeCustomerFail` payment method. This fixture is intentionally **not connected** to the J&J Plumbing QA workspace.
- Stripe attempted the first $149 invoice once, collected **$0**, left invoice **open**, and subscription **incomplete**.
- The signed `invoice.payment_failed` event (`evt_1UW4CVH6B0zVSPUK1zoWluY4`) completed delivery to the QA webhook. QA webhook correctly did not activate an unrelated workspace.
- The preexisting QA workspace remained **active** and scheduled to cancel at its paid period end. The production subscription was unchanged.
- Found and corrected a **production webhook compatibility bug**: invoices from Stripe's newer API shape use `parent.subscription_details.subscription`, not necessarily top-level `invoice.subscription`. Deployed production `gatebrook-stripe-webhook` version 12 with modern/legacy invoice resolution for both `invoice.paid` and `invoice.payment_failed`, plus a live-mode event guard. No live event or payment was generated.
- Added `tests/stripe-invoice-webhook.test.cjs`; **9/9** tests passed using the sandbox-observed invoice shape and validating that unpaid/incomplete/past-due/canceled states fail the access predicate.

**Still pending:** a failed **renewal** of a previously active, mapped QA workspace, followed by payment-method recovery and verified dashboard restoration. The independent fixture proves the processor decline and webhook delivery, but does not constitute that full app-level recovery test. It must be performed using a separate approved QA workspace/account so the existing scheduled-cancellation test remains untouched.
