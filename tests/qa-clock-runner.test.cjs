const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const runner=read("supabase/functions/gatebrook-qa-clock-runner/index.ts");
const webhook=read("supabase/functions/gatebrook-qa-webhook/index.ts");
const migration=read("supabase/migrations/202610290004_gatebrook_qa_clock_test_run.sql");
const qaStatus=read("supabase/functions/gatebrook-qa-status/index.ts");
test("runner requires private 256-bit token and rejects live keys",()=>{
 assert.match(runner,/gatebrook_qa_verify_clock_runner/);
 assert.match(runner,/if\(token\.length!==64\)return reply\(401/);
 assert.match(runner,/sk\|rk\)_test_/);
 assert.match(runner,/if\(data\.livemode===true\)throw Error/);
 assert.doesNotMatch(runner,/Deno\.env\.get\("STRIPE_SECRET_KEY"\)/);
 assert.match(migration,/flowos_private\.gatebrook_qa_clock_runner_auth/);
 assert.match(migration,/revoke all on function flowos_private\.gatebrook_qa_clock_action/);
});
test("runner reuses only approved QA owner and never creates or impersonates auth users",()=>{
 assert.match(runner,/\.eq\("name","J&J Plumbing QA"\)/);
 assert.match(runner,/gatebrook_qa_testers/);
 assert.match(runner,/Automated Failed Renewal QA/);
 assert.doesNotMatch(runner,/admin\.createUser|admin\.generateLink|auth\.verifyOtp/);
 assert.doesNotMatch(runner,/api\.resend\.com|smtp|notify-new-lead/);
 assert.match(runner,/qa_env\]":ACCOUNT/);
});
test("runner cannot write production subscription or workspace tables",()=>{
 assert.match(runner,/\.from\("gatebrook_qa_subscriptions"\)/);
 assert.match(runner,/\.from\("gatebrook_qa_workspaces"\)/);
 assert.match(runner,/\.from\("gatebrook_qa_clock_runs"\)/);
 assert.doesNotMatch(runner,/\.from\(["'](?:gatebrook_subscriptions|businesses|business_public_profiles|leads)["']\)/);
});
test("fixture cannot bypass verified normal Checkout flow",()=>{
 assert.match(webhook,/const clockFixture=sub\.metadata\?\.qa_env==="gatebrook_qa_clocktest"/);
 assert.match(webhook,/record\.stripe_checkout_session_id!==null/);
 assert.match(webhook,/record\.stripe_subscription_id!==sub\.id/);
 assert.match(webhook,/run\.stripe_subscription_id!==sub\.id/);
 assert.match(webhook,/run\.workspace_id!==workspaceId/);
 assert.match(webhook,/run\.owner_user_id!==ownerId/);
 assert.match(webhook,/customer\.test_clock!==run\.stripe_clock_id/);
 assert.match(webhook,/session\.status!=="complete"/);
});
test("payment failure fixture uses Stripe's charge-after-attachment test card",()=>{
 assert.match(runner,/pm_card_chargeCustomerFail\/attach/);
 assert.match(runner,/pm\.card\?\.last4!=="0341"/);
 assert.match(runner,/default_payment_method:pm\.id/);
 assert.match(runner,/amount_remaining!==14900/);
 assert.match(runner,/invoice\.attempt_count>=1/);
});
test("recovery uses previous working test method and retries the exact unpaid invoice",()=>{
 assert.match(runner,/default_payment_method:run\.successful_payment_method_id/);
 assert.match(runner,/invoices\/"\+encodeURIComponent\(invoiceId\)\+"\/pay"/);
 assert.match(runner,/if\(local\?\.status!=="past_due"&&local\?\.status!=="unpaid"\)/);
 assert.match(runner,/stage="recovered"/);
});
test("runner preserves browser-authenticated gate and requires ownership-selected workspace",()=>{
 assert.doesNotMatch(runner,/auth\.admin\.generateLink|auth\.verifyOtp/);
 assert.match(runner,/result\.authenticated_gate=await statusViaAuth\(run\)/);
 assert.match(qaStatus,/workspaceId=new URL\(req\.url\)\.searchParams\.get\("workspace_id"\)/);
 assert.match(qaStatus,/wsQuery=wsQuery\.eq\("id",workspaceId\)/);
 assert.match(qaStatus,/\.eq\("owner_user_id",user\.id\)/);
 assert.match(qaStatus,/\["trialing","active"\]\.includes\(status\)/);
});
test("run journal has no unauthenticated client grants and is synthetic-only",()=>{
 assert.match(migration,/alter table public\.gatebrook_qa_clock_runs force row level security/);
 assert.match(migration,/revoke all on public\.gatebrook_qa_clock_runs from public, anon, authenticated/);
 assert.match(migration,/create table if not exists flowos_private\.gatebrook_qa_clock_runner_auth/);
 assert.match(migration,/not in \('setup','activate','prepare_failure','fail_renewal','recover','inspect'\)/);
});

test("existing QA checkout uses oldest workspace and cannot switch billing workspace via query",()=>{
 const source=read("supabase/functions/gatebrook-qa-checkout/index.ts");
 assert.match(source,/\.order\("created_at",\{ascending:true\}\)\.limit\(1\)\.maybeSingle\(\)/);
 assert.doesNotMatch(source,/body\.workspace_id|req\.url\.searchParams/);
});
test("selected QA dashboard asks status service with a real signed-in user token",()=>{
 const page=read("qa-dashboard.html");
 assert.match(page,/QA_WORKSPACE_ID=new URLSearchParams\(location\.search\)\.get\("workspace_id"\)/);
 assert.match(page,/auth\.getSession\(\)/);
 assert.match(page,/Authorization":"Bearer "\+session\.access_token/);
});
