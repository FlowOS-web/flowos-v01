-- Controlled Stripe Billing test-clock scenario. Only synthetic QA identities
-- and Stripe sandbox keys; no production workspace, price, customer, or email.
create table if not exists public.gatebrook_qa_clock_runs (
  id uuid primary key default gen_random_uuid(),
  label text not null unique default 'gatebrook-failed-renewal-2026-10',
  owner_user_id uuid unique references auth.users(id) on delete set null,
  workspace_id uuid unique references public.gatebrook_qa_workspaces(id) on delete set null,
  stripe_clock_id text unique,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_renewal_invoice_id text,
  successful_payment_method_id text,
  failed_payment_method_id text,
  stage text not null default 'new',
  access_before boolean,
  access_after_failure boolean,
  access_after_recovery boolean,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gatebrook_qa_clock_runs enable row level security;
alter table public.gatebrook_qa_clock_runs force row level security;
revoke all on public.gatebrook_qa_clock_runs from public, anon, authenticated;
grant select,insert,update,delete on public.gatebrook_qa_clock_runs to service_role;

create table if not exists flowos_private.gatebrook_qa_clock_runner_auth (
  singleton boolean primary key default true check(singleton),
  token text not null check(length(token)=64),
  created_at timestamptz not null default now()
);
revoke all on flowos_private.gatebrook_qa_clock_runner_auth from public, anon, authenticated, service_role;
insert into flowos_private.gatebrook_qa_clock_runner_auth(singleton,token)
select true,encode(gen_random_bytes(32),'hex')
where not exists (select 1 from flowos_private.gatebrook_qa_clock_runner_auth where singleton=true);

create or replace function public.gatebrook_qa_verify_clock_runner(p_token text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(length(p_token)=64 and exists(
    select 1 from flowos_private.gatebrook_qa_clock_runner_auth
    where singleton=true and token=p_token
  ),false);
$$;
revoke all on function public.gatebrook_qa_verify_clock_runner(text) from PUBLIC,anon,authenticated;
grant execute on function public.gatebrook_qa_verify_clock_runner(text) to service_role;

create or replace function flowos_private.gatebrook_qa_clock_action(p_action text)
returns bigint language plpgsql volatile security definer set search_path=''
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_action not in ('setup','activate','prepare_failure','fail_renewal','recover','inspect') then
    raise exception 'Unsupported QA-only clock action';
  end if;
  select token into v_token from flowos_private.gatebrook_qa_clock_runner_auth where singleton=true;
  if v_token is null then raise exception 'QA clock runner authorization unavailable'; end if;
  select net.http_post(
    url:='https://mxyikhxpzijrdrgowmxr.supabase.co/functions/v1/gatebrook-qa-clock-runner',
    headers:=jsonb_build_object('Content-Type','application/json','x-gatebrook-qa-clock-runner',v_token),
    body:=jsonb_build_object('action',p_action),
    timeout_milliseconds:=60000
  ) into v_request_id;
  return v_request_id;
end;
$$;
revoke all on function flowos_private.gatebrook_qa_clock_action(text)
from PUBLIC,anon,authenticated,service_role;
comment on table public.gatebrook_qa_clock_runs is
  'Synthetic test-clock subscription lifecycle only; not visible to browsers or used by live billing.';
