-- Gatebrook customizable request pages (v1)
-- Per-business configuration for templates, branded page copy, and custom fields.
-- Existing standard lead fields remain authoritative; custom responses are stored separately.
create table if not exists public.business_request_forms (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  template_key text not null default 'general'
    check (template_key in ('general','cleaning','plumbing','auto_detailing','landscaping','photography')),
  page_title text not null default 'Request a Service'
    check (char_length(page_title) between 1 and 120),
  page_description text not null default 'Tell us what you need and we will follow up.'
    check (char_length(page_description) <= 500),
  submit_label text not null default 'Submit Request'
    check (char_length(submit_label) between 1 and 40),
  fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(fields) = 'array' and jsonb_array_length(fields) <= 20),
  updated_at timestamptz not null default now(),
  constraint business_request_forms_fields_size check (pg_column_size(fields) <= 16384)
);
alter table public.business_request_forms enable row level security;
revoke all on public.business_request_forms from anon, authenticated;
grant select, insert, update on public.business_request_forms to authenticated;
drop policy if exists business_request_forms_owner_manage on public.business_request_forms;
create policy business_request_forms_owner_manage
on public.business_request_forms
for all to authenticated
using (exists (
  select 1 from public.business_users bu
  where bu.business_id = business_request_forms.business_id
    and bu.user_id = (select auth.uid()) and bu.role = 'owner'
))
with check (exists (
  select 1 from public.business_users bu
  where bu.business_id = business_request_forms.business_id
    and bu.user_id = (select auth.uid()) and bu.role = 'owner'
));

-- Publish only the fields safe for the public request page. Every tenant is looked up by
-- the existing public slug; owner-only controls remain enforced by table RLS.
create or replace function public.gatebrook_get_public_request_form(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'template_key', coalesce(f.template_key, 'general'),
    'page_title', coalesce(f.page_title, 'Request a Service'),
    'page_description', coalesce(f.page_description, nullif(p.tagline, ''), 'Tell us what you need and we will follow up.'),
    'submit_label', coalesce(f.submit_label, 'Submit Request'),
    'fields', coalesce(f.fields, '[]'::jsonb)
  )
  from public.business_public_profiles p
  left join public.business_request_forms f on f.business_id = p.business_id
  where p.slug = p_slug and p.active = true
  limit 1;
$$;
revoke all on function public.gatebrook_get_public_request_form(text) from public, anon, authenticated;
grant execute on function public.gatebrook_get_public_request_form(text) to anon, authenticated;

-- Validate every configured field in a single server-side path before storing submissions.
create or replace function public.gatebrook_validate_request_fields(p_fields jsonb, p_answers jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field jsonb;
  v_id text;
  v_type text;
  v_value jsonb;
  v_options jsonb;
  v_str text;
begin
  if jsonb_typeof(coalesce(p_fields,'[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_answers,'{}'::jsonb)) <> 'object'
     or jsonb_array_length(coalesce(p_fields,'[]'::jsonb)) > 20
     or pg_column_size(coalesce(p_answers,'{}'::jsonb)) > 16384 then
    return false;
  end if;
  for v_field in select value from jsonb_array_elements(coalesce(p_fields,'[]'::jsonb)) loop
    v_id := v_field->>'id';
    v_type := v_field->>'type';
    if v_id is null or v_id !~ '^[a-z][a-z0-9_]{0,39}$'
       or coalesce(length(v_field->>'label'),0) not between 1 and 80
       or v_type not in ('text','textarea','select','radio','checkbox','date','number') then
      return false;
    end if;
    v_value := p_answers -> v_id;
    if coalesce((v_field->>'required')::boolean,false)
       and (v_value is null or v_value = 'null'::jsonb or v_value = '""'::jsonb or v_value = '[]'::jsonb) then
      return false;
    end if;
    if v_value is null or v_value = 'null'::jsonb then continue; end if;
    if v_type in ('text','textarea','select','radio','date','number') then
      if jsonb_typeof(v_value) <> 'string' then return false; end if;
      v_str := v_value #>> '{}';
      if length(v_str) > case when v_type='textarea' then 2000 else 300 end then return false; end if;
      if v_type in ('select','radio') then
        v_options := v_field->'options';
        if jsonb_typeof(v_options) <> 'array' or not exists (
          select 1 from jsonb_array_elements_text(v_options) o where o=v_str
        ) then return false; end if;
      end if;
      if v_type='date' and v_str !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
      if v_type='number' and (v_str !~ '^-?\d+(\.\d{1,2})?$' or abs(v_str::numeric)>999999999) then return false; end if;
    elsif v_type='checkbox' then
      if jsonb_typeof(v_value) <> 'array' then return false; end if;
      v_options := v_field->'options';
      if jsonb_typeof(v_options) <> 'array' or exists (
        select 1 from jsonb_array_elements_text(v_value) answer
        where not exists (select 1 from jsonb_array_elements_text(v_options) option_value where option_value=answer)
      ) then return false; end if;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public.gatebrook_validate_request_fields(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.gatebrook_validate_request_fields(jsonb,jsonb) to service_role;

create table if not exists public.lead_custom_answers (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers)='object' and pg_column_size(answers)<=16384),
  created_at timestamptz not null default now()
);
create index if not exists lead_custom_answers_business_idx on public.lead_custom_answers(business_id, created_at desc);
alter table public.lead_custom_answers enable row level security;
revoke all on public.lead_custom_answers from anon, authenticated;
grant select, insert, update, delete on public.lead_custom_answers to authenticated;
drop policy if exists lead_custom_answers_owner_read on public.lead_custom_answers;
create policy lead_custom_answers_owner_read on public.lead_custom_answers
for select to authenticated using (exists (
  select 1 from public.business_users bu
  where bu.business_id=lead_custom_answers.business_id
    and bu.user_id=(select auth.uid()) and bu.role in ('owner','manager')
));
drop policy if exists lead_custom_answers_owner_write on public.lead_custom_answers;
create policy lead_custom_answers_owner_write on public.lead_custom_answers
for all to authenticated using (exists (
  select 1 from public.business_users bu
  where bu.business_id=lead_custom_answers.business_id
    and bu.user_id=(select auth.uid()) and bu.role='owner'
)) with check (exists (
  select 1 from public.business_users bu
  where bu.business_id=lead_custom_answers.business_id
    and bu.user_id=(select auth.uid()) and bu.role='owner'
));
