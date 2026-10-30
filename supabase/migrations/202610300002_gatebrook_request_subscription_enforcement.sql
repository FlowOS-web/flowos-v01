-- Critical pre-launch Gatebrook security hardening, October 2026.
-- Authorization must re-check subscription status at the database trust
-- boundary. Cached active flags alone are insufficient after expiry,
-- missed webhooks or temporary event-delivery delays.
-- No permissions / public API signatures change in this migration.

CREATE OR REPLACE FUNCTION public.gatebrook_get_public_request_form(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'template_key', coalesce(f.template_key, 'general'),
    'page_title', coalesce(f.page_title, 'Request a Service'),
    'page_description', coalesce(nullif(p.tagline, ''), 'Tell us what you need and we will follow up.'),
    'submit_label', coalesce(f.submit_label, 'Submit Request'),
    'fields', coalesce(f.fields, '[]'::jsonb)
  )
  from public.business_public_profiles p
  left join public.business_request_forms f on f.business_id = p.business_id
  where p.slug = p_slug and p.active = true
    and flowos_private.gatebrook_business_has_access(p.business_id)
  limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.gatebrook_receive_request(p_business_id uuid, p_contact_hash text, p_fingerprint text, p_customer_name text, p_phone text, p_email text, p_service text, p_preferred_date date, p_service_location text, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Fail closed even if the cached business.active flag is stale:
  -- actual Stripe subscription status and paid period are checked by
  -- gatebrook_business_has_access (which also preserves the seeded demo).
  if not flowos_private.gatebrook_business_has_access(p_business_id)
  then raise exception 'Workspace subscription inactive'; end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.gatebrook_receive_request_custom(p_business_id uuid, p_contact_hash text, p_fingerprint text, p_customer_name text, p_phone text, p_email text, p_service text, p_preferred_date date, p_service_location text, p_notes text, p_answers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Fail closed even if the cached business.active flag is stale:
  -- actual Stripe subscription status and paid period are checked by
  -- gatebrook_business_has_access (which also preserves the seeded demo).
  if not flowos_private.gatebrook_business_has_access(p_business_id)
  then raise exception 'Workspace subscription inactive'; end if;

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
$function$;

CREATE OR REPLACE FUNCTION public.gatebrook_review_request(p_business_id uuid, p_review_id uuid, p_decision text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- An authenticated owner cannot approve pending customer requests when
  -- the workspace subscription is expired, canceled or past due.
  if not flowos_private.gatebrook_business_has_access(p_business_id)
  then raise exception 'Workspace subscription inactive'; end if;

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
$function$;
