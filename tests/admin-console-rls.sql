-- Verify the deployed administrator-console read model with real role changes.
-- All synthetic businesses, memberships, leads, and one pending Auth user are
-- rolled back. No Auth API, notification function, or email API is called.
-- Output contains check names and boolean outcomes only, never user/lead data.
begin isolation level repeatable read;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table flowos_console_context (
  actor uuid, actor_email text, owner_id uuid, owner_email text,
  pending_id uuid, pending_email text, prefix text,
  business_a uuid, business_b uuid, business_c uuid,
  request_a uuid, request_b uuid, request_c uuid
) on commit drop;
create temporary table flowos_console_results (
  check_name text primary key, passed boolean not null
) on commit drop;
do $$ begin
  execute format('grant usage on schema %I to service_role,authenticated,anon',
    (select nspname from pg_namespace where oid=pg_my_temp_schema()));
end $$;
grant select,update on flowos_console_context to service_role;
grant select on flowos_console_context to authenticated,anon;
grant select,insert on flowos_console_results to service_role,authenticated,anon;
create function pg_temp.console_assert(p_name text,p_pass boolean) returns void
language plpgsql security invoker as $$
begin
  if p_pass is distinct from true then raise exception 'Verification failed: %',p_name; end if;
  insert into pg_temp.flowos_console_results values(p_name,true);
end;
$$;
grant execute on function pg_temp.console_assert(text,boolean) to service_role,authenticated,anon;

insert into flowos_console_context(actor,actor_email,owner_id,owner_email,
  pending_id,pending_email,prefix,request_a,request_b,request_c)
select a.user_id,lower(admin_user.email),u.id,lower(u.email),gen_random_uuid(),
  'console-verification-' || replace(gen_random_uuid()::text,'-','') || '@example.invalid',
  'admin-verify-' || replace(gen_random_uuid()::text,'-',''),
  gen_random_uuid(),gen_random_uuid(),gen_random_uuid()
from flowos_private.platform_admins a
join auth.users admin_user on admin_user.id=a.user_id
cross join lateral (
  select candidate.id,candidate.email from auth.users candidate
  where candidate.id<>a.user_id and candidate.deleted_at is null
    and (candidate.banned_until is null or candidate.banned_until<now())
    and candidate.email_confirmed_at is not null
    and coalesce(length(candidate.encrypted_password),0)>0
    and not exists(select 1 from flowos_private.platform_admins other_admin
      where other_admin.user_id=candidate.id and other_admin.active)
  order by candidate.created_at limit 1
) u
where a.active and admin_user.deleted_at is null
  and (admin_user.banned_until is null or admin_user.banned_until<now())
order by a.created_at limit 1;
select pg_temp.console_assert('existing_admin_and_confirmed_owner_available',
  (select count(*)=1 from flowos_console_context));

-- This account is a transaction-local fixture; its password and metadata are
-- empty and its email uses a reserved invalid domain. Never create an identity
-- or emit an invitation through the Auth service for this fixture.
insert into auth.users(id,email,encrypted_password,email_confirmed_at,
  created_at,updated_at,aud,role)
select pending_id,pending_email,'',null,now(),now(),'authenticated','authenticated'
from flowos_console_context;

