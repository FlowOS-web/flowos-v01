-- Run against the deployed onboarding migration. Everything, including the
-- synthetic lead and failure trigger, is rolled back. No email API is called.
-- The result contains only check names and boolean outcomes, never user data.
begin isolation level repeatable read;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table flowos_test_context (
  actor uuid, owner_id uuid, owner_email text, request_id uuid, business_id uuid,
  slug text, payload jsonb, atomic_request uuid, counts_before jsonb
) on commit drop;
create temporary table flowos_test_results (check_name text primary key, passed boolean not null)
  on commit drop;
do $$ begin
  execute format('grant usage on schema %I to service_role,authenticated,anon',
    (select nspname from pg_namespace where oid=pg_my_temp_schema()));
end $$;
insert into flowos_test_context(actor,owner_id,owner_email,request_id,slug)
select a.user_id,u.id,lower(u.email),gen_random_uuid(),
  'onboarding-test-' || replace(gen_random_uuid()::text,'-','')
from flowos_private.platform_admins a
join auth.users admin_user on admin_user.id=a.user_id
cross join lateral (
  select candidate.id,candidate.email from auth.users candidate
  where candidate.id<>a.user_id and candidate.deleted_at is null
    and (candidate.banned_until is null or candidate.banned_until<now())
    and candidate.email_confirmed_at is not null
    and exists(select 1 from public.business_users bu where bu.user_id=candidate.id)
  order by candidate.created_at limit 1
) u
where a.active and admin_user.deleted_at is null
  and (admin_user.banned_until is null or admin_user.banned_until<now())
order by a.created_at limit 1;
update flowos_test_context set payload=jsonb_build_object(
  'owner_email',owner_email,
  'business',jsonb_build_object('name','Synthetic onboarding verification','slug',slug,
    'industry','Home services','tagline','Verification only','primary_color','#2468ab'),
  'services',jsonb_build_array('Test service one','Test service two')
);
grant select,update on flowos_test_context to service_role;
grant select on flowos_test_context to authenticated,anon;
grant select,insert on flowos_test_results to service_role,authenticated,anon;
create function pg_temp.flowos_assert(p_name text,p_pass boolean) returns void
language plpgsql security invoker as $$
begin
  if p_pass is distinct from true then raise exception 'Verification failed: %',p_name; end if;
  insert into pg_temp.flowos_test_results values(p_name,true);
end;
$$;
grant execute on function pg_temp.flowos_assert(text,boolean) to service_role,authenticated,anon;
select pg_temp.flowos_assert('existing_accounts_available',(select count(*)=1 from flowos_test_context));

-- No browser role can execute privileged RPCs or enter the private schema.
do $$
declare v_role text; v_function text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    perform pg_temp.flowos_assert(v_role || '_no_private_schema',
      not has_schema_privilege(v_role,'flowos_private','USAGE'));
    foreach v_function in array array[
      'public.flowos_admin_authorize(uuid,uuid)',
      'public.flowos_onboarding_owner(uuid,text)',
      'public.flowos_onboarding_get(uuid,uuid)',
      'public.flowos_onboarding_provision(uuid,uuid,uuid,boolean,jsonb)'
    ] loop
      perform pg_temp.flowos_assert(v_role || '_no_execute_' || v_function,
        not has_function_privilege(v_role,v_function,'EXECUTE'));
    end loop;
    perform pg_temp.flowos_assert(v_role || '_no_membership_writes',
      not has_table_privilege(v_role,'public.business_users','INSERT')
      and not has_table_privilege(v_role,'public.business_users','UPDATE')
      and not has_table_privilege(v_role,'public.business_users','DELETE'));
    perform pg_temp.flowos_assert(v_role || '_no_lead_insert',
      not has_table_privilege(v_role,'public.leads','INSERT'));
    perform pg_temp.flowos_assert(v_role || '_no_truncate',
      not has_table_privilege(v_role,'public.leads','TRUNCATE')
      and not has_table_privilege(v_role,'public.business_users','TRUNCATE'));
  end loop;
end;
$$;

