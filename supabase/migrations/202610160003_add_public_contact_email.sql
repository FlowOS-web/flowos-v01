-- Optional public contact email; never copied from owner or notification email.
ALTER TABLE public.business_public_profiles ADD COLUMN IF NOT EXISTS public_email text;
ALTER TABLE public.business_public_profiles
  ADD CONSTRAINT gatebrook_public_email_valid CHECK (
    public_email IS NULL OR (
      length(public_email) BETWEEN 3 AND 200
      AND public_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    )
  );

-- Same atomic onboarding function; only public profile field is added.
CREATE OR REPLACE FUNCTION public.flowos_onboarding_provision(p_actor uuid, p_request uuid, p_owner uuid, p_owner_existing boolean, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_existing jsonb;
  v_owner jsonb;
  v_business uuid;
  v_b jsonb := p_payload->'business';
  v_services jsonb := p_payload->'services';
  v_email text := p_payload->>'owner_email';
  v_slug text := v_b->>'slug';
  v_name text := v_b->>'name';
begin
  perform flowos_private.require_admin(p_actor);
  if p_request is null or p_owner is null or p_owner_existing is null then
    raise exception 'Request and owner IDs are required' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,0));
  v_existing := public.flowos_onboarding_get(p_actor,p_request);
  if v_existing is not null then
    if v_existing->'payload' is distinct from p_payload
      or (v_existing->>'owner_user_id')::uuid is distinct from p_owner then
      raise exception 'This request ID belongs to a different submission' using errcode='23505';
    end if;
    return v_existing;
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(v_b) is distinct from 'object'
    or jsonb_typeof(v_services) is distinct from 'array'
    or v_name is null or length(btrim(v_name)) not between 1 and 120
    or v_name <> btrim(v_name)
    or v_slug is null or length(v_slug) not between 3 and 60
    or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v_slug in ('admin','api','auth','dashboard','flowos','login','logout','onboarding','settings',
      'activate','request','privacy','terms','index','v1-preview','signup','support','www')
    or v_email is null or length(v_email)>200
    or v_email <> lower(btrim(v_email))
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid business, slug, owner email, or services' using errcode='22023';
  end if;
  if jsonb_typeof(p_payload->'owner_email') is distinct from 'string' or exists (
    select 1 from jsonb_each(v_b) f where f.key in ('name','slug','industry','tagline','contact_phone',
      'website_url','logo_url','primary_color','notification_email','public_email')
      and jsonb_typeof(f.value) not in ('string','null')
  ) then raise exception 'Business fields must be text' using errcode='22023'; end if;
  if jsonb_array_length(v_services) not between 1 and 20 or exists (
    select 1 from jsonb_array_elements(v_services) s
    where jsonb_typeof(s) <> 'string' or length(btrim(s#>>'{}')) not between 1 and 120
      or s#>>'{}' <> btrim(s#>>'{}')
  ) or (select count(distinct lower(s#>>'{}')) from jsonb_array_elements(v_services) s)
      <> jsonb_array_length(v_services) then
    raise exception 'Provide 1 to 20 distinct services' using errcode='22023';
  end if;
  if length(coalesce(v_b->>'public_email',''))>200
    or (nullif(v_b->>'public_email','') is not null
      and v_b->>'public_email' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    or length(coalesce(v_b->>'industry',''))>120
    or length(coalesce(v_b->>'tagline',''))>280
    or length(coalesce(v_b->>'contact_phone',''))>50
    or length(coalesce(v_b->>'website_url',''))>300
    or length(coalesce(v_b->>'logo_url',''))>500
    or coalesce(v_b->>'primary_color','#6fa7ff') !~ '^#[0-9A-Fa-f]{6}$'
    or (nullif(v_b->>'website_url','') is not null and v_b->>'website_url' !~ '^https?://')
    or (nullif(v_b->>'logo_url','') is not null and v_b->>'logo_url' !~ '^https?://')
    or length(coalesce(v_b->>'notification_email',''))>200
    or (nullif(v_b->>'notification_email','') is not null
      and v_b->>'notification_email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Invalid profile fields' using errcode='22023';
  end if;
  v_owner := public.flowos_onboarding_owner(p_actor,v_email);
  if v_owner is null or (v_owner->>'id')::uuid <> p_owner then
    raise exception 'Owner account does not match the email' using errcode='22023';
  end if;
  if exists(select 1 from public.businesses where slug=v_slug)
    or exists(select 1 from public.business_public_profiles where slug=v_slug) then
    raise exception 'Request-page slug is already in use' using errcode='23505';
  end if;
  insert into public.businesses(name,slug,industry,owner_email,active)
    values(v_name,v_slug,nullif(v_b->>'industry',''),coalesce(nullif(v_b->>'notification_email',''),v_email),true)
    returning id into v_business;
  insert into public.business_public_profiles(business_id,slug,display_name,industry,tagline,
    contact_phone,website_url,logo_url,primary_color,public_email,active)
    values(v_business,v_slug,v_name,nullif(v_b->>'industry',''),nullif(v_b->>'tagline',''),
      nullif(v_b->>'contact_phone',''),nullif(v_b->>'website_url',''),nullif(v_b->>'logo_url',''),
      coalesce(v_b->>'primary_color','#6fa7ff'),nullif(v_b->>'public_email',''),true);
  insert into public.business_services(business_id,name,active,sort_order)
    select v_business,s.value,true,(s.ordinality-1)::int from jsonb_array_elements_text(v_services) with ordinality s;
  insert into public.business_users(business_id,user_id,role) values(v_business,p_owner,'owner');
  insert into flowos_private.onboarding_requests(request_id,created_by,business_id,owner_user_id,
    owner_email,owner_existing,owner_setup_required,slug,payload)
    values(p_request,p_actor,v_business,p_owner,v_email,p_owner_existing,
      not (v_owner->>'confirmed')::boolean and not (v_owner->>'has_password')::boolean,v_slug,p_payload);
  return public.flowos_onboarding_get(p_actor,p_request);
end;
$function$