-- Both public RPC wrappers remain service-only and SECURITY INVOKER. Private
-- SECURITY DEFINER helpers have a fixed search_path and are not browser APIs.
do $$
declare v_role text; v_function text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    perform pg_temp.console_assert(v_role || '_cannot_enter_private_schema',
      not has_schema_privilege(v_role,'flowos_private','USAGE'));
    foreach v_function in array array[
      'public.flowos_admin_businesses(uuid,integer,integer,boolean,text)',
      'public.flowos_admin_business_details(uuid,uuid,integer,integer)',
      'public.flowos_onboarding_setup_allowed(uuid,uuid)',
      'flowos_private.business_enrollment(uuid,uuid)',
      'flowos_private.business_list(uuid,integer,integer,boolean,text)',
      'flowos_private.business_details(uuid,uuid,integer,integer)'
    ] loop
      perform pg_temp.console_assert(v_role || '_cannot_execute_' || v_function,
        not has_function_privilege(v_role,v_function,'EXECUTE'));
    end loop;
    perform pg_temp.console_assert(v_role || '_cannot_write_memberships',
      not has_table_privilege(v_role,'public.business_users','INSERT')
      and not has_table_privilege(v_role,'public.business_users','UPDATE')
      and not has_table_privilege(v_role,'public.business_users','DELETE'));
    perform pg_temp.console_assert(v_role || '_cannot_submit_leads_directly',
      not has_table_privilege(v_role,'public.leads','INSERT'));
  end loop;
  perform pg_temp.console_assert('public_wrappers_are_invoker',
    (select count(*)=3 and bool_and(not p.prosecdef)
     from pg_proc p where p.oid in (
       'public.flowos_admin_businesses(uuid,integer,integer,boolean,text)'::regprocedure,
       'public.flowos_admin_business_details(uuid,uuid,integer,integer)'::regprocedure,
       'public.flowos_onboarding_setup_allowed(uuid,uuid)'::regprocedure)));
  perform pg_temp.console_assert('private_helpers_have_fixed_search_path',
    (select count(*)=3 and bool_and(p.prosecdef and 'search_path=""'=any(p.proconfig))
     from pg_proc p where p.oid in (
       'flowos_private.business_enrollment(uuid,uuid)'::regprocedure,
       'flowos_private.business_list(uuid,integer,integer,boolean,text)'::regprocedure,
       'flowos_private.business_details(uuid,uuid,integer,integer)'::regprocedure)));
end;
$$;

set local role service_role;
do $$
declare c pg_temp.flowos_console_context%rowtype; r jsonb;
begin
  select * into strict c from pg_temp.flowos_console_context;
  r := public.flowos_onboarding_provision(c.actor,c.request_a,c.owner_id,true,
    jsonb_build_object('owner_email',c.owner_email,'business',jsonb_build_object(
      'name',c.prefix || '-wild_%','slug',c.prefix || '-a','industry','Verification only'),
      'services',jsonb_build_array('Synthetic service one','Synthetic service two')));
  c.business_a := (r->>'business_id')::uuid;
  r := public.flowos_onboarding_provision(c.actor,c.request_b,c.actor,true,
    jsonb_build_object('owner_email',c.actor_email,'business',jsonb_build_object(
      'name',c.prefix || '-wild-a','slug',c.prefix || '-b','industry','Verification only'),
      'services',jsonb_build_array('Synthetic service one','Synthetic service two')));
  c.business_b := (r->>'business_id')::uuid;
  r := public.flowos_onboarding_provision(c.actor,c.request_c,c.pending_id,false,
    jsonb_build_object('owner_email',c.pending_email,'business',jsonb_build_object(
      'name',c.prefix || '-pending','slug',c.prefix || '-c','industry','Verification only'),
      'services',jsonb_build_array('Synthetic service one')));
  c.business_c := (r->>'business_id')::uuid;
  update pg_temp.flowos_console_context set business_a=c.business_a,
    business_b=c.business_b,business_c=c.business_c;
  update public.businesses set active=false where id=c.business_b;
  update public.business_services set active=false where business_id=c.business_a and sort_order=1;
  insert into public.leads(business_id,customer_name,service,status,source)
    values(c.business_a,'Synthetic verification A1','Synthetic service one','new','verification'),
      (c.business_a,'Synthetic verification A2','Synthetic service one','contacted','verification'),
      (c.business_b,'Synthetic verification B1','Synthetic service one','booked','verification');
end;
$$;

do $$
declare c pg_temp.flowos_console_context%rowtype; r jsonb; a jsonb; b jsonb;
  entry jsonb; v_offset integer; v_limit integer;
