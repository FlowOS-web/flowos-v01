# FlowOS sellable-v1 onboarding

Open the dedicated [Admin console](https://flowos-web.github.io/flowos-v01/v1-preview/admin.html) and sign in with a platform administrator account. Owning a business alone does not grant this privilege.

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

The original tenant policies remain in place. Public profiles and active service choices remain readable; leads and private business settings stay tenant-scoped. The console's enrollment and lead reads go through the authenticated server endpoint and service-only RPCs from `supabase/schema/admin_console.sql` (remote migration `dedicated_admin_business_console`). Ordinary browser clients, including administrators, cannot call those privileged RPCs directly. Owner setup generation also checks the business's current active state, current owner membership, and current Auth account state on the server. Direct client lead insertion remains denied. `submit-lead` is unchanged and continues to require Turnstile, an active business, and a service belonging to that business. Its own notification delivery is unchanged. The unused standalone `notify-new-lead` endpoint now requires server service-role authorization so public keys cannot send unsolicited notification emails.

Auth invitation creation and tenant SQL cannot share one transaction. If Auth creates an unconfirmed account and SQL then fails, the setup token is withheld. A retry reuses that account. The server does not automatically delete an account that another request could already be using.

Source changes live on `sellable-v1`. Publishing copies changed HTML files only into `main/v1-preview/`; production root pages are preserved. Function configuration is in `supabase/config.toml`; both administrator provisioning and the standalone notification endpoint require JWT verification. The public submission endpoint continues to authenticate its requests with Turnstile.

## Verification

- `node --test supabase/functions/flowos-admin-onboarding/handler.test.ts`: offline authentication, authorization, validation, retries, existing-owner protection, and interrupted-setup recovery tests.
- `tests/onboarding-rls.sql`: real database provisioning and isolation checks, all rolled back. It dynamically uses two existing test-capable accounts and calls no email API.
- `tests/admin-console-rls.sql`: real database checks for administrator enrollment reads, filters, pagination, scoped lead access, owner recovery eligibility, and unchanged tenant/browser permissions, all rolled back.
- Browser checks cover signed-out/nonadmin access, retries, tenant links, explicit invite/recovery verification, password authorization, and desktop/mobile layout.
- Live access checks confirm anonymous provisioning and public notification calls are rejected, provisioning RPCs are inaccessible to public clients, the public profile still loads, and submissions still require Turnstile.

The existing Supabase Auth setting for leaked-password protection remains disabled. It can be managed in [Auth password security](https://supabase.com/dashboard/project/mxyikhxpzijrdrgowmxr/auth/providers). See [Supabase's password-security documentation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
