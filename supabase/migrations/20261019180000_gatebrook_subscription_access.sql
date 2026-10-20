-- Gatebrook subscription persistence and server-side access enforcement.
create table if not exists public.gatebrook_subscriptions (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_checkout_session_id text unique,
  plan text not null default 'monthly' check (plan in ('monthly','annual')),
  status text not null default 'incomplete' check (status in ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_stripe_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists gatebrook_subscriptions_user_id_key on public.gatebrook_subscriptions(user_id);
create index if not exists gatebrook_subscriptions_status_period_idx on public.gatebrook_subscriptions(status,current_period_end);
alter table public.gatebrook_subscriptions enable row level security;
revoke all on public.gatebrook_subscriptions from anon, authenticated;
drop policy if exists "subscription owners can read own subscription" on public.gatebrook_subscriptions;
create policy "subscription owners can read own subscription" on public.gatebrook_subscriptions for select to authenticated using (user_id = (select auth.uid()));
grant select (business_id,user_id,plan,status,trial_end,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at) on public.gatebrook_subscriptions to authenticated;

create table if not exists public.gatebrook_stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
alter table public.gatebrook_stripe_events enable row level security;
revoke all on public.gatebrook_stripe_events from anon, authenticated;

create or replace function flowos_private.gatebrook_business_has_access(target_business_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.gatebrook_subscriptions s
    where s.business_id = target_business_id and s.status in ('trialing','active')
      and ((s.current_period_end is not null and s.current_period_end > now())
        or (s.status = 'trialing' and s.trial_end is not null and s.trial_end > now()))
  );
$$;
revoke all on function flowos_private.gatebrook_business_has_access(uuid) from public, anon;
grant usage on schema flowos_private to authenticated;
grant execute on function flowos_private.gatebrook_business_has_access(uuid) to authenticated;


drop policy if exists "business users can read their business leads" on public.leads;
create policy "business users can read their business leads" on public.leads for select to authenticated
using (business_id in (select bu.business_id from public.business_users bu where bu.user_id = (select auth.uid())) and flowos_private.gatebrook_business_has_access(business_id));
drop policy if exists "business users can update their business leads" on public.leads;
create policy "business users can update their business leads" on public.leads for update to authenticated
using (business_id in (select bu.business_id from public.business_users bu where bu.user_id = (select auth.uid())) and public.gatebrook_business_has_access(business_id))
with check (business_id in (select bu.business_id from public.business_users bu where bu.user_id = (select auth.uid())) and public.gatebrook_business_has_access(business_id));

drop policy if exists "business users can read their business" on public.businesses;
create policy "business users can read their business" on public.businesses for select to authenticated
using (id in (select bu.business_id from public.business_users bu where bu.user_id = (select auth.uid())) and public.gatebrook_business_has_access(id));
drop policy if exists "business owners can update their business" on public.businesses;
create policy "business owners can update their business" on public.businesses for update to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = businesses.id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(id))
with check (exists (select 1 from public.business_users bu where bu.business_id = businesses.id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(id));

drop policy if exists "authenticated can read public or own profiles" on public.business_public_profiles;
create policy "authenticated can read public or own profiles" on public.business_public_profiles for select to authenticated
using (active = true or (exists (select 1 from public.business_users bu where bu.business_id = business_public_profiles.business_id and bu.user_id = (select auth.uid())) and public.gatebrook_business_has_access(business_id)));
drop policy if exists "authenticated can read public or own services" on public.business_services;
create policy "authenticated can read public or own services" on public.business_services for select to authenticated
using (active = true or (exists (select 1 from public.business_users bu where bu.business_id = business_services.business_id and bu.user_id = (select auth.uid())) and public.gatebrook_business_has_access(business_id)));

drop policy if exists "business owners can update their public profile" on public.business_public_profiles;
create policy "business owners can update their public profile" on public.business_public_profiles for update to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = business_public_profiles.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id))
with check (exists (select 1 from public.business_users bu where bu.business_id = business_public_profiles.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));

drop policy if exists "business_request_forms_owner_manage" on public.business_request_forms;
create policy "business_request_forms_owner_manage" on public.business_request_forms for all to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = business_request_forms.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id))
with check (exists (select 1 from public.business_users bu where bu.business_id = business_request_forms.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));

drop policy if exists "business owners can add services" on public.business_services;
create policy "business owners can add services" on public.business_services for insert to authenticated
with check (exists (select 1 from public.business_users bu where bu.business_id = business_services.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));
drop policy if exists "business owners can delete services" on public.business_services;
create policy "business owners can delete services" on public.business_services for delete to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = business_services.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));
drop policy if exists "business owners can update services" on public.business_services;
create policy "business owners can update services" on public.business_services for update to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = business_services.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id))
with check (exists (select 1 from public.business_users bu where bu.business_id = business_services.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));

drop policy if exists "gatebrook_business_owner_review_read" on public.gatebrook_request_reviews;
create policy "gatebrook_business_owner_review_read" on public.gatebrook_request_reviews for select to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = gatebrook_request_reviews.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));

drop policy if exists "lead_custom_answers_owner_read" on public.lead_custom_answers;
create policy "lead_custom_answers_owner_read" on public.lead_custom_answers for select to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = lead_custom_answers.business_id and bu.user_id = (select auth.uid()) and bu.role = any(array['owner','manager'])) and public.gatebrook_business_has_access(business_id));
drop policy if exists "lead_custom_answers_owner_write" on public.lead_custom_answers;
create policy "lead_custom_answers_owner_write" on public.lead_custom_answers for all to authenticated
using (exists (select 1 from public.business_users bu where bu.business_id = lead_custom_answers.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id))
with check (exists (select 1 from public.business_users bu where bu.business_id = lead_custom_answers.business_id and bu.user_id = (select auth.uid()) and bu.role = 'owner') and public.gatebrook_business_has_access(business_id));
