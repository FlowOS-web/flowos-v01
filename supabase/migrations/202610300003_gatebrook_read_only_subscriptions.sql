-- Gatebrook read-only access for former subscribers.
-- Database access is tenant-scoped; this never grants anonymous or cross-tenant
-- access to leads, customer details, forms or business settings.

create or replace function flowos_private.gatebrook_business_can_view(target_business_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $fn$
  select flowos_private.gatebrook_business_has_access(target_business_id)
    or exists (
      select 1 from public.gatebrook_subscriptions s
      where s.business_id=target_business_id
        and s.stripe_subscription_id is not null
        and s.status in ('trialing','active','past_due','unpaid','paused','canceled')
    );
$fn$;
revoke all on function flowos_private.gatebrook_business_can_view(uuid)
  from PUBLIC, anon;
grant execute on function flowos_private.gatebrook_business_can_view(uuid)
  to authenticated,service_role;

-- READING is allowed only to workspace members with a past or present,
-- successfully created Stripe subscription. No pending unpaid setup gets access.
drop policy if exists "business users can read their business" on public.businesses;
create policy "business users can read their business" on public.businesses
for select to authenticated
using (
  exists (select 1 from public.business_users bu
    where bu.business_id=businesses.id and bu.user_id=(select auth.uid()))
  and flowos_private.gatebrook_business_can_view(id)
);

drop policy if exists "business users can read their business leads" on public.leads;
create policy "business users can read their business leads" on public.leads
for select to authenticated
using (
  exists (select 1 from public.business_users bu
    where bu.business_id=leads.business_id and bu.user_id=(select auth.uid()))
  and flowos_private.gatebrook_business_can_view(business_id)
);

drop policy if exists "lead_custom_answers_owner_read" on public.lead_custom_answers;
create policy "lead_custom_answers_owner_read" on public.lead_custom_answers
for select to authenticated
using (
  exists (select 1 from public.business_users bu
    where bu.business_id=lead_custom_answers.business_id
      and bu.user_id=(select auth.uid())
      and bu.role in ('owner','manager'))
  and flowos_private.gatebrook_business_can_view(business_id)
);

drop policy if exists "gatebrook_business_owner_review_read" on public.gatebrook_request_reviews;
create policy "gatebrook_business_owner_review_read" on public.gatebrook_request_reviews
for select to authenticated
using (
  exists (select 1 from public.business_users bu
    where bu.business_id=gatebrook_request_reviews.business_id
      and bu.user_id=(select auth.uid()) and bu.role='owner')
  and flowos_private.gatebrook_business_can_view(business_id)
);

drop policy if exists "authenticated can read public or own profiles"
  on public.business_public_profiles;
create policy "authenticated can read public or own profiles"
on public.business_public_profiles for select to authenticated
using (
  active = true
  or (
    exists (select 1 from public.business_users bu
      where bu.business_id=business_public_profiles.business_id
        and bu.user_id=(select auth.uid()))
    and flowos_private.gatebrook_business_can_view(business_id)
  )
);

drop policy if exists "authenticated can read public or own services"
  on public.business_services;
create policy "authenticated can read public or own services"
on public.business_services for select to authenticated
using (
  active = true
  or (
    exists (select 1 from public.business_users bu
      where bu.business_id=business_services.business_id
        and bu.user_id=(select auth.uid()))
    and flowos_private.gatebrook_business_can_view(business_id)
  )
);

-- Existing "ALL" policies on form and answers continue to deny every write
-- after expiration because they explicitly require has_access. Add SELECT-only
-- owner policies for the expired case.
drop policy if exists "gatebrook_read_only_request_form" on public.business_request_forms;
create policy "gatebrook_read_only_request_form" on public.business_request_forms
for select to authenticated
using (
  exists (select 1 from public.business_users bu
    where bu.business_id=business_request_forms.business_id
      and bu.user_id=(select auth.uid()) and bu.role='owner')
  and flowos_private.gatebrook_business_can_view(business_id)
);

drop policy if exists "gatebrook_read_only_answers" on public.lead_custom_answers;
-- already covered by lead_custom_answers_owner_read, so no extra policy needed.

-- IMPORTANT: all UPDATE, INSERT, DELETE and ALL policies remain unchanged:
-- the write entitlement is still flowos_private.gatebrook_business_has_access.
