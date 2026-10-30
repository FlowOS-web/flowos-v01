-- Additive configuration for Gatebrook request-page standard fields.
-- Mandatory name, usable contact method and service cannot be hidden.
alter table public.business_request_forms
  add column if not exists core_fields jsonb not null default '{}'::jsonb;

alter table public.business_request_forms
  add constraint business_request_forms_core_fields_valid
  check (jsonb_typeof(core_fields) = 'object' and pg_column_size(core_fields) <= 2048);

-- Preserve the original entitlement guard and omit all private attributes.
create or replace function public.gatebrook_get_public_request_form(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'template_key', coalesce(f.template_key, 'general'),
    'page_title', coalesce(f.page_title, 'Request a Service'),
    'page_description', coalesce(nullif(p.tagline, ''), 'Tell us what you need and we will follow up.'),
    'submit_label', coalesce(f.submit_label, 'Submit Request'),
    'fields', coalesce(f.fields, '[]'::jsonb),
    'core_fields', coalesce(f.core_fields, '{}'::jsonb)
  )
  from public.business_public_profiles p
  left join public.business_request_forms f on f.business_id = p.business_id
  where p.slug = p_slug and p.active = true
    and flowos_private.gatebrook_business_has_access(p.business_id)
  limit 1;
$function$;
