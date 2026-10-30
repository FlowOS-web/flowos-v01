-- Permit multiple, independently tested sandbox workspaces for the approved
-- tester. Existing J&J workspace remains the default oldest workspace.
alter table public.gatebrook_qa_workspaces
  drop constraint if exists gatebrook_qa_workspaces_owner_user_id_key;
create unique index if not exists gatebrook_qa_workspaces_owner_name_key
  on public.gatebrook_qa_workspaces(owner_user_id,name);
comment on index public.gatebrook_qa_workspaces_owner_name_key is
  'QA-only multiple workspaces for a single allowlisted tester, with unique names.';
