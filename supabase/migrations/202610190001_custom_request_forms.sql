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
          select 1 from jsonb_array_elements_text(v_options) as o(value) where o.value=v_str
        ) then return false; end if;
      end if;
      if v_type='date' and v_str !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
      if v_type='number' and (v_str !~ '^-?\d+(\.\d{1,2})?$' or abs(v_str::numeric)>999999999) then return false; end if;
    elsif v_type='checkbox' then
      if jsonb_typeof(v_value) <> 'array' then return false; end if;
      v_options := v_field->'options';
      if jsonb_typeof(v_options) <> 'array' or exists (
        select 1 from jsonb_array_elements_text(v_value) as answer(value)
        where not exists (select 1 from jsonb_array_elements_text(v_options) as option_value(value) where option_value.value=answer.value)
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
  field_definitions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(field_definitions)='array' and jsonb_array_length(field_definitions)<=20 and pg_column_size(field_definitions)<=16384),
  created_at timestamptz not null default now()
);
alter table public.lead_custom_answers
  add column if not exists field_definitions jsonb not null default '[]'::jsonb
  check (jsonb_typeof(field_definitions)='array' and jsonb_array_length(field_definitions)<=20 and pg_column_size(field_definitions)<=16384);
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


-- Preserve custom answers if a submission is held for the existing review flow.
alter table public.gatebrook_request_reviews
  add column if not exists custom_answers jsonb not null default '{}'::jsonb
  check (jsonb_typeof(custom_answers)='object' and pg_column_size(custom_answers)<=16384);
alter table public.gatebrook_request_reviews
  add column if not exists custom_field_definitions jsonb not null default '[]'::jsonb
  check (jsonb_typeof(custom_field_definitions)='array' and jsonb_array_length(custom_field_definitions)<=20 and pg_column_size(custom_field_definitions)<=16384);

-- Additive v2 intake RPC: the existing v1 signature remains available for old callers.
-- Standard lead insert, rate protection, review holding, and custom-answer persistence
-- all occur in the same database transaction.
create or replace function public.gatebrook_receive_request_custom(
  p_business_id uuid, p_contact_hash text, p_fingerprint text,
  p_customer_name text, p_phone text, p_email text, p_service text,
  p_preferred_date date, p_service_location text, p_notes text,
  p_answers jsonb
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_hour_count int;
  v_day_count int;
  v_business_hour_count int;
  v_business_pending_count int;
  v_last_at timestamptz;
  v_lead_id uuid;
  v_review_id uuid;
  v_reason text;
  v_disposition text;
  v_fields jsonb;
  v_answers jsonb := coalesce(p_answers, '{}'::jsonb);
begin
  if p_business_id is null or p_contact_hash is null or p_fingerprint is null
     or p_contact_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or length(trim(coalesce(p_customer_name,''))) < 2
     or length(trim(coalesce(p_service,''))) = 0
     or (coalesce(trim(p_phone),'')='' and coalesce(trim(p_email),'')='')
     or jsonb_typeof(v_answers) <> 'object'
     or pg_column_size(v_answers) > 16384
  then raise exception 'Invalid request details'; end if;

  if not exists (
    select 1 from public.businesses b where b.id=p_business_id and b.active=true
  ) or not exists (
    select 1 from public.business_services s
    where s.business_id=p_business_id and s.name=p_service and s.active=true
  ) then raise exception 'Business or service unavailable'; end if;

  select coalesce(f.fields,'[]'::jsonb) into v_fields
  from public.business_request_forms f where f.business_id=p_business_id;
  v_fields := coalesce(v_fields,'[]'::jsonb);
  if not public.gatebrook_validate_request_fields(v_fields,v_answers) then
    raise exception 'Invalid custom request answers';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text, 0));

  if exists (
    select 1 from public.gatebrook_request_events e
    where e.business_id=p_business_id and e.fingerprint=p_fingerprint
      and e.created_at>now()-interval '24 hours'
  ) then return jsonb_build_object('disposition','duplicate'); end if;

  select max(e.created_at),
    count(*) filter (where e.created_at>now()-interval '1 hour'),
    count(*)
  into v_last_at,v_hour_count,v_day_count
  from public.gatebrook_request_events e
  where e.business_id=p_business_id and e.contact_hash=p_contact_hash
    and e.created_at>now()-interval '24 hours';

  if v_last_at is not null and v_last_at>now()-interval '60 seconds' then
    return jsonb_build_object('disposition','cooldown',
      'retry_seconds',greatest(1,ceil(extract(epoch from
        (v_last_at+interval '60 seconds'-now())))::int));
  end if;

  select count(*) into v_business_hour_count
  from public.gatebrook_request_events e
  where e.business_id=p_business_id and e.created_at>now()-interval '1 hour';

  if v_hour_count>=9 or v_day_count>=25 or v_business_hour_count>=240 then
    return jsonb_build_object('disposition','limited','retry_seconds',3600);
  end if;

  v_disposition:=case when v_hour_count>=3 or v_business_hour_count>=120
    then 'pending' else 'accepted' end;

  if v_disposition='pending' then
    select count(*) into v_business_pending_count
    from public.gatebrook_request_reviews r where r.business_id=p_business_id and r.status='pending';
    if v_business_pending_count>=100 then
      return jsonb_build_object('disposition','limited','retry_seconds',3600);
    end if;
    v_reason:=case when v_hour_count>=3 then
      'More than 3 requests from this contact within 1 hour'
      else 'Unusually high request volume for this business' end;
    insert into public.gatebrook_request_reviews (
      business_id,customer_name,phone,email,service,preferred_date,
      service_location,notes,flagged_reason,custom_answers,custom_field_definitions
    ) values (
      p_business_id,p_customer_name,nullif(p_phone,''),nullif(p_email,''),
      p_service,p_preferred_date,nullif(p_service_location,''),nullif(p_notes,''),
      v_reason,v_answers,v_fields
    ) returning id into v_review_id;
  else
    insert into public.leads (
      business_id,customer_name,phone,email,vehicle,vehicle_type,service,
      preferred_date,service_location,notes,status,source
    ) values (
      p_business_id,p_customer_name,nullif(p_phone,''),nullif(p_email,''),
      null,null,p_service,p_preferred_date,nullif(p_service_location,''),
      nullif(p_notes,''),'new','website'
    ) returning id into v_lead_id;
    if v_answers <> '{}'::jsonb then
      insert into public.lead_custom_answers(lead_id,business_id,answers,field_definitions)
      values (v_lead_id,p_business_id,v_answers,v_fields);
    end if;
  end if;

  insert into public.gatebrook_request_events(business_id,contact_hash,fingerprint,disposition)
  values(p_business_id,p_contact_hash,p_fingerprint,v_disposition);

  if v_disposition='pending' then
    return jsonb_build_object('disposition','pending','review_id',v_review_id);
  end if;
  return jsonb_build_object('disposition','accepted','lead_id',v_lead_id);
