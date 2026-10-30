-- Scheduled Gatebrook email delivery. HTTP authorization key stays in a
-- private Postgres table and is never embedded in the cron job SQL.
create schema if not exists extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function flowos_private.gatebrook_billing_dispatch_tick()
returns bigint
language plpgsql security definer set search_path=''
as $fn$
declare v_token text;
declare v_request_id bigint;
begin
  select token into v_token
    from flowos_private.gatebrook_billing_job_auth
   where singleton=true;
  if v_token is null or length(v_token)<>64 then
    raise exception 'Billing scheduler authorization is not configured';
  end if;
  select net.http_post(
    url:='https://mxyikhxpzijrdrgowmxr.supabase.co/functions/v1/gatebrook-billing-email-dispatch',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-gatebrook-billing-job',v_token
    ),
    body:='{"trigger":"supabase_cron"}'::jsonb,
    timeout_milliseconds:=15000
  ) into v_request_id;
  return v_request_id;
end;
$fn$;
revoke all on function flowos_private.gatebrook_billing_dispatch_tick()
  from PUBLIC,anon,authenticated,service_role;

-- Poll every ten minutes: reminders are delivered close to 72h and 24h
-- prior to the actual Stripe trial-end timestamp.
select cron.schedule(
  'gatebrook-billing-email-dispatch',
  '*/10 * * * *',
  'select flowos_private.gatebrook_billing_dispatch_tick();'
);
