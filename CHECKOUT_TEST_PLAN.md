# Gatebrook checkout — zero-charge test kit

**Prepared:** 2026-10-29  
**Target:** a dedicated Stripe sandbox and a separate Gatebrook staging environment.  
**Status:** mock smoke tests prepared and exercised. Real Stripe sandbox checkout is **not yet connected**.

> SAFETY: Never enter a test card on `https://gatebrook.work/checkout.html` while that site uses Stripe Live keys. The real website currently points to the production Supabase project. Do not change production secrets to test values.

## What is already in place

- `tests/checkout-flow.test.cjs` has 12 zero-network checkout tests:
  - 7-day trial ($0 today, then $149/month).
  - $149 monthly and $1,490 annual plan summaries.
  - Embedding Stripe's payment UI with mock `pk_test_` credentials.
  - Missing embedded configuration offers an explicit hosted-checkout fallback, with no automatic redirect.
  - Legacy hosted-session responses do not automatically send customers away.
  - Unsigned-in customers cannot create a checkout session.
  - Stripe owns card-entry fields; Gatebrook doesn't collect the card number.
  - Server-side auth/plan/mode guards exist.
  - Webhook signature checks, subscription state, and database access enforcement remain in the backend.
- Run checks with **Node 20+**: `node --test tests/checkout-flow.test.cjs`.
- These are **mock/static smoke tests**, not real Stripe payments, real webhook deliveries, or complete end-to-end tests.

## Remaining setup: isolated live-simulation environment

1. **Stripe:** In the Stripe Dashboard account picker choose **Sandboxes → Create sandbox** (suggested name: `Gatebrook QA`). [Stripe sandbox documentation](https://docs.stripe.com/sandboxes/dashboard/manage). Do not choose a live account for tests. This separate sandbox has no real funds movement.
2. **Catalog:** In that sandbox, create a `Gatebrook QA` product and recurring **$149 USD monthly** and **$1,490 USD annual** prices. Copy its *test* Price IDs, or verify any copied prices are in the sandbox.
3. **Supabase:** Use a **separate project** (for example `gatebrook-qa`) for test users, test subscriptions and webhook deliveries. Do not alter live Supabase secrets. Creating a new Supabase project may have a cost/plan limit; check that before provisioning.
4. **Staging frontend:** Publish a separate hostname/origin (for example `qa.gatebrook.work`) with a **staging-specific Supabase URL and publishable key**. Never reuse the production project's client config. The current frontend hardcodes the production Supabase URL; copying it unchanged to staging is **not safe**.
5. **Edge functions:** Deploy copies of the current checkout, embedded checkout, Stripe webhook, access and billing-portal functions to staging. The current checkout functions hardcode the production `SITE` / allowed origins; **update those values in staging** before running any real test. Do not reuse live webhook signing secrets or Stripe keys.
6. **Staging secrets (no values in the repository or chat):** `STRIPE_SECRET_KEY` (sandbox `sk_test_`), `STRIPE_PUBLISHABLE_KEY` (matching sandbox `pk_test_`), `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, and `STRIPE_WEBHOOK_SECRET` from a webhook destination in the **same sandbox**, aimed at the **staging** webhook function. Ensure authentication redirect URLs also point to staging.
7. **Connect sandbox to ChatGPT:** After creating it, add that sandbox to the connected Stripe accounts so tests can be inspected from here. The current Stripe connection exposes only one **live** account; it cannot be used for test API calls.
8. **Release guard:** Before publishing staging, verify `pk_test_` and `sk_test_` are paired, staging calls only the staging Supabase project, Stripe sessions are `livemode:false`, and no page redirects to production.

## Real sandbox test cases and expected outcomes

| Case | Action | Expected result |
|---|---|---|
| Trial signup | Create a fresh staging account and choose 7-day free trial | Stripe test Checkout due today $0; subscription `trialing`; verified sandbox webhook activates **staging** dashboard |
| Trial expiration | Use a Stripe **test clock** to advance beyond 7 days | Sandbox invoice for $149 is generated; successful payment updates subscription and dashboard correctly |
| Monthly | Choose $149/month with a test card | Simulated $149 charge; active monthly subscription after signed webhook |
| Annual | Choose $1,490/year with a test card | Simulated $1,490 charge; correct annual recurrence |
| Declined card | Use Stripe's documented declined-payment test method | No paid access granted if payment fails |
| Cancel trial | Cancel before trial ends | No first paid invoice; access ends per cancellation policy |
| Cancel paid plan | Set cancel-at-period-end on a paid subscription | Access until paid period expires, then no access |
| Duplicate event | Deliver the same signed webhook event twice | Event is processed once; no duplicate subscriptions |
| Invalid signature | Deliver a webhook request with an invalid signature | HTTP 400; no database changes |
| Unauthenticated | Visit staging dashboard without a valid session | No business details or subscription access |
| Session retry | Reopen checkout without completing payment | No duplicate subscriptions or unexpected live Stripe redirect |

Stripe's successful Visa *test only* is `4242 4242 4242 4242`; use a future expiry and any 3-digit CVC. [Stripe testing](https://docs.stripe.com/testing). **Never use it in a live checkout**.

[Stripe test clocks](https://docs.stripe.com/billing/testing) simulate renewal/trial time without waiting days. Confirm asynchronous webhook deliveries have succeeded before judging staging access state.

## Stop/go criteria

- [x] Mock checkout cases written and exercised with no external payment calls.
- [ ] Stripe QA sandbox exists and is connected.
- [ ] Staging Supabase and site are isolated from production.
- [ ] Sandbox webhook endpoint is signed, configured, and observed delivering successful events.
- [ ] Trial, monthly, and annual checkouts succeed with sandbox credentials only.
- [ ] Failure, cancellation, event replay, expired trial, and direct URL access are tested.
- [ ] The remaining risk-side Stripe events and Stripe Tax obligations are reviewed before live launch.

**Nothing in this test kit creates a live Stripe customer, opens a real Checkout Session, charges a card, or modifies a production subscription.**

One more live-launch item: assess [Stripe Tax for subscription payments](https://docs.stripe.com/billing/taxes/collect-taxes) and applicable registrations before enabling automatic tax. Merely toggling a tax setting does not establish a registration.