begin
  select * into strict c from pg_temp.flowos_console_context;
  begin
    perform public.flowos_admin_businesses(c.owner_id,0,50,null,'');
    raise exception 'Nonadmin list actor was accepted';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('service_nonadmin_list_rejected',true);
  end;
  begin
    perform public.flowos_admin_business_details(c.owner_id,c.business_a,0,50);
    raise exception 'Nonadmin detail actor was accepted';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('service_nonadmin_details_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_setup_allowed(c.owner_id,c.request_c);
    raise exception 'Nonadmin setup actor was accepted';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('service_nonadmin_setup_check_rejected',true);
  end;
  begin
    perform public.flowos_admin_businesses(null,0,50,null,'');
    raise exception 'Null administrator was accepted';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('null_admin_rejected',true);
  end;
  perform pg_temp.console_assert('missing_live_session_rejected',
    public.flowos_admin_authorize(c.actor,gen_random_uuid())=false);

  foreach v_offset in array array[null::integer,-1,100001] loop
    begin
      perform public.flowos_admin_businesses(c.actor,v_offset,50,null,'');
      raise exception 'Invalid list offset accepted';
    exception when invalid_parameter_value then null; end;
    begin
      perform public.flowos_admin_business_details(c.actor,c.business_a,v_offset,50);
      raise exception 'Invalid detail offset accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  perform pg_temp.console_assert('invalid_offsets_rejected',true);
  foreach v_limit in array array[null::integer,0,101] loop
    begin
      perform public.flowos_admin_businesses(c.actor,0,v_limit,null,'');
      raise exception 'Invalid list limit accepted';
    exception when invalid_parameter_value then null; end;
    begin
      perform public.flowos_admin_business_details(c.actor,c.business_a,0,v_limit);
      raise exception 'Invalid detail limit accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  perform pg_temp.console_assert('invalid_limits_rejected',true);
  begin
    perform public.flowos_admin_businesses(c.actor,0,50,null,null);
    raise exception 'Null search accepted';
  exception when invalid_parameter_value then
    perform pg_temp.console_assert('null_search_rejected',true);
  end;
  begin
    perform public.flowos_admin_businesses(c.actor,0,50,null,repeat('a',121));
    raise exception 'Overlong search accepted';
  exception when invalid_parameter_value then
    perform pg_temp.console_assert('overlong_search_rejected',true);
  end;
  begin
    perform public.flowos_admin_business_details(c.actor,null,0,50);
    raise exception 'Null business accepted';
  exception when invalid_parameter_value then
    perform pg_temp.console_assert('null_business_rejected',true);
  end;
  perform pg_temp.console_assert('unknown_business_returns_null',
    public.flowos_admin_business_details(c.actor,gen_random_uuid(),0,50) is null);
  perform pg_temp.console_assert('unknown_request_disallows_setup',
    public.flowos_onboarding_setup_allowed(c.actor,gen_random_uuid())=false);

  r := public.flowos_admin_businesses(c.actor,0,50,null,c.prefix);
  perform pg_temp.console_assert('all_matching_enrollments_returned',
    (r->>'total')::integer=3 and jsonb_array_length(r->'businesses')=3);
  perform pg_temp.console_assert('global_counts_match_database',
    r->'counts'=jsonb_build_object('active',(select count(*) from public.businesses where active),
      'inactive',(select count(*) from public.businesses where not active),
      'total',(select count(*) from public.businesses)));
  a := public.flowos_admin_businesses(c.actor,0,50,true,c.prefix);
  b := public.flowos_admin_businesses(c.actor,0,50,false,c.prefix);
  perform pg_temp.console_assert('active_filter_is_scoped',
    (a->>'total')::integer=2 and jsonb_array_length(a->'businesses')=2
    and not exists(select 1 from jsonb_array_elements(a->'businesses') e where not (e->>'active')::boolean));
  perform pg_temp.console_assert('inactive_filter_is_scoped',
    (b->>'total')::integer=1 and (b#>>'{businesses,0,business_id}')::uuid=c.business_b);
  perform pg_temp.console_assert('filtered_list_retains_global_counts',
    a->'counts'=r->'counts' and b->'counts'=r->'counts');
  a := public.flowos_admin_businesses(c.actor,0,1,null,c.prefix);
  b := public.flowos_admin_businesses(c.actor,1,1,null,c.prefix);
  perform pg_temp.console_assert('enrollment_pagination_does_not_repeat',
    jsonb_array_length(a->'businesses')=1 and jsonb_array_length(b->'businesses')=1
    and a#>>'{businesses,0,business_id}'<>b#>>'{businesses,0,business_id}'
    and (a->>'total')::integer=3 and (b->>'total')::integer=3);
  perform pg_temp.console_assert('enrollment_offset_past_end_is_empty',
    public.flowos_admin_businesses(c.actor,3,50,null,c.prefix)->'businesses'='[]'::jsonb);
  a := public.flowos_admin_businesses(c.actor,0,50,null,'  ' || upper(c.prefix) || '  ');
  perform pg_temp.console_assert('search_is_case_insensitive_and_trimmed',a->'businesses'=r->'businesses');
  a := public.flowos_admin_businesses(c.actor,0,50,null,c.prefix || '-wild_%');
  perform pg_temp.console_assert('percent_and_underscore_are_literal_search',
    (a->>'total')::integer=1 and (a#>>'{businesses,0,business_id}')::uuid=c.business_a);

  a := public.flowos_admin_business_details(c.actor,c.business_a,0,1);
  b := public.flowos_admin_business_details(c.actor,c.business_a,1,1);
  perform pg_temp.console_assert('details_return_requested_enrollment',
    (a#>>'{business,business_id}')::uuid=c.business_a);
  perform pg_temp.console_assert('profile_stays_in_requested_tenant',
    (a#>>'{profile,business_id}')::uuid=c.business_a);
  perform pg_temp.console_assert('all_services_stay_in_requested_tenant',
    jsonb_array_length(a->'services')=2 and not exists(
      select 1 from jsonb_array_elements(a->'services') s where (s->>'business_id')::uuid<>c.business_a));
  perform pg_temp.console_assert('service_count_reports_active_services',
    (a#>>'{business,service_count}')::integer=1);
  perform pg_temp.console_assert('all_leads_stay_in_requested_tenant',
    jsonb_array_length(a->'leads')=1 and jsonb_array_length(b->'leads')=1
    and not exists(select 1 from jsonb_array_elements((a->'leads') || (b->'leads')) l
      where (l->>'business_id')::uuid<>c.business_a));
  perform pg_temp.console_assert('lead_pagination_does_not_repeat',
    a#>>'{leads,0,id}'<>b#>>'{leads,0,id}' and (a->>'total_leads')::integer=2
    and (b->>'total_leads')::integer=2 and (a#>>'{business,lead_count}')::integer=2);
  perform pg_temp.console_assert('lead_offset_past_end_is_empty',
    public.flowos_admin_business_details(c.actor,c.business_a,2,50)->'leads'='[]'::jsonb);
  perform pg_temp.console_assert('second_business_leads_are_separate',
    (public.flowos_admin_business_details(c.actor,c.business_b,0,50)->>'total_leads')::integer=1);
  perform pg_temp.console_assert('onboarding_request_is_recoverable_by_business',
    (a#>>'{business,request_id}')::uuid=c.request_a);
  perform pg_temp.console_assert('existing_confirmed_password_owner_has_no_setup_link',
    not (a#>>'{business,setup_available}')::boolean
    and not (a#>>'{business,owner_setup_required}')::boolean);
  perform pg_temp.console_assert('setup_endpoint_disallows_existing_active_owner',
    public.flowos_onboarding_setup_allowed(c.actor,c.request_a)=false);
  perform pg_temp.console_assert('listed_owner_is_current_membership',
    jsonb_array_length(a#>'{business,owners}')=1
    and (a#>>'{business,owners,0,user_id}')::uuid=c.owner_id
    and (a#>>'{business,owners,0,confirmed}')::boolean
    and (a#>>'{business,owners,0,has_password}')::boolean);
  perform pg_temp.console_assert('auth_secrets_are_absent',
    not exists(select 1 from jsonb_array_elements(a#>'{business,owners}') o
      where o ?| array['encrypted_password','raw_app_meta_data','raw_user_meta_data',
        'confirmation_token','recovery_token','email_change_token_new'])
    and not (a->'business' ?| array['payload','owner_user_id','created_by','owner_existing']));
  a := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('pending_owner_setup_is_available',
    (a#>>'{business,setup_available}')::boolean and (a#>>'{business,owner_setup_required}')::boolean);
  perform pg_temp.console_assert('setup_endpoint_allows_pending_owner',
    public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=true);
  perform pg_temp.console_assert('empty_leads_are_an_array',a->'leads'='[]'::jsonb and (a->>'total_leads')::integer=0);
end;
$$;
reset role;

-- Only the synthetic pending owner is modified below, and every state change
-- rolls back. Setup availability must track current Auth and membership state.
do $$
declare c pg_temp.flowos_console_context%rowtype; r jsonb;
begin
  select * into strict c from pg_temp.flowos_console_context;
  update public.businesses set active=false where id=c.business_c;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('inactive_business_has_no_setup_link',
    not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  update public.businesses set active=true where id=c.business_c;
  update auth.users set email_confirmed_at=now(),encrypted_password='synthetic-unused-hash' where id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('confirmed_password_owner_cannot_regenerate_setup',
    not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  update auth.users set encrypted_password='' where id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('recorded_pending_owner_without_password_can_complete_setup',
    (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=true);
  update auth.users set banned_until=now()+interval '1 day' where id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('banned_owner_has_no_setup_link',not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  update auth.users set banned_until=null,deleted_at=now() where id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('deleted_owner_has_no_setup_link',not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  update auth.users set deleted_at=null,email='changed-' || c.pending_email where id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('changed_owner_email_has_no_setup_link',not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  update auth.users set email=c.pending_email where id=c.pending_id;
  delete from public.business_users where business_id=c.business_c and user_id=c.pending_id;
  r := public.flowos_admin_business_details(c.actor,c.business_c,0,50);
  perform pg_temp.console_assert('removed_owner_membership_has_no_setup_link',not (r#>>'{business,setup_available}')::boolean
    and public.flowos_onboarding_setup_allowed(c.actor,c.request_c)=false);
  perform pg_temp.console_assert('removed_owner_is_absent_from_owner_list',r#>'{business,owners}'='[]'::jsonb);
end;
$$;

-- Administrator support access must not grant raw tenant access. Tenant owner
-- reads and updates keep their original RLS and cannot reassign a lead.
set local role authenticated;
do $$
declare c pg_temp.flowos_console_context%rowtype; changed integer;
begin
  select * into strict c from pg_temp.flowos_console_context;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',c.actor,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',c.actor::text,true);
  perform pg_temp.console_assert('admin_browser_cannot_read_unowned_business',
    (select count(*)=0 from public.businesses where id=c.business_a));
  perform pg_temp.console_assert('admin_browser_cannot_read_unowned_leads',
    (select count(*)=0 from public.leads where business_id=c.business_a));
  begin
    perform public.flowos_admin_businesses(c.actor,0,50,null,'');
    raise exception 'Admin browser called privileged list RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('admin_browser_direct_list_call_rejected',true);
  end;
  begin
    perform public.flowos_admin_business_details(c.actor,c.business_a,0,50);
    raise exception 'Admin browser called privileged detail RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('admin_browser_direct_details_call_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_setup_allowed(c.actor,c.request_c);
    raise exception 'Admin browser called privileged setup-check RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('admin_browser_direct_setup_check_rejected',true);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',c.owner_id,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',c.owner_id::text,true);
  perform pg_temp.console_assert('owner_reads_only_own_fixture_business',
    (select count(*)=1 from public.businesses where id in (c.business_a,c.business_b,c.business_c)));
  perform pg_temp.console_assert('owner_reads_only_own_fixture_leads',
    (select count(*)=2 from public.leads where business_id in (c.business_a,c.business_b,c.business_c)));
  update public.leads set status='contacted' where business_id=c.business_a;
  get diagnostics changed=row_count;
  perform pg_temp.console_assert('owner_can_update_own_leads',changed=2);
  update public.leads set status='lost' where business_id=c.business_b;
  get diagnostics changed=row_count;
  perform pg_temp.console_assert('owner_cannot_update_other_tenant_leads',changed=0);
  update public.business_public_profiles set tagline='Synthetic cross-tenant attempt' where business_id=c.business_b;
  get diagnostics changed=row_count;
  perform pg_temp.console_assert('owner_cannot_update_other_tenant_profile',changed=0);
  begin
    update public.leads set business_id=c.business_b where business_id=c.business_a;
    raise exception 'Owner reassigned lead to another business';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('owner_cannot_reassign_leads_across_tenants',true);
  end;
end;
$$;
set local role anon;
do $$
declare c pg_temp.flowos_console_context%rowtype;
begin
  select * into strict c from pg_temp.flowos_console_context;
  perform set_config('request.jwt.claims','{}',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform pg_temp.console_assert('anonymous_cannot_read_fixture_leads',
    (select count(*)=0 from public.leads where business_id in (c.business_a,c.business_b,c.business_c)));
  begin
    perform public.flowos_admin_businesses(c.actor,0,50,null,'');
    raise exception 'Anonymous browser called privileged list RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('anonymous_direct_list_call_rejected',true);
  end;
  begin
    perform public.flowos_admin_business_details(c.actor,c.business_a,0,50);
    raise exception 'Anonymous browser called privileged detail RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('anonymous_direct_details_call_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_setup_allowed(c.actor,c.request_c);
    raise exception 'Anonymous browser called privileged setup-check RPC';
  exception when insufficient_privilege then
    perform pg_temp.console_assert('anonymous_direct_setup_check_rejected',true);
  end;
end;
$$;
reset role;
select check_name,passed from pg_temp.flowos_console_results order by check_name;
rollback;
