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
- `gatebrook-stripe-webhook`: verifies signed Stripe events and persists subscription/customer/trial/period/cancellation status.
- `gatebrook-access`: checks server-side subscription state for account routing and dashboard entry.
- Database migrations create `gatebrook_subscriptions` and an event-deduplication table, plus RLS checks that prevent inactive/cancelled subscriptions from accessing dashboard data.
- `billing.html` does not activate accounts based on the Checkout success URL. It waits for server-verified access state.

## Launch verification checklist

Do not announce live billing until all steps below pass:

1. Confirm the product and both recurring prices are in **Live mode**.
2. Add all four secrets above in Supabase and verify they were saved without exposing their values.
3. Configure the webhook endpoint and its event list, then save the endpoint signing secret in Supabase.
4. In a controlled real launch test, create a new account, enter business setup, and complete Stripe Checkout. Verify the subscription row, business activation, and dashboard access only after the signed webhook is processed.
5. Verify cancellation at period end retains access until Stripe's paid-period end, then removes access after the subscription-deleted/updated event.
6. Verify a failed payment does not grant new access, a forged/invalid webhook signature is rejected, duplicate webhook deliveries are idempotent, and a direct dashboard URL cannot bypass access checks.
7. Review Supabase RLS/security advisors and Stripe webhook delivery logs before opening sign-ups broadly.

The Stripe account previously had no products or prices configured. The functions and database enforcement are deployed, but live billing remains **not configured or end-to-end verified** until the secrets, Price IDs, webhook, and checks above are completed.