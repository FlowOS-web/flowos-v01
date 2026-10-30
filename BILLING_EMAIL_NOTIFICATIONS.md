# Gatebrook subscription lifecycle emails

Implemented: October 29, 2026. Production and Stripe QA are intentionally separate.

## Status

- **Live billing email dispatcher:** Deployed as Supabase Edge Function `gatebrook-billing-email-dispatch`.
- **Scheduler:** `cron.job` entry `gatebrook-billing-email-dispatch`, every 10 minutes.
- **Sender:** Existing Resend `RESEND_API_KEY` and verified `FROM_EMAIL` Supabase secrets; optional `BILLING_FROM_EMAIL` overrides the sender.
- **Data:** Production `public.gatebrook_subscriptions` and `businesses`, confirmed billing user from `auth.users`; **never** the Gatebrook QA subscription table.
- **Email journal:** `gatebrook_billing_email_jobs`; previous-state tracking in `gatebrook_billing_email_state`; both service-role only.
- **QA previews:** `gatebrook-billing-email-preview`, available to an approved, signed-in tester via [QA Dashboard](https://gatebrook.work/qa-dashboard.html).
- **Automatic scheduler health:** An authenticated private Postgres HTTP invocation returned HTTP 200 with `scanned:0`, `claimed:0`, `errors:0`. Production currently has zero active subscriptions.
- **Provider delivery:** **Not yet verified for the new billing templates.** The first QA email must be sent via the dashboard preview control; accepted responses are recorded in `gatebrook_billing_email_previews`.

## Email sequence

| Type | Trigger | Example subject |
|---|---|---|
| Trial welcome | First observed active trial, early in seven-day period | Your Gatebrook 7-day trial is active |
| 3-day reminder | Around 72 hours before trial end | Your Gatebrook trial ends in 3 days |
| 1-day reminder | Around 24 hours before trial end | Reminder: your Gatebrook trial ends in 1 day |
| Trial conversion | Trial becomes active paid plan **and Stripe invoice is paid** | Your Gatebrook trial ended — subscription active |
| Access expired | Stripe status becomes canceled, paused, unpaid, or past due | Your Gatebrook access has ended |
| Reactivated | Inactive subscription becomes trialing or active, including a replacement Stripe subscription | Your Gatebrook subscription has been reactivated |

Polling runs every 10 minutes. Pending reminder messages are sent only within a 12-hour window starting at the intended due time, while the trial is still active and **not set to cancel at trial end**. Outdated reminders are skipped. For time-sensitive legal notices, no email workflow can replace showing clear trial dates, billing terms, and cancellation instructions at checkout.

If a canceled trial turns into an active paid subscription, the system sends the conversion notice, not a misleading access-expired notice. If access truly ends, it sends the access-ended email and offers reactivation.

All templates include the actual plan price ($149/month or $1,490/year), trial end time in **UTC**, a Billing link for management/cancellation, a plain-text fallback, and HTML escaping of business names.

## How it works

1. Stripe's signed production webhook updates `gatebrook_subscriptions`. Existing webhook and production billing functionality have not been replaced.
2. Supabase Cron invokes the worker every 10 minutes through a private HTTP token generated and retained inside `flowos_private`. The token is **not** committed to GitHub or exposed to browsers.
3. The worker observes the subscription's current status and queues only valid lifecycle notifications. A unique `subscription_id/kind/cycle` constraint prevents repeat scheduling.
4. Claiming delivery jobs uses `FOR UPDATE SKIP LOCKED`, and Resend receives a stable `Idempotency-Key` to protect against duplicate sends.
5. Immediately before sending, the worker retrieves the subscription from **Stripe Live** and verifies `livemode:true`, metadata ownership, local status and subscription identity. It skips canceled or stale reminders and unverified recipients.
6. Resend accepts the email. The job then records the Resend email ID and sent/failed status. Transient failures are retried with exponential backoff, with a maximum of six attempts. "Sent" means accepted by Resend, not necessarily delivered to the inbox.

## First delivery verification

1. Sign in with the existing approved Gatebrook QA tester account.
2. Open [QA Dashboard](https://gatebrook.work/qa-dashboard.html).
3. Under **Preview your billing emails**, select an email template, then click **Send test email**. All test-email buttons and footers say **View QA dashboard** and point to `https://gatebrook.work/qa-dashboard.html` rather than live `billing.html`; the original production templates still point to live Billing. Previously sent emails do not change after a fix.
4. This sends only to the signed-in tester's **confirmed** email. It does **not** create a new subscription, change trial dates, or charge money.
5. Check the email's appearance and links in the inbox/spam folder. The preview includes a prominent TEST PREVIEW banner and test subject line.
6. In Supabase, verify the preview journal has `status='sent'` and a `resend_email_id`. Confirm inbox delivery separately.

You can preview each of the six templates once per UTC day. A preview is rate-limited, requires a valid Auth session and a tester allowlist entry, and never lets the caller choose another recipient.

## Monitoring

Use [Supabase Cron](https://supabase.com/dashboard/project/mxyikhxpzijrdrgowmxr/integrations/cron) and [Edge Function logs](https://supabase.com/dashboard/project/mxyikhxpzijrdrgowmxr/functions) to inspect scheduled invocations.

Example read-only SQL:
```sql
select kind,status,attempts,sent_at,resend_email_id,last_error,created_at
from public.gatebrook_billing_email_jobs
order by created_at desc limit 30;

select kind,status,resend_email_id,created_at
from public.gatebrook_billing_email_previews
order by created_at desc limit 20;
```

## Configuration and cautions

- Production sender is already expected to be verified for lead notifications; `BILLING_FROM_EMAIL` is **optional**. If set, it must be an allowed sender on the verified Resend domain.
- Do **not** put `RESEND_API_KEY`, Stripe keys, service-role keys or the cron token into GitHub or frontend code.
- Do **not** use test Stripe subscriptions to send production lifecycle email; they are excluded by the worker's database and `livemode` checks.
- The worker does not permit manually chosen recipients. The QA preview only targets the authenticated tester's confirmed login address.
- Stripe's [automatic trial reminders](https://dashboard.stripe.com/settings/billing/automatic) are a **separate** feature. If enabled alongside Gatebrook's custom reminders, customers may receive duplicates. Verify that setting and choose whether Stripe or Gatebrook should own the trial notifications before launch.
- Stripe-hosted trial reminder emails do not send in sandbox; the QA preview tests our **Resend** templates independently.
- The new email routine depends on reliable Stripe webhook state updates and confirmed Auth email addresses.
- The [Stripe Tax setup for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes) should be reviewed before real customers pay; do not enable automatic tax without checking registrations.
- [Supabase Cron reference](https://supabase.com/docs/guides/cron) and [Resend idempotency guide](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Completed checks

- Six HTML/plain-text templates rendered with business-name escaping and cancellation language.
- Seventeen mock/static tests cover scheduling windows, state transitions, reactivations with new subscriptions, auth/ownership checks and sender restrictions.
- Cron installed and active at 10-minute intervals; private dispatcher call returned HTTP 200.
- Both Edge Functions deployed and active; database read privileges deny direct browser access.
- No production email delivery has been claimed or simulated as confirmed. **Send a QA preview** before treating delivery as verified.
