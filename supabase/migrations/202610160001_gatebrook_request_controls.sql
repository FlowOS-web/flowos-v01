-- Gatebrook request controls (v1). Public requests are accepted only through the
-- Turnstile-validated Edge Function with a service-role client.
-- Rate limiting is contact+business based; no user IPs are collected or used
-- to block households/offices/cellular networks on a shared address.
create table if not exists public.gatebrook_request_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  contact_hash text not null check (contact_hash ~ '^[a-f0-9]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  disposition text not null check (disposition in ('accepted','pending')),
  created_at timestamptz not null default now()
);
create index if not exists gatebrook_request_events_contact_window_idx
  on public.gatebrook_request_events (business_id,contact_hash,created_at desc);
create index if not exists gatebrook_request_events_fingerprint_idx
  on public.gatebrook_request_events (business_id,fingerprint,created_at desc);
create index if not exists gatebrook_request_events_business_window_idx
  on public.gatebrook_request_events (business_id,created_at desc);
alter table public.gatebrook_request_events enable row level security;
revoke all on public.gatebrook_request_events from anon,authenticated;
grant all on public.gatebrook_request_events to service_role;

create table if not exists public.gatebrook_request_reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  customer_name text not null,
  phone text,
  email text,
  service text not null,
  preferred_date date,
  service_location text,
  notes text,
  flagged_reason text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','dismissed')),
  reviewed_at timestamptz,
  reviewed_by uuid,
  approved_lead_id uuid references public.leads(id) on delete set null
);
create index if not exists gatebrook_request_reviews_pending_idx
  on public.gatebrook_request_reviews (business_id,created_at desc)
  where status='pending';
alter table public.gatebrook_request_reviews enable row level security;
revoke all on public.gatebrook_request_reviews from anon,authenticated;
grant select on public.gatebrook_request_reviews to authenticated;
grant all on public.gatebrook_request_reviews to service_role;

-- Owners can see only their business's request reviews. No client-side
-- INSERT/UPDATE/DELETE is granted: decisions go through a verified RPC.
drop policy if exists gatebrook_business_owner_review_read on public.gatebrook_request_reviews;
create policy gatebrook_business_owner_review_read
on public.gatebrook_request_reviews for select to authenticated
using (exists (
  select 1 from public.business_users bu
  where bu.business_id = gatebrook_request_reviews.business_id
    and bu.user_id = (select auth.uid()) and bu.role = 'owner'
));

create or replace function public.gatebrook_receive_request(
  p_business_id uuid, p_contact_hash text, p_fingerprint text,
  p_customer_name text, p_phone text, p_email text, p_service text,
  p_preferred_date date, p_service_location text, p_notes text
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
begin
  if p_business_id is null or p_contact_hash is null or p_fingerprint is null
     or p_contact_hash !~ '^[a-f0-9]{64}$'
     or p_fingerprint !~ '^[a-f0-9]{64}$'
     or length(trim(coalesce(p_customer_name,''))) < 2
     or length(trim(coalesce(p_service,''))) = 0
     or (coalesce(trim(p_phone),'')='' and coalesce(trim(p_email),'')='')
  then raise exception 'Invalid request details'; end if;

  -- Recheck tenant and service under the same DB transaction.
  if not exists (
    select 1 from public.businesses b
    where b.id=p_business_id and b.active=true
  ) or not exists (
    select 1 from public.business_services s
    where s.business_id=p_business_id and s.name=p_service and s.active=true
  ) then raise exception 'Business or service unavailable'; end if;

  -- Serializes concurrent requests even if they arrive on different edge nodes.
  pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text, 0));

  if exists (
    select 1 from public.gatebrook_request_events e
    where e.business_id=p_business_id
      and e.fingerprint=p_fingerprint
      and e.created_at>now()-interval '24 hours'
  ) then
    return jsonb_build_object('disposition','duplicate');
  end if;

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

  -- Most businesses rarely receive 120/hour. Above that, hold new entries
  -- for human review rather than send a storm of emails.
  v_disposition:=case when v_hour_count>=3 or v_business_hour_count>=120
    then 'pending' else 'accepted' end;

  if v_disposition='pending' then
    select count(*) into v_business_pending_count
      from public.gatebrook_request_reviews r
      where r.business_id=p_business_id and r.status='pending';
    if v_business_pending_count>=100 then
      return jsonb_build_object('disposition','limited','retry_seconds',3600);
    end if;
    v_reason:=case when v_hour_count>=3 then
      'More than 3 requests from this contact within 1 hour'
      else 'Unusually high request volume for this business' end;
    insert into public.gatebrook_request_reviews (
      business_id,customer_name,phone,email,service,
      preferred_date,service_location,notes,flagged_reason
    ) values (
      p_business_id,p_customer_name,nullif(p_phone,''),nullif(p_email,''),
      p_service,p_preferred_date,nullif(p_service_location,''),
      nullif(p_notes,''),v_reason
    ) returning id into v_review_id;
  else
    insert into public.leads (
      business_id,customer_name,phone,email,vehicle,vehicle_type,
      service,preferred_date,service_location,notes,status,source
    ) values (
      p_business_id,p_customer_name,nullif(p_phone,''),nullif(p_email,''),
      null,null,p_service,p_preferred_date,nullif(p_service_location,''),
      nullif(p_notes,''),'new','website'
    ) returning id into v_lead_id;
  end if;

  insert into public.gatebrook_request_events
    (business_id,contact_hash,fingerprint,disposition)
    values(p_business_id,p_contact_hash,p_fingerprint,v_disposition);

  if v_disposition='pending' then
    return jsonb_build_object('disposition','pending','review_id',v_review_id);
  end if;
  return jsonb_build_object('disposition','accepted','lead_id',v_lead_id);
end;
$$;
revoke all on function public.gatebrook_receive_request(
  uuid,text,text,text,text,text,text,date,text,text) from public,anon,authenticated;
grant execute on function public.gatebrook_receive_request(
  uuid,text,text,text,text,text,text,date,text,text) to service_role;

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
    where bu.user_id=auth.uid() and bu.business_id=p_business_id
      and bu.role='owner'
  ) then raise exception 'Not authorized for this business'; end if;

  select * into v_review from public.gatebrook_request_reviews r
  where r.id=p_review_id and r.business_id=p_business_id
  for update;
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
  end if;

  update public.gatebrook_request_reviews
  set status=case when p_decision='approve' then 'approved' else 'dismissed' end,
    approved_lead_id=v_lead_id, reviewed_at=now(),reviewed_by=auth.uid()
  where id=v_review.id;

  return jsonb_build_object(
    'disposition',case when p_decision='approve' then 'approved' else 'dismissed' end,
    'lead_id',v_lead_id);
end;
$$;
revoke all on function public.gatebrook_review_request(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.gatebrook_review_request(uuid,uuid,text)
  to authenticated;

-- Pending reviews count separately from ordinary leads and never affect
-- revenue/conversion metrics until the owner explicitly approves them.
