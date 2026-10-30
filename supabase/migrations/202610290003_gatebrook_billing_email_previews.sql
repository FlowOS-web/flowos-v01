-- QA-only billing email previews. Nothing is sent automatically from this table.
create table if not exists public.gatebrook_billing_email_previews (
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in (
 'trial_welcome','trial_3_day','trial_1_day','trial_converted','trial_expired','reactivated')),
 preview_day date not null default (now() at time zone 'UTC')::date,
 status text not null default 'pending' check(status in ('pending','sent','failed')),
 attempts integer not null default 0,
 resend_email_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(user_id,kind,preview_day)
);
alter table public.gatebrook_billing_email_previews enable row level security;
alter table public.gatebrook_billing_email_previews force row level security;
revoke all on table public.gatebrook_billing_email_previews from PUBLIC, anon, authenticated;
grant select,insert,update,delete on table public.gatebrook_billing_email_previews to service_role;
comment on table public.gatebrook_billing_email_previews is
 'Only authenticated Gatebrook QA testers can request their own preview, with per-type daily limits.';
