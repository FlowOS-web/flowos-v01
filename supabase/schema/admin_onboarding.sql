-- Additive remote migration: admin_only_onboarding.
-- No existing tenant policy or lead-submission function is replaced.
create schema if not exists flowos_private;
revoke all on schema flowos_private from public, anon, authenticated;
grant usage on schema flowos_private to service_role;

create table flowos_private.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table flowos_private.onboarding_requests (
  request_id uuid primary key,
  created_by uuid not null references auth.users(id),
  business_id uuid not null unique references public.businesses(id),
  owner_user_id uuid not null references auth.users(id),
  owner_email text not null,
  owner_existing boolean not null,
  owner_setup_required boolean not null,
  slug text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table flowos_private.platform_admins enable row level security;
alter table flowos_private.onboarding_requests enable row level security;
revoke all on flowos_private.platform_admins, flowos_private.onboarding_requests from public, anon, authenticated;
grant select on flowos_private.platform_admins to service_role;
grant select, insert on flowos_private.onboarding_requests to service_role;
create index onboarding_requests_created_by_idx on flowos_private.onboarding_requests(created_by);
create index onboarding_requests_owner_user_id_idx on flowos_private.onboarding_requests(owner_user_id);

create function flowos_private.require_admin(p_actor uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_actor is null or not exists (
    select 1 from flowos_private.platform_admins where user_id=p_actor and active
  ) then raise exception 'Platform administrator required' using errcode='42501'; end if;
end;
$$;

-- These two lookups need access to Auth's private tables. Their only caller is
-- service_role; neither schema nor function is accessible to a browser role.
create function flowos_private.admin_authorize(p_actor uuid,p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_actor is not null and p_session is not null and exists (
    select 1 from flowos_private.platform_admins a
    join auth.users u on u.id=a.user_id
    join auth.sessions s on s.user_id=u.id and s.id=p_session
    where a.user_id=p_actor and a.active and u.deleted_at is null
      and (u.banned_until is null or u.banned_until < now())
      and (s.not_after is null or s.not_after > now())
  );
$$;
create function flowos_private.owner_lookup(p_actor uuid,p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_owner jsonb;
begin
  perform flowos_private.require_admin(p_actor);
  select jsonb_build_object('id',id,'email',lower(email),'confirmed',email_confirmed_at is not null,
    'has_password',coalesce(length(encrypted_password),0)>0)
    into v_owner from auth.users
    where lower(email)=lower(btrim(p_email)) and deleted_at is null
      and (banned_until is null or banned_until < now());
  return v_owner;
end;
$$;

create function public.flowos_admin_authorize(p_actor uuid,p_session uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select flowos_private.admin_authorize(p_actor,p_session);
$$;
create function public.flowos_onboarding_owner(p_actor uuid,p_email text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select flowos_private.owner_lookup(p_actor,p_email);
$$;
create function public.flowos_onboarding_get(p_actor uuid,p_request uuid) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_record jsonb;
begin
  perform flowos_private.require_admin(p_actor);
  select jsonb_build_object('request_id',request_id,'business_id',business_id,
    'slug',slug,'owner_user_id',owner_user_id,'owner_email',owner_email,
    'owner_existing',owner_existing,'owner_setup_required',owner_setup_required,'payload',payload) into v_record
    from flowos_private.onboarding_requests where request_id=p_request;
  return v_record;
end;
$$;

create function public.flowos_onboarding_provision(
  p_actor uuid,p_request uuid,p_owner uuid,p_owner_existing boolean,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
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
      'website_url','logo_url','primary_color','notification_email')
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
  if length(coalesce(v_b->>'industry',''))>120
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
    contact_phone,website_url,logo_url,primary_color,active)
    values(v_business,v_slug,v_name,nullif(v_b->>'industry',''),nullif(v_b->>'tagline',''),
      nullif(v_b->>'contact_phone',''),nullif(v_b->>'website_url',''),nullif(v_b->>'logo_url',''),
      coalesce(v_b->>'primary_color','#6fa7ff'),true);
  insert into public.business_services(business_id,name,active,sort_order)
    select v_business,s.value,true,(s.ordinality-1)::int from jsonb_array_elements_text(v_services) with ordinality s;
  insert into public.business_users(business_id,user_id,role) values(v_business,p_owner,'owner');
  insert into flowos_private.onboarding_requests(request_id,created_by,business_id,owner_user_id,
    owner_email,owner_existing,owner_setup_required,slug,payload)
    values(p_request,p_actor,v_business,p_owner,v_email,p_owner_existing,
      not (v_owner->>'confirmed')::boolean and not (v_owner->>'has_password')::boolean,v_slug,p_payload);
  return public.flowos_onboarding_get(p_actor,p_request);
end;
$$;

revoke all on function flowos_private.require_admin(uuid), flowos_private.admin_authorize(uuid,uuid),
  flowos_private.owner_lookup(uuid,text) from public, anon, authenticated;
grant execute on function flowos_private.require_admin(uuid), flowos_private.admin_authorize(uuid,uuid),
  flowos_private.owner_lookup(uuid,text) to service_role;
revoke all on function public.flowos_admin_authorize(uuid,uuid),public.flowos_onboarding_owner(uuid,text),
  public.flowos_onboarding_get(uuid,uuid),public.flowos_onboarding_provision(uuid,uuid,uuid,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function public.flowos_admin_authorize(uuid,uuid),public.flowos_onboarding_owner(uuid,text),
  public.flowos_onboarding_get(uuid,uuid),public.flowos_onboarding_provision(uuid,uuid,uuid,boolean,jsonb)
  to service_role;

-- RLS does not protect TRUNCATE. Remove unnecessary non-REST privileges.
revoke truncate, references, trigger on public.businesses,public.business_users,
  public.business_public_profiles,public.business_services,public.leads from anon,authenticated;
revoke insert,update,delete on public.business_users from anon,authenticated;

-- Bootstrap is intentionally separate: grant only the explicitly approved login.