end;
$$;
revoke all on function public.gatebrook_receive_request_custom(
  uuid,text,text,text,text,text,text,date,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.gatebrook_receive_request_custom(
  uuid,text,text,text,text,text,text,date,text,text,jsonb
) to service_role;

-- Promote held custom answers into the structured answer table when an owner approves.
create or replace function public.gatebrook_review_request(
  p_business_id uuid,p_review_id uuid,p_decision text
) returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  v_review public.gatebrook_request_reviews%rowtype;
  v_lead_id uuid;
begin
  if p_business_id is null or p_review_id is null or p_decision is null
    or p_decision not in ('approve','dismiss') then
    raise exception 'Invalid review decision';
  end if;
  if auth.uid() is null or not exists (
    select 1 from public.business_users bu
    where bu.user_id=auth.uid() and bu.business_id=p_business_id and bu.role='owner'
  ) then raise exception 'Not authorized for this business'; end if;

  select * into v_review from public.gatebrook_request_reviews r
  where r.id=p_review_id and r.business_id=p_business_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_review.status<>'pending' then
    return jsonb_build_object('disposition','already_reviewed','status',v_review.status);
  end if;

  if p_decision='approve' then
    insert into public.leads(
      business_id,customer_name,phone,email,vehicle,vehicle_type,service,
      preferred_date,service_location,notes,status,source
    ) values (
      v_review.business_id,v_review.customer_name,v_review.phone,
      v_review.email,null,null,v_review.service,v_review.preferred_date,
      v_review.service_location,v_review.notes,'new','website'
    ) returning id into v_lead_id;
    if coalesce(v_review.custom_answers,'{}'::jsonb) <> '{}'::jsonb then
      insert into public.lead_custom_answers(lead_id,business_id,answers,field_definitions)
      values(v_lead_id,p_business_id,v_review.custom_answers,v_review.custom_field_definitions);
    end if;
  end if;

  update public.gatebrook_request_reviews
  set status=case when p_decision='approve' then 'approved' else 'dismissed' end,
      approved_lead_id=v_lead_id,reviewed_at=now(),reviewed_by=auth.uid()
  where id=v_review.id;
  return jsonb_build_object(
    'disposition',case when p_decision='approve' then 'approved' else 'dismissed' end,
    'lead_id',v_lead_id);
end;
$$;
revoke all on function public.gatebrook_review_request(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gatebrook_review_request(uuid,uuid,text) to authenticated;
