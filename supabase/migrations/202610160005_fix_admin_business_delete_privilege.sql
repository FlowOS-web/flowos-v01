-- Fix Gatebrook Admin Console business deletion when an enrollment exists.
-- The service_role client is intentionally NOT allowed to DELETE rows directly
-- from the private onboarding_requests table. Running the tightly scoped,
-- service-role-only and administrator-checked RPC as its postgres owner lets
-- this one transaction remove the linked enrollment before the business.
--
-- Function already has SET search_path = '' and uses qualified table/function
-- references throughout. It rechecks the active platform admin, selected
-- business ID, and exact 'DELETE <slug>' confirmation before any deletion.
ALTER FUNCTION public.flowos_admin_delete_business(uuid,uuid,text)
  SECURITY DEFINER;

-- Preserve the limited RPC surface; no direct table DELETE grants.
REVOKE ALL ON FUNCTION public.flowos_admin_delete_business(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowos_admin_delete_business(uuid,uuid,text)
  TO service_role;