set local role service_role;
do $$
declare c pg_temp.flowos_test_context%rowtype; r jsonb; again jsonb; malformed jsonb;
begin
  select * into strict c from pg_temp.flowos_test_context;
  perform pg_temp.flowos_assert('missing_session_rejected',
    public.flowos_admin_authorize(c.actor,gen_random_uuid())=false);
  perform pg_temp.flowos_assert('nonadmin_authorize_rejected',
    public.flowos_admin_authorize(c.owner_id,gen_random_uuid())=false);
  begin
    perform public.flowos_onboarding_provision(c.owner_id,c.request_id,c.owner_id,true,c.payload);
    raise exception 'Nonadmin actor was accepted';
  exception when insufficient_privilege then
    perform pg_temp.flowos_assert('nonadmin_provision_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_owner(c.owner_id,c.owner_email);
    raise exception 'Nonadmin lookup was accepted';
  exception when insufficient_privilege then
    perform pg_temp.flowos_assert('nonadmin_owner_lookup_rejected',true);
  end;
  r := public.flowos_onboarding_provision(c.actor,c.request_id,c.owner_id,true,c.payload);
  perform pg_temp.flowos_assert('provision_returns_business',r->>'business_id' is not null);
  c.business_id := (r->>'business_id')::uuid;
  update pg_temp.flowos_test_context set business_id=c.business_id;
  perform pg_temp.flowos_assert('business_created',
    (select count(*)=1 from public.businesses where id=c.business_id and slug=c.slug and active));
  perform pg_temp.flowos_assert('public_profile_created',
    (select count(*)=1 from public.business_public_profiles
      where business_id=c.business_id and slug=c.slug and active));
  perform pg_temp.flowos_assert('initial_services_created',
    (select count(*)=2 and min(sort_order)=0 and max(sort_order)=1
      from public.business_services where business_id=c.business_id and active));
  perform pg_temp.flowos_assert('owner_membership_created',
    (select count(*)=1 from public.business_users
      where business_id=c.business_id and user_id=c.owner_id and role='owner'));
  again := public.flowos_onboarding_provision(c.actor,c.request_id,c.owner_id,true,c.payload);
  perform pg_temp.flowos_assert('retry_returns_same_business',again=r);
  perform pg_temp.flowos_assert('retry_does_not_duplicate_services',
    (select count(*)=2 from public.business_services where business_id=c.business_id));
  begin
    perform public.flowos_onboarding_provision(c.actor,c.request_id,c.owner_id,true,
      jsonb_set(c.payload,'{business,name}','"Changed submission"'::jsonb));
    raise exception 'Conflicting request was accepted';
  exception when unique_violation then
    perform pg_temp.flowos_assert('conflicting_request_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_provision(c.actor,c.request_id,c.actor,true,c.payload);
    raise exception 'Request replay changed the owner';
  exception when unique_violation then
    perform pg_temp.flowos_assert('retry_owner_mismatch_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_provision(c.actor,gen_random_uuid(),c.owner_id,true,c.payload);
    raise exception 'Duplicate slug was accepted';
  exception when unique_violation then
    perform pg_temp.flowos_assert('duplicate_slug_rejected',true);
  end;
  begin
    perform public.flowos_onboarding_provision(c.actor,gen_random_uuid(),c.actor,true,
      jsonb_set(c.payload,'{business,slug}',to_jsonb(c.slug || '-mismatch')));
    raise exception 'Mismatched owner was accepted';
  exception when invalid_parameter_value then
    perform pg_temp.flowos_assert('owner_email_mismatch_rejected',true);
  end;
  foreach malformed in array array[
    null::jsonb,'null'::jsonb,'[]'::jsonb,
    jsonb_set(c.payload,'{business}','null'::jsonb),
    jsonb_set(c.payload,'{business,name}','123'::jsonb),
    jsonb_set(c.payload,'{business,tagline}','{}'::jsonb),
    jsonb_set(c.payload,'{services}','null'::jsonb),
    jsonb_set(c.payload,'{services}','{}'::jsonb),
    jsonb_set(c.payload,'{services}','[]'::jsonb),
    jsonb_set(c.payload,'{services}','[null]'::jsonb),
    jsonb_set(c.payload,'{services}','[123]'::jsonb),
    jsonb_set(c.payload,'{services}','["Duplicate","duplicate"]'::jsonb)
  ] loop
    begin
      perform public.flowos_onboarding_provision(c.actor,gen_random_uuid(),c.owner_id,true,malformed);
      raise exception 'Malformed payload was accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  perform pg_temp.flowos_assert('null_and_shape_inputs_rejected',true);
end;
$$;
reset role;

-- Force failure after business/profile/service insertion to prove one failed
-- membership write rolls the entire provisioning call back.
create function pg_temp.flowos_fail_test_membership() returns trigger
language plpgsql security invoker as $$
begin
  if exists(select 1 from public.businesses b cross join pg_temp.flowos_test_context c
    where b.id=new.business_id and b.slug=c.slug || '-rollback') then
    raise exception 'Synthetic rollback verification' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger flowos_onboarding_transaction_test before insert on public.business_users
for each row execute function pg_temp.flowos_fail_test_membership();
update pg_temp.flowos_test_context set atomic_request=gen_random_uuid(),
  counts_before=jsonb_build_object(
    'businesses',(select count(*) from public.businesses),
    'profiles',(select count(*) from public.business_public_profiles),
    'services',(select count(*) from public.business_services),
    'memberships',(select count(*) from public.business_users),
    'requests',(select count(*) from flowos_private.onboarding_requests)
  );
set local role service_role;
do $$
declare c pg_temp.flowos_test_context%rowtype; after_counts jsonb;
begin
  select * into strict c from pg_temp.flowos_test_context;
  begin
    perform public.flowos_onboarding_provision(c.actor,c.atomic_request,c.owner_id,true,
      jsonb_set(c.payload,'{business,slug}',to_jsonb(c.slug || '-rollback')));
    raise exception 'Forced membership failure did not run';
  exception when check_violation then null;
  end;
  after_counts := jsonb_build_object(
    'businesses',(select count(*) from public.businesses),
    'profiles',(select count(*) from public.business_public_profiles),
    'services',(select count(*) from public.business_services),
    'memberships',(select count(*) from public.business_users),
    'requests',(select count(*) from flowos_private.onboarding_requests)
  );
  perform pg_temp.flowos_assert('partial_provisioning_rolls_back',after_counts=c.counts_before);
  insert into public.leads(business_id,customer_name,service,status,source)
    values(c.business_id,'Synthetic verification record','Test service one','new','verification');
end;
$$;

-- Exercise actual role-based RLS with claims from the two existing users.
set local role authenticated;
do $$
declare c pg_temp.flowos_test_context%rowtype; changed integer;
begin
  select * into strict c from pg_temp.flowos_test_context;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',c.owner_id,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',c.owner_id::text,true);
  perform pg_temp.flowos_assert('owner_reads_own_business',
    (select count(*)=1 from public.businesses where id=c.business_id));
  perform pg_temp.flowos_assert('owner_reads_own_lead',
    (select count(*)=1 from public.leads where business_id=c.business_id));
  update public.business_public_profiles set tagline='Owner verification update' where business_id=c.business_id;
  get diagnostics changed = row_count;
  perform pg_temp.flowos_assert('owner_updates_own_profile',changed=1);
  update public.leads set status='contacted' where business_id=c.business_id;
  get diagnostics changed = row_count;
  perform pg_temp.flowos_assert('owner_updates_own_lead',changed=1);
  begin
    perform public.flowos_onboarding_provision(c.actor,gen_random_uuid(),c.owner_id,true,c.payload);
    raise exception 'Browser called service-only provisioning';
  exception when insufficient_privilege then
    perform pg_temp.flowos_assert('browser_provision_call_rejected',true);
  end;
  begin
    insert into public.business_users(business_id,user_id,role) values(c.business_id,c.actor,'owner');
    raise exception 'Browser added tenant membership';
  exception when insufficient_privilege then
    perform pg_temp.flowos_assert('browser_membership_insert_rejected',true);
  end;
  begin
    update public.business_users set role='owner' where business_id=c.business_id;
    raise exception 'Browser changed tenant membership';
  exception when insufficient_privilege then
    perform pg_temp.flowos_assert('browser_membership_update_rejected',true);
  end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',c.actor,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',c.actor::text,true);
  perform pg_temp.flowos_assert('other_tenant_cannot_read_business',
    (select count(*)=0 from public.businesses where id=c.business_id));
  perform pg_temp.flowos_assert('other_tenant_cannot_read_lead',
    (select count(*)=0 from public.leads where business_id=c.business_id));
  perform pg_temp.flowos_assert('other_tenant_cannot_read_membership',
    (select count(*)=0 from public.business_users where business_id=c.business_id));
  update public.business_public_profiles set tagline='Cross tenant attempt' where business_id=c.business_id;
  get diagnostics changed = row_count;
  perform pg_temp.flowos_assert('other_tenant_cannot_update_profile',changed=0);
  update public.leads set status='lost' where business_id=c.business_id;
  get diagnostics changed = row_count;
  perform pg_temp.flowos_assert('other_tenant_cannot_update_lead',changed=0);
end;
$$;
set local role anon;
do $$
declare c pg_temp.flowos_test_context%rowtype;
begin
  select * into strict c from pg_temp.flowos_test_context;
  perform set_config('request.jwt.claims','{}',true);
  perform set_config('request.jwt.claim.sub','',true);
  perform pg_temp.flowos_assert('anon_reads_ready_profile',
    (select count(*)=1 from public.business_public_profiles where business_id=c.business_id and active));
  perform pg_temp.flowos_assert('anon_reads_ready_services',
    (select count(*)=2 from public.business_services where business_id=c.business_id and active));
  perform pg_temp.flowos_assert('anon_cannot_read_leads',
    (select count(*)=0 from public.leads where business_id=c.business_id));
end;
$$;
reset role;
select check_name,passed from pg_temp.flowos_test_results order by check_name;
rollback;
