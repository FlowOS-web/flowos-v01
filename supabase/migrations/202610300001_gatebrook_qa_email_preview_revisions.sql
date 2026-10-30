-- Preserve previous QA email previews while allowing one new copy when a
-- template/link fix increments the server-managed revision.
alter table public.gatebrook_billing_email_previews
  add column if not exists template_revision integer not null default 1;
alter table public.gatebrook_billing_email_previews
  add constraint gatebrook_billing_email_previews_revision_check
  check (template_revision between 1 and 100);
alter table public.gatebrook_billing_email_previews
  drop constraint gatebrook_billing_email_previews_pkey;
alter table public.gatebrook_billing_email_previews
  add constraint gatebrook_billing_email_previews_pkey
  primary key (user_id,kind,preview_day,template_revision);
comment on column public.gatebrook_billing_email_previews.template_revision is
  'Server-controlled QA email content revision. New revisions permit one fresh email per kind per day without deleting the older delivery audit.';
