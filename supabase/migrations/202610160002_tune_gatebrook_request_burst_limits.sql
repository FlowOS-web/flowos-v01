-- Tune the business-wide burst thresholds to prevent inbox flooding from
-- attackers who rotate contacts. IP address is not used as a blocking key.
-- Allow up to 30 normal requests/hour across distinct contacts, hold up to
-- 60 pending requests for owner review, and stop after 90/hour.
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text, 0));

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

  if v_hour_count>=9 or v_day_count>=25 or v_business_hour_count>=90 then
    return jsonb_build_object('disposition','limited','retry_seconds',3600);
  end if;

  -- A sustained 30+ requests/hour warrants review for small home-service businesses. Above that, hold new entries
  -- for human review rather than send a storm of emails.
  v_disposition:=case when v_hour_count>=3 or v_business_hour_count>=30
    then 'pending' else 'accepted' end;

  if v_disposition='pending' then
    select count(*) into v_business_pending_count
      from public.gatebrook_request_reviews r
      where r.business_id=p_business_id and r.status='pending';
    if v_business_pending_count>=60 then
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

