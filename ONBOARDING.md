# FlowOS sellable-v1 onboarding

After the [Gatebrook domain cutover](DOMAIN-SETUP.md), open the dedicated [Admin console](https://gatebrook.work/admin.html) and sign in with a platform administrator account. The [existing preview console](https://flowos-web.github.io/flowos-v01/v1-preview/admin.html) is retained. Owning a business alone does not grant this privilege.

Enrollments is the default view. It shows every active business, including businesses created before self-service onboarding. Search by business name or request-page name, filter active/inactive/all, and select View business to inspect its profile, services, owner access, and customer requests directly as an administrator. These views do not require the owner's password or add the administrator to the business's owner memberships. Business detail URLs can be bookmarked with `?business_id=<uuid>`.

Owner setup recovery is available from the saved enrollment whenever the owner still needs an invitation or has not saved a first password. You do not need the original one-time token or the original browser tab. A confirmed owner with a password already has an account and uses existing credentials. The console does not generate reset/sign-in tokens for those existing active owners.

Select New business to provision another enrollment:

1. Enter the business name, unique request-page name, public profile, owner sign-in email, notification email, and 1–20 initial services.
2. Create the business. The server creates its private business record, public profile, active services, and owner membership in one database transaction.
3. Copy the public customer request link. Give a new owner the private one-time setup link through a trusted channel; the owner verifies it and chooses a password. This operation generates a link and does not send email automatically.
4. Share the business-specific dashboard link. Confirmed existing owners sign in with their existing credentials. They are never assigned an administrator-chosen password.

Keep the form unchanged to retry an interrupted request. Its request ID is retained for that tab, and completed requests return the same business. Changing the form starts a new request. A taken request-page name returns a conflict. After successful provisioning, Generate setup link can reissue an unconfirmed owner's invitation. If verification was completed before the first password was saved, recovery is allowed only for the recorded onboarding account that still has no password. Once a password exists, this endpoint cannot generate credential tokens for that owner.

## Security and deployment

The deployed Supabase project is `mxyikhxpzijrdrgowmxr`. `flowos-admin-onboarding` verifies the caller with Auth, requires an active platform administrator in `flowos_private.platform_admins`, and validates the live Auth session. Browser roles have no access to that private schema and cannot execute the provisioning RPCs or write `business_users` memberships. Authorization does not use user-editable metadata. Service credentials remain in Edge Function secrets.

`supabase/schema/admin_onboarding.sql` is the final additive schema source. Remote migration history records `admin_only_onboarding` and `onboarding_passwordless_setup_recovery`. Administrator bootstrap is deliberately separate from the generic schema; grant an explicitly approved existing account through a trusted database connection:

```sql
insert into flowos_private.platform_admins(user_id)
select id from auth.users where lower(email)=lower('<approved-admin-email>') and deleted_at is null
on conflict (user_id) do update set active=true;
```

To revoke provisioning access, set that allowlist row's `active` to false. This does not change the account's business memberships. Never grant admin access from a public page, signup form, or user metadata.

The original tenant policies remain in place. Public profiles and active service choices remain readable; leads and private business settings stay tenant-scoped. The console's enrollment and lead reads go through the authenticated server endpoint and service-only RPCs from `supabase/schema/admin_console.sql` (remote migration `dedicated_admin_business_console`). Ordinary browser clients, including administrators, cannot call those privileged RPCs directly. Owner setup generation also checks the business's current active state, current owner membership, and current Auth account state on the server. Direct client lead insertion remains denied. `submit-lead` continues to require Turnstile, an active business, and a service belonging to that business. Its verified-token hostname allowlist accepts only `gatebrook.work` and `flowos-web.github.io`; its notification delivery is unchanged. The unused standalone `notify-new-lead` endpoint requires server service-role authorization so public keys cannot send unsolicited notification emails.

Auth invitation creation and tenant SQL cannot share one transaction. If Auth creates an unconfirmed account and SQL then fails, the setup token is withheld. A retry reuses that account. The server does not automatically delete an account that another request could already be using.

The sellable-v1 build has been merged into `main`. Production pages live at the repository root, and the existing `v1-preview/` pages remain available. The domain compatibility release updates both admin pages so either can verify canonical Gatebrook and legacy setup links. Onboarding accepts only the exact HTTPS Gatebrook and GitHub browser origins and emits canonical Gatebrook root links. Function configuration is in `supabase/config.toml`; both administrator provisioning and the standalone notification endpoint require JWT verification. The public submission endpoint continues to authenticate its requests with Turnstile. Follow `DOMAIN-SETUP.md` for the external settings and release order; preparing source does not configure the domain.

## Lead email setup

Customer requests are saved before notification emails are attempted. A saved request remains available in the owner dashboard and Admin console even if email sending fails. The request page checks `customer_confirmation_sent` and reports a confirmation-email failure without asking the customer to submit again. A successful send flag means the email provider accepted the message; it does not guarantee inbox delivery.

Production request notifications now use `Gatebrook <requests@notifications.gatebrook.work>`. The sending subdomain is verified in Resend, its three DNS records are configured in Porkbun, and `FROM_EMAIL` is saved in Supabase. A controlled demo request confirmed both customer and business notifications: Resend reported both delivered, and the user confirmed both arrived. This configures request notifications; it does not configure Supabase Auth mail or a receiving support inbox. Email template text still uses the FlowOS working name.

To configure or change the sending domain:

1. Add a domain you own in [Resend Domains](https://resend.com/domains), and add the DNS records Resend provides to your domain's DNS host.
2. Wait for the domain's sending status to be verified.
3. Set the Supabase Edge Function secret `FROM_EMAIL` to a sender on the exact domain verified in Resend. The current value is `Gatebrook <requests@notifications.gatebrook.work>`. Keep `RESEND_API_KEY` private. Changing an owner's notification address does not configure the sender. No sender code change or function redeployment is needed for this setting; it does not configure Supabase Auth's separate mail transport.
4. Send an explicitly authorized test request and check both provider acceptance and the receiving inbox. Previously failed notifications are not automatically resent.

Domain verification is included in [Resend's Free plan](https://resend.com/pricing). A domain must be owned and its DNS editable; Gmail addresses and the shared GitHub Pages hostname cannot be verified as FlowOS domains. See [Resend's testing-sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain) and [domain setup](https://resend.com/docs/add-a-domain).

## Existing-account password recovery

The business sign-in page links to `forgot-password.html`. It calls Supabase Auth `resetPasswordForEmail` and sends users to the canonical `https://gatebrook.work/reset-password.html` page. The reset page scrubs recovery parameters from the address bar before loading remote assets, accepts the supported recovery-session formats, verifies the active user session, and changes only that authenticated user's password with `updateUser`. Passwords and recovery tokens are not logged.

Before relying on this flow in production:

1. In **Supabase Dashboard → Authentication → URL Configuration → Redirect URLs**, add the exact URL `https://gatebrook.work/reset-password.html`. Keep the project's Site URL set to `https://gatebrook.work`.
2. In **Authentication → Email Templates → Reset Password**, keep the standard secure confirmation link (`{{ .ConfirmationURL }}`) unless you deliberately configure an equivalent custom flow.
3. Confirm Auth email delivery separately from the Resend request-notification sender. The existing Resend configuration for customer/business request notifications does not automatically configure Supabase Auth recovery emails.
4. Test with an account you control: request a link, use the newest email, set a new password, sign in again, and verify that an expired link gives a safe recovery message. Do not test by changing a real business owner's password without their authorization.

The project documentation currently notes that leaked-password protection is disabled in Supabase Auth; review and enable that protection before a broad public launch.

## Verification

- `node --test supabase/functions/flowos-admin-onboarding/handler.test.ts`: offline authentication, authorization, validation, retries, existing-owner protection, and interrupted-setup recovery tests.
- `node --test tests/admin-domain.test.cjs tests/submit-lead-domain.test.cjs`: offline execution of the real setup-link validators and submission handler with fixture-only DOM, database and network adapters. Covers trusted and lookalike domains, exact activation paths, token verification, inactive businesses and unavailable services.
- `tests/onboarding-rls.sql`: real database provisioning and isolation checks, all rolled back. It dynamically uses two existing test-capable accounts and calls no email API.
- `tests/admin-console-rls.sql`: real database checks for administrator enrollment reads, filters, pagination, scoped lead access, owner recovery eligibility, and unchanged tenant/browser permissions, all rolled back.
- Browser checks cover signed-out/nonadmin access, retries, tenant links, explicit invite/recovery verification, password authorization, and desktop/mobile layout.
- Live access checks confirm anonymous provisioning and public notification calls are rejected, provisioning RPCs are inaccessible to public clients, the public profile still loads, and submissions still require Turnstile.

The existing Supabase Auth setting for leaked-password protection remains disabled. It can be managed in [Auth password security](https://supabase.com/dashboard/project/mxyikhxpzijrdrgowmxr/auth/providers). See [Supabase's password-security documentation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
