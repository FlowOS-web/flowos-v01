# Gatebrook live billing setup

## Product and prices

In Stripe **Live mode**, create one product named **Gatebrook** with these recurring USD prices:

- Monthly: **$149/month**.
- Annual: **$1,490/year**.
- The free trial is **7 days**, uses the monthly price, and requires a payment method at checkout. Stripe will charge $149/month after the trial unless the customer cancels before the trial ends. If no payment method remains at trial end, the subscription is configured to cancel.

Copy the two Price IDs (they begin with `price_`) from Live mode. Do not use test-mode Price IDs for live payments.

## Supabase Edge Function secrets

In the Supabase dashboard for project `mxyikhxpzijrdrgowmxr`, open **Edge Functions → Secrets** and set these server-side secrets:

- `STRIPE_SECRET_KEY`: Live secret key from Stripe (starts with `sk_live_`).
- `STRIPE_WEBHOOK_SECRET`: signing secret for the live webhook endpoint below (starts with `whsec_`).
- `STRIPE_PRICE_MONTHLY`: live monthly Price ID.
- `STRIPE_PRICE_ANNUAL`: live annual Price ID.

Never put these values in Git, HTML/JavaScript, browser storage, or chat. The Supabase service-role key is managed by the Supabase runtime; do not replace it with a publishable key. The deployed checkout function returns a configuration error until the Stripe secrets and both Price IDs exist.

## Embedded Gatebrook checkout (new)

Gatebrook now has a branded, responsive `checkout.html` page. Workspace Setup saves the current business details and chosen subscription plan in **sessionStorage** (never card details), then opens that page. Stripe.js displays the secure Stripe form inside Gatebrook; subscription activation still depends on the existing **verified Stripe webhook** and server-side access checks.

The new Supabase Edge Function **`gatebrook-embedded-checkout`** is deployed separately from `gatebrook-checkout` (which remains the operational Stripe-hosted fallback). It validates the authenticated user, the plan and business, and the Stripe key mode before creating a Checkout Session using Stripe's `ui_mode=embedded`. It returns only the Stripe Checkout Session `client_secret` and the **publishable** key for browser initialization; it never returns or embeds the Stripe secret key or service-role key. The frontend uses Stripe.js, not Gatebrook card fields.

**One additional setting is required before the embedded form works:**

1. In the Stripe Dashboard's Live mode, open **Developers → API keys** and copy the **publishable key** (starts with `pk_live_`). This is intentionally a browser-safe key; never use the live secret key here.
2. In Supabase project `mxyikhxpzijrdrgowmxr`, go to **Edge Functions → Secrets**. Add `STRIPE_PUBLISHABLE_KEY` with that publishable key.
3. Ensure `STRIPE_SECRET_KEY` and the publishable key belong to the same Stripe account and the same **live/test mode**.
4. Test a non-charge launch path first: ensure the form loads, displays the selected plan and trial, and that signing out blocks checkout. Validate a Stripe **test-mode** end-to-end purchase in a separate safe environment before any live transaction. Verify the signed webhook persisted activation, then check cancellations, failures and duplicates.

If the publishable key is not configured (or its mode differs from the secret key), the embedded function returns `embedded_unavailable` **before writing business or checkout records**. The page then offers the existing hosted checkout as a deliberate fallback. If a hosted Stripe session is already open for the account, it can be resumed. Errors **after** the new function has begun writing records do not automatically launch a second checkout.

Important: using an embedded form **does not override Stripe's public merchant name** or banking descriptors. Configure Stripe's public business/branding settings to show Gatebrook appropriately. Do not use this checkout as evidence that production billing is fully tested.

## Stripe webhook

Add a webhook destination in Stripe Live mode:

`https://mxyikhxpzijrdrgowmxr.supabase.co/functions/v1/gatebrook-stripe-webhook`

Subscribe to these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Copy the endpoint signing secret into `STRIPE_WEBHOOK_SECRET`. The webhook verifies Stripe's HMAC signature and timestamp before processing the raw request body. Subscription status is persisted server-side, and repeated event IDs are deduplicated.

## Deployed implementation

- `gatebrook-checkout`: validates the Supabase access token, derives the user ID from the verified session, saves an inactive business draft, and creates Stripe-hosted Checkout.
- `gatebrook-embedded-checkout`: creates Stripe embedded Checkout Sessions after authenticated server-side validation, with a publishable-key preflight and safe resumption of pre-existing sessions.
- `gatebrook-stripe-webhook`: verifies signed Stripe events and persists subscription/customer/trial/period/cancellation status.
- `gatebrook-access`: checks server-side subscription state for account routing and dashboard entry.
- `gatebrook-billing-portal`: creates an authenticated Stripe Customer Portal session so owners can manage billing without Gatebrook storing payment details.
- Database migrations create `gatebrook_subscriptions` and an event-deduplication table, plus RLS checks that prevent inactive/cancelled subscriptions from accessing dashboard data.
- `billing.html` does not activate accounts based on the Checkout success URL. It waits for server-verified access state.

## Launch verification checklist

Do not announce live billing until all steps below pass:

1. Confirm the product and both recurring prices are in **Live mode**.
2. Add all four secrets above in Supabase and verify they were saved without exposing their values.
3. Configure the webhook endpoint and its event list, then save the endpoint signing secret in Supabase.
4. In Stripe Billing → Customer portal, enable subscription cancellation and set cancellation to **at period end** (not immediately); enable payment method updates. Confirm the portal configuration uses the intended Live-mode configuration.
5. In a controlled real launch test, create a new account, enter business setup, and complete Stripe Checkout. Verify the subscription row, business activation, and dashboard access only after the signed webhook is processed.
6. Verify cancellation at period end retains access until Stripe's paid-period end, then removes access after the subscription-deleted/updated event.
7. Verify a failed payment does not grant new access, a forged/invalid webhook signature is rejected, duplicate webhook deliveries are idempotent, and a direct dashboard URL cannot bypass access checks.
8. Review Supabase RLS/security advisors and Stripe webhook delivery logs before opening sign-ups broadly.

The Stripe account previously had no products or prices configured. The functions and database enforcement are deployed, but live billing remains **not configured or end-to-end verified** until the secrets, Price IDs, webhook, and checks above are completed.