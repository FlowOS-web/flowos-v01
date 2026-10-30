-- Gatebrook subscription lifecycle email queue. Production records only;
-- QA subscriptions never appear in these tables.
create table if not exists public.gatebrook_billing_email_state (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  stripe_subscription_id text not null,
  last_status text not null,
  last_trial_end timestamptz,
  transition_seq integer not null default 0,
  last_seen_at timestamptz not null default now()
);
create table if not exists public.gatebrook_billing_email_jobs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  stripe_subscription_id text not null,
  kind text not null check (kind in ('trial_welcome','trial_3_day','trial_1_day','trial_converted','trial_expired','reactivated')),
  cycle_key text not null,
  due_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','processing','sent','skipped','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_at timestamptz,
  sent_at timestamptz,
  resend_email_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stripe_subscription_id,kind,cycle_key)
);
create index if not exists gatebrook_billing_email_jobs_due_idx on public.gatebrook_billing_email_jobs (status,due_at);
create index if not exists gatebrook_billing_email_jobs_workspace_idx on public.gatebrook_billing_email_jobs (business_id);
alter table public.gatebrook_billing_email_state enable row level security;
alter table public.gatebrook_billing_email_state force row level security;
alter table public.gatebrook_billing_email_jobs enable row level security;
alter table public.gatebrook_billing_email_jobs force row level security;
revoke all on table public.gatebrook_billing_email_state, public.gatebrook_billing_email_jobs
  from PUBLIC, anon, authenticated;
grant select,insert,update,delete on table public.gatebrook_billing_email_state,
  public.gatebrook_billing_email_jobs to service_role;

-- The random invocation token is generated inside Postgres and never copied into
-- Github, Edge Function environment variables, Supabase logs, or chat.
create table if not exists flowos_private.gatebrook_billing_job_auth (
  singleton boolean primary key default true check (singleton),
  token text not null check (length(token) = 64),
  created_at timestamptz not null default now()
);
revoke all on table flowos_private.gatebrook_billing_job_auth from PUBLIC, anon, authenticated, service_role;
insert into flowos_private.gatebrook_billing_job_auth (singleton,token)
select true, encode(gen_random_bytes(32),'hex')
where not exists (select 1 from flowos_private.gatebrook_billing_job_auth where singleton=true);

-- These two routines can only be invoked through the server-side service role.
create or replace function public.gatebrook_billing_verify_job_token(p_token text)
returns boolean language sql stable security definer set search_path = ''
as $fn$
  select coalesce(
    length(p_token)=64 and exists(
      select 1 from flowos_private.gatebrook_billing_job_auth
      where singleton = true and token = p_token
    ),false
  );
$fn$;
revoke all on function public.gatebrook_billing_verify_job_token(text) from PUBLIC, anon, authenticated;
grant execute on function public.gatebrook_billing_verify_job_token(text) to service_role;

create or replace function public.gatebrook_billing_claim_email_jobs(p_limit integer default 12)
returns setof public.gatebrook_billing_email_jobs
language sql volatile security definer set search_path = ''
as $fn$
  with available as (
    select j.id from public.gatebrook_billing_email_jobs j
    where j.due_at <= now()
      and (j.status='queued' or
          (j.status='processing' and j.locked_at < now() - interval '10 minutes'))
      and j.attempts < 6
    order by j.due_at asc, j.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,12),25))
  )
  update public.gatebrook_billing_email_jobs j
     set status='processing', attempts=j.attempts+1,locked_at=now(),updated_at=now()
    from available a where j.id = a.id
  returning j.*;
$fn$;
revoke all on function public.gatebrook_billing_claim_email_jobs(integer) from PUBLIC, anon, authenticated;
grant execute on function public.gatebrook_billing_claim_email_jobs(integer) to service_role;

comment on table public.gatebrook_billing_email_jobs is
  'Production subscription email delivery journal. No authenticated client access. No QA data.';
