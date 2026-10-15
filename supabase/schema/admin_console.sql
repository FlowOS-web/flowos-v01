-- Dedicated administrator read model. Original tenant RLS stays unchanged.
-- Private Auth joins run only through service-role wrappers after Edge Auth
-- verifies the administrator's identity and current session.
create or replace function flowos_private.business_enrollment(p_actor uuid,p_business uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform flowos_private.require_admin(p_actor);
  select jsonb_build_object(
    'business_id',b.id,'name',b.name,'slug',b.slug,'industry',b.industry,
    'active',b.active,'created_at',b.created_at,
    'owner_email',coalesce(u.email,(
      select ou.email from public.business_users bu join auth.users ou on ou.id=bu.user_id
      where bu.business_id=b.id and bu.role='owner' and ou.deleted_at is null
      order by bu.created_at,bu.id limit 1
    )),
    'owners',coalesce((
      select jsonb_agg(jsonb_build_object('user_id',ou.id,'email',ou.email,
        'confirmed',ou.email_confirmed_at is not null,
        'has_password',coalesce(length(ou.encrypted_password),0)>0) order by bu.created_at,bu.id)
      from public.business_users bu join auth.users ou on ou.id=bu.user_id
      where bu.business_id=b.id and bu.role='owner' and ou.deleted_at is null
    ),'[]'::jsonb),
    'service_count',(select count(*) from public.business_services bs where bs.business_id=b.id and bs.active),
    'lead_count',(select count(*) from public.leads l where l.business_id=b.id),
    'request_id',r.request_id,
    'setup_available',coalesce(b.active and u.deleted_at is null and (u.banned_until is null or u.banned_until < now())
      and lower(u.email)=r.owner_email and exists (
        select 1 from public.business_users bu where bu.business_id=b.id and bu.user_id=r.owner_user_id and bu.role='owner'
      ) and (u.email_confirmed_at is null or (r.owner_setup_required and coalesce(length(u.encrypted_password),0)=0)),false),
    'owner_setup_required',coalesce(b.active and u.deleted_at is null and (u.banned_until is null or u.banned_until < now())
      and lower(u.email)=r.owner_email and exists (
        select 1 from public.business_users bu where bu.business_id=b.id and bu.user_id=r.owner_user_id and bu.role='owner'
      ) and (u.email_confirmed_at is null or (r.owner_setup_required and coalesce(length(u.encrypted_password),0)=0)),false)
  ) into v_result
  from public.businesses b
  left join flowos_private.onboarding_requests r on r.business_id=b.id
  left join auth.users u on u.id=r.owner_user_id
  where b.id=p_business;
  return v_result;
end;
$$;

create or replace function flowos_private.business_list(
  p_actor uuid,p_offset integer,p_limit integer,p_active boolean,p_search text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform flowos_private.require_admin(p_actor);
  if p_offset is null or p_offset not between 0 and 100000
    or p_limit is null or p_limit not between 1 and 100
    or p_search is null or length(p_search)>120 then
    raise exception 'Invalid enrollment filters or page bounds' using errcode='22023';
  end if;
  select jsonb_build_object(
    'businesses',coalesce((
      select jsonb_agg(flowos_private.business_enrollment(p_actor,selected.id)
        order by selected.created_at desc,selected.id desc)
      from (
        select b.id,b.created_at from public.businesses b
        where (p_active is null or b.active=p_active)
          and (btrim(p_search)='' or strpos(lower(b.name || ' ' || b.slug || ' ' || coalesce(b.industry,'')),lower(btrim(p_search)))>0)
        order by b.created_at desc,b.id desc limit p_limit offset p_offset
      ) selected
    ),'[]'::jsonb),
    'total',(
      select count(*) from public.businesses b
      where (p_active is null or b.active=p_active)
        and (btrim(p_search)='' or strpos(lower(b.name || ' ' || b.slug || ' ' || coalesce(b.industry,'')),lower(btrim(p_search)))>0)
    ),
    'counts',(select jsonb_build_object('active',count(*) filter(where active),
      'inactive',count(*) filter(where not active),'total',count(*)) from public.businesses)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function flowos_private.business_details(
  p_actor uuid,p_business uuid,p_offset integer,p_limit integer
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_business jsonb;
begin
  perform flowos_private.require_admin(p_actor);
  if p_business is null or p_offset is null or p_offset not between 0 and 100000
    or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid business or page bounds' using errcode='22023';
  end if;
  v_business := flowos_private.business_enrollment(p_actor,p_business);
  if v_business is null then return null; end if;
  return jsonb_build_object(
    'business',v_business,
    'profile',(select to_jsonb(p) from public.business_public_profiles p where p.business_id=p_business),
    'services',coalesce((select jsonb_agg(to_jsonb(s) order by s.sort_order,s.name,s.id)
      from public.business_services s where s.business_id=p_business),'[]'::jsonb),
    'leads',coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc,l.id desc) from (
        select id,business_id,created_at,customer_name,phone,email,vehicle,vehicle_type,
          service,service_location,preferred_date,notes,status,source,estimated_value,booked_revenue
        from public.leads where business_id=p_business
        order by created_at desc,id desc limit p_limit offset p_offset
      ) l
    ),'[]'::jsonb),
    'total_leads',(select count(*) from public.leads where business_id=p_business)
  );
end;
$$;

create or replace function public.flowos_admin_businesses(
  p_actor uuid,p_offset integer,p_limit integer,p_active boolean,p_search text
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select flowos_private.business_list(p_actor,p_offset,p_limit,p_active,p_search);
$$;
create or replace function public.flowos_admin_business_details(
  p_actor uuid,p_business uuid,p_offset integer,p_limit integer
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select flowos_private.business_details(p_actor,p_business,p_offset,p_limit);
$$;

create or replace function public.flowos_onboarding_setup_allowed(p_actor uuid,p_request uuid)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare v_allowed boolean;
begin
  perform flowos_private.require_admin(p_actor);
  select (flowos_private.business_enrollment(p_actor,r.business_id)->>'setup_available')::boolean
    into v_allowed from flowos_private.onboarding_requests r where r.request_id=p_request;
  return coalesce(v_allowed,false);
end;
$$;

revoke all on function flowos_private.business_enrollment(uuid,uuid),
  flowos_private.business_list(uuid,integer,integer,boolean,text),
  flowos_private.business_details(uuid,uuid,integer,integer),
  public.flowos_admin_businesses(uuid,integer,integer,boolean,text),
  public.flowos_admin_business_details(uuid,uuid,integer,integer),
  public.flowos_onboarding_setup_allowed(uuid,uuid)
  from public,anon,authenticated;
grant execute on function flowos_private.business_enrollment(uuid,uuid),
  flowos_private.business_list(uuid,integer,integer,boolean,text),
  flowos_private.business_details(uuid,uuid,integer,integer),
  public.flowos_admin_businesses(uuid,integer,integer,boolean,text),
  public.flowos_admin_business_details(uuid,uuid,integer,integer),
  public.flowos_onboarding_setup_allowed(uuid,uuid) to service_role;
