# Custom Request Pages — v1 implementation notes

This PR introduces the storage and safe public contract for customizable Gatebrook request forms.

- Each business can select a starting template and configure a title, description, submit label, and up to 20 custom fields.
- A public function returns only the published form definition by the existing business slug.
- Custom answers are stored separately from `leads` so existing standard fields and historic data remain compatible.
- Public writes are not granted. Only the existing protected `submit-lead` Edge Function should validate and persist custom answers after Turnstile verification.
- `business_request_forms` is owner-managed with tenant-aware RLS. `lead_custom_answers` is scoped by business membership.
- Request links remain `request.html?b=<existing-slug>`; no URLs need to change.

## Next code integration steps
1. In `settings.html`, add a Request Page section with template presets, editable field rows, and a preview.
2. In `request.html`, call `gatebrook_get_public_request_form(slug)` and render configured fields safely using DOM APIs.
3. Include custom answers in the submission payload. Update the protected `submit-lead` Edge Function to validate against the server-stored definition, save the standard lead through `gatebrook_receive_request`, and persist answers only for a newly accepted lead. Ignore untrusted client field definitions.
4. In `dashboard.html`, fetch/display `lead_custom_answers` for each business's leads.
5. Mirror final public UI changes into `v1-preview/` and test legacy submissions / old form definitions.
6. Apply the additive migration, deploy Edge Function changes, and verify live request flow before declaring production complete.

The migration was written additively; it does not drop or rewrite existing tables or columns.
