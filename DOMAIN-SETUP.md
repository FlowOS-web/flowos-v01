# Gatebrook custom-domain release

This source release prepares the existing FlowOS application for https://gatebrook.work. It does not register, configure or verify DNS, deploy functions, change Auth settings, send emails or publish the site by itself. Customer data, business memberships and RLS policies require no migration.

## Compatibility

- Root pages will use https://gatebrook.work after the GitHub Pages cutover. Keep every existing v1-preview page; relative navigation continues to work within either directory.
- Administrator CORS permits exactly https://gatebrook.work and https://flowos-web.github.io. Current user, administrator and live-session authorization still applies.
- Public submission verifies Turnstile tokens against exactly gatebrook.work or flowos-web.github.io, then checks the active business and its active service before saving.
- Newly generated onboarding links use the Gatebrook root. Root and preview admin pages accept only the explicit activation pages on the two trusted origins, with no URL credentials or query string and with the existing token, type and business checks.
- Browser sessions are origin-specific. Owners and administrators may need to sign in again on the new domain. Do not transfer access tokens through links.
- Previously shared GitHub links must still resolve after GitHub's redirect. Verify their query strings and activation fragments survive; retaining files alone does not establish redirect compatibility.

The public submission source was downloaded from deployed submit-lead version 5 before this release. Its only behavioral change is expanding the exact verified Turnstile hostname allowlist to include gatebrook.work. Sender configuration, validation, tenant checks, lead storage and email behavior are preserved.

## External release checklist

Email setup is complete: `notifications.gatebrook.work` is verified in Resend, its required records are saved in Porkbun, and Supabase's `FROM_EMAIL` is `Gatebrook <requests@notifications.gatebrook.work>`. A controlled request confirmed both notification emails arrived. Website hosting, widget hostname configuration and function domain changes remain pending until the release steps below are completed.

1. Publish the compatible root and v1-preview/admin.html pages before deploying the onboarding function that generates Gatebrook links. Preserve all other preview pages and existing production files.
2. Add gatebrook.work to the existing Cloudflare Turnstile widget, retaining flowos-web.github.io. Deploy submit-lead with verify_jwt=false as before; its own Turnstile and tenant checks remain mandatory.
3. Verify domain ownership for GitHub Pages where available. Set the repository Pages custom domain to gatebrook.work before directing DNS to GitHub. For branch-based publishing, preserve the CNAME file GitHub creates in the publishing root. For an Actions publishing workflow, check the repository setting instead; CNAME is not used by that workflow.
4. At the registrar, point the apex to GitHub Pages using its documented A records or supported ALIAS/ANAME configuration. Configure www as a CNAME to flowos-web.github.io if using that redirect. Replace only conflicting website parking records; preserve Resend/mail records and verification TXT records.
5. Wait for DNS and GitHub's certificate, then enable Enforce HTTPS. Check https://gatebrook.work/ and its preview pages before deploying canonical onboarding URLs. GitHub notes DNS and certificate readiness can take up to a day.
6. Deploy flowos-admin-onboarding with JWT verification enabled once Gatebrook HTTPS is ready. This enables the exact new browser origin and canonical root links while retaining legacy-origin support.
7. Review Supabase Auth Site URL and redirect allowlist for the new canonical site, retaining any existing URLs still used. Current password sign-in and custom token-hash activation do not require an OAuth redirect; future Auth email/OAuth flows do. Use exact production URLs rather than broad wildcards.
8. Once Resend reports the chosen sending domain verified, set the Edge Function FROM_EMAIL setting to an address on that domain. Keep RESEND_API_KEY private. This configures request notifications, not Supabase Auth SMTP or a receiving support inbox. No code change is needed for the sender setting.
9. Verify signed-out/nonadmin denial, owner sign-in, admin enrollment reads, new and legacy request links, setup URL validation, preview navigation and old GitHub deep-link redirects. Use controlled test records and recipients for live checks; the offline tests create no real account, lead or email.

Keep Gatebrook's primary domain pointed to the original repository; changing the repository name is unnecessary. Do not remove the preview folder or relax tenant policies to solve a domain error. Changing the domain does not finish the current contact/legal placeholders or rename all FlowOS text.

## Offline checks

Run on Node.js 24 or newer from the repository root:

    node --test supabase/functions/flowos-admin-onboarding/handler.test.ts tests/admin-domain.test.cjs tests/submit-lead-domain.test.cjs

The tests use fixture-only adapters. They do not access live Auth, customer data, Turnstile or email services.

## Official references

- [GitHub Pages custom domains and DNS](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Turnstile hostname management](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
- [Supabase Auth redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase Edge Function environment variables](https://supabase.com/docs/guides/functions/secrets)
- [Resend domain verification](https://resend.com/docs/add-a-domain)

