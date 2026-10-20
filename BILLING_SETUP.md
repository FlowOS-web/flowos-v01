# Gatebrook billing setup

Create a Stripe product named Gatebrook with recurring prices of USD 149 monthly and USD 1,490 annually. The seven-day trial should use the monthly recurring price with a seven-day subscription trial and payment method collection.

Set these Supabase Edge Function secrets; never put them in browser code or Git:
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_MONTHLY
- STRIPE_PRICE_ANNUAL

Configure a Stripe webhook for checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, and invoice.payment_failed. Verify webhook signatures. Only verified webhook events should activate or revoke subscription access.

Before launch, implement and test authenticated, server-side business provisioning; subscription persistence; idempotent checkout and webhook handling; dashboard/data access gating; cancellation and failed-payment handling; and Stripe test-mode scenarios. The Stripe account was reported empty, and no Stripe credentials or price IDs have been configured. Do not represent billing as live until configuration and end-to-end tests are complete.