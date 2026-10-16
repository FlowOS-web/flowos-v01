-- Gatebrook: permanent business cleanup, used only through the authenticated
-- platform Admin Console. This migration deletes NO existing business.
--
-- The Edge Function verifies the bearer token, live session, and platform-admin
-- membership; this RPC rechecks the active admin role and exact slug phrase.
-- Service-role-only EXECUTE means browsers cannot call it directly.
create or replace function public.flowos_admin_delete_business(
  p_actor uuid,
  p_business uuid,
  p_confirmation text
) returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_slug text;
  v_removed integer;
begin
  perform flowos_private.require_admin(p_actor);

  if p_business is null or p_confirmation is null or length(p_confirmation)>100 then
    raise exception 'Select a business and enter the required confirmation'
      using errcode='22023';
  end if;

  -- Lock exactly one selected business. A missing row is not silently treated
  -- as successful, and the slug is checked against the CURRENT database row.
  select b.slug into v_slug
  from public.businesses b
  where b.id=p_business
  for update;

  if not found then
    raise exception 'Business no longer exists' using errcode='P0002';
  end if;

  if p_confirmation is distinct from ('DELETE ' || v_slug) then
    raise exception 'Confirmation does not match the business link name'
      using errcode='22023';
  end if;

  -- This non-cascading foreign key must be removed before the business row.
  -- Removing it also invalidates any pending owner onboarding/setup record.
  delete from flowos_private.onboarding_requests
  where business_id=p_business;

  -- Declared ON DELETE CASCADE FKs clean up the selected business's public
  -- profile, service catalog, business_users memberships, leads, request
  -- review queue, and request rate-limit history together in this transaction.
  delete from public.businesses where id=p_business;
  get diagnostics v_removed = row_count;

  if v_removed<>1 then
    raise exception 'Business deletion could not be verified';
  end if;

  -- Never delete auth.users: a sign-in can be shared among businesses and
  -- removing the business membership is the correct scoped operation.
  return jsonb_build_object(
    'deleted',true,
    'business_id',p_business,
    'slug',v_slug
  );
end;
$function$;

revoke all on function public.flowos_admin_delete_business(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.flowos_admin_delete_business(uuid,uuid,text)
  to service_role;
