const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const template=read("supabase/functions/gatebrook-billing-email-dispatch/email-template.ts");
const worker=read("supabase/functions/gatebrook-billing-email-dispatch/index.ts");
const preview=read("supabase/functions/gatebrook-billing-email-preview/index.ts");
const migration=read("supabase/migrations/202610290001_gatebrook_billing_email_queue.sql");
const schedule=read("supabase/migrations/202610290002_gatebrook_billing_email_cron.sql");
const page=read("qa-dashboard.html");
function render(){
  const js=template
    .replace(/export type BillingEmailKind =[\s\S]*?;\n/,"")
    .replace(/export type BillingEmailDetails = \{[\s\S]*?\};\n/,"")
    .replace(/const escapeHtml=\(v:unknown\)/,"const escapeHtml=(v)")
    .replace(/const date=\(iso:string\|null\)/,"const date=(iso)")
    .replace(/export function renderBillingEmail\(kind:BillingEmailKind, d:BillingEmailDetails\)/,"function renderBillingEmail(kind,d)")
    .replace(/let fields:Array<\[string,string\]>=\[\]/,"let fields=[]");
  return new Function(js+"; return renderBillingEmail;")();
}
const kinds=["trial_welcome","trial_3_day","trial_1_day","trial_converted","trial_expired","reactivated"];
test("all six billing email templates render HTML and plain text",()=>{
  const f=render();
  for(const kind of kinds){
    const item=f(kind,{businessName:"QA Plumbing",trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"});
    assert.ok(item.subject.length>15);
    assert.match(item.html,/GATEBROOK/);
    assert.match(item.html,/https:\/\/gatebrook.work\/billing.html/);
    assert.match(item.text,/https:\/\/gatebrook.work\/billing.html/);
    assert.match(item.text,/QA Plumbing/);
  }
});
test("billing templates escape malicious user-supplied business names",()=>{
  const result=render()("trial_welcome",{
    businessName:'<img src=x onerror="oops()"> & Co',
    trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"
  });
  assert.doesNotMatch(result.html,/<img src=x/);
  assert.match(result.html,/&lt;img src=x onerror=&quot;oops\(\)&quot;&gt; &amp; Co/);
});
test("first trial email states trial period, automatic payment, and cancellation",()=>{
  const item=render()("trial_welcome",{businessName:"QA",trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"});
  assert.match(item.text,/seven-day trial/i);
  assert.match(item.text,/\$149\/month/);
  assert.match(item.text,/automatically renew/i);
  assert.match(item.text,/cancel before the trial ends/i);
  assert.match(item.text,/UTC/);
});
test("final reminders explicitly say how to avoid the first charge",()=>{
  const f=render();
  for(const kind of ["trial_3_day","trial_1_day"]){
    const item=f(kind,{businessName:"QA",trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"});
    assert.match(item.text,/cancel before (?:your|the) trial ends/i);
    assert.match(item.text,/\$149\/month/);
  }
});
test("annual billing variant mentions the annual price",()=>{
 const item=render()("reactivated",{businessName:"QA",trialEnd:null,plan:"annual"});
 assert.match(item.text,/\$1,490\/year/);
});
function scanHarness(priorState=null){
  let state=priorState;
  const jobs=[];
  const db={
    from(name){
      assert.equal(name,"gatebrook_billing_email_state");
      return {
        select:()=>({eq:()=>({maybeSingle:async()=>({data:state,error:null})})}),
        upsert:async(value)=>{state=value;return {error:null}}
      };
    }
  };
  const begin=worker.indexOf("async function scan(row:SubscriptionRow)");
  const end=worker.indexOf("async function stripe(path:string)",begin);
  assert.ok(begin>=0&&end>begin,"Expected scan() in production dispatcher");
  const body=worker.slice(begin,end).replace("async function scan(row:SubscriptionRow)","async function scan(row)");
  const enqueue=async(row,kind,cycle,due)=>{jobs.push({kind,cycle,due,subscriptionId:row.stripe_subscription_id})};
  const scan=new Function("db","enqueue","nowIso","ms","inactive","Date",
    body+"; return scan;")(
    db,enqueue,()=>new Date().toISOString(),
    v=>{const n=v?Date.parse(v):NaN;return Number.isFinite(n)?n:null},
    new Set(["canceled","paused","unpaid","incomplete_expired"]),Date
  );
  return {scan,jobs,get state(){return state}};
}
const makeRow=(overrides={})=>({
  business_id:"test-business",user_id:"test-owner",
  stripe_subscription_id:"sub_mock_live",status:"trialing",
  trial_end:new Date(Date.now()+7*864e5).toISOString(),
  created_at:new Date().toISOString(),
  current_period_end:null,cancel_at_period_end:false,
  plan:"monthly",...overrides
});
test("new 7-day trial queues welcome, 3-day and 1-day notices",async()=>{
  const h=scanHarness();
  const row=makeRow();
  await h.scan(row);
  assert.deepEqual(h.jobs.map(x=>x.kind),["trial_welcome","trial_3_day","trial_1_day"]);
  assert.equal(Date.parse(h.jobs[1].due),Date.parse(row.trial_end)-3*864e5);
  assert.equal(Date.parse(h.jobs[2].due),Date.parse(row.trial_end)-864e5);
});
test("a converted trial queues paid confirmation once observed",async()=>{
  const trialEnd=new Date(Date.now()-3600e3).toISOString();
  const prior={last_status:"trialing",last_trial_end:trialEnd,
    stripe_subscription_id:"sub_mock_live",transition_seq:0};
  const h=scanHarness(prior);
  await h.scan(makeRow({status:"active",trial_end:trialEnd}));
  assert.deepEqual(h.jobs.map(x=>x.kind),["trial_converted"]);
});
test("expired access and subsequent reactivation queue their own notices",async()=>{
  const prior={last_status:"trialing",last_trial_end:null,
    stripe_subscription_id:"sub_mock_live",transition_seq:0};
  const h=scanHarness(prior);
  await h.scan(makeRow({status:"canceled"}));
  await h.scan(makeRow({status:"active"}));
  assert.deepEqual(h.jobs.map(x=>x.kind),["trial_expired","reactivated"]);
  assert.notEqual(h.jobs[0].cycle,h.jobs[1].cycle);
});
test("unpaid sessions and QA subscriptions never join the production scan",()=>{
 assert.match(worker,/\.from\("gatebrook_subscriptions"\)/);
 assert.match(worker,/\.not\("stripe_subscription_id","is",null\)/);
 assert.doesNotMatch(worker,/\.from\("gatebrook_qa_subscriptions"\)/);
});
test("delivery checks live Stripe, metadata ownership, and cancellation",()=>{
 assert.match(worker,/sub\.livemode!==true/);
 assert.match(worker,/sub\.metadata\?\.business_id!==local\.business_id/);
 assert.match(worker,/sub\.metadata\?\.user_id!==local\.user_id/);
 assert.match(worker,/sub\.cancel_at_period_end/);
 assert.match(worker,/invoice\.status!=="paid"/);
 assert.match(worker,/isReminder&&\(now<start\|\|now>start\+12\*3600e3\)/);
});
test("Resend email retries use an idempotency key",()=>{
 assert.match(worker,/"Idempotency-Key":"gatebrook-"\+job\.id/);
 assert.match(worker,/gatebrook_billing_claim_email_jobs/);
 assert.match(worker,/status:"queued"/);
});
test("private job authentication is enforced before sending",()=>{
 assert.match(worker,/gatebrook_billing_verify_job_token/);
 assert.match(worker,/if\(authError\|\|authorized!==true\)return out\(401/);
 assert.match(migration,/revoke all on function public\.gatebrook_billing_verify_job_token/);
 assert.match(migration,/grant execute on function public\.gatebrook_billing_verify_job_token\(text\) to service_role/);
 assert.match(schedule,/flowos_private\.gatebrook_billing_job_auth/);
 assert.doesNotMatch(schedule,/sk_live_|re_[a-zA-Z0-9]{16}/);
});
test("public and authenticated clients cannot access the email journal",()=>{
 assert.match(migration,/force row level security/);
 assert.match(migration,/from PUBLIC, anon, authenticated/);
 assert.match(migration,/for update skip locked/);
});
test("cron schedule invokes a private function every ten minutes",()=>{
 assert.match(schedule,/'\*\/10 \* \* \* \*'/);
 assert.match(schedule,/net\.http_post/);
 assert.match(schedule,/flowos_private\.gatebrook_billing_dispatch_tick/);
});
test("QA email preview is limited to approved account and its own address",()=>{
 assert.match(preview,/db\.auth\.getUser\(token\)/);
 assert.match(preview,/gatebrook_qa_testers/);
 assert.match(preview,/user\.email_confirmed_at/);
 assert.match(preview,/to:\[user\.email\]/);
 assert.match(preview,/gatebrook_billing_email_previews/);
 assert.doesNotMatch(preview,/body\.to|body\.email/);
 assert.match(page,/gatebrook-billing-email-preview/);
});

test("returning customer with a new Stripe subscription gets reactivation instead of a second welcome",async()=>{
  const h=scanHarness({
    last_status:"canceled",last_trial_end:"2026-10-28T00:00:00Z",
    stripe_subscription_id:"sub_previous",transition_seq:2
  });
  await h.scan(makeRow({
    stripe_subscription_id:"sub_reactivated",
    status:"trialing",
    trial_end:new Date(Date.now()+7*864e5).toISOString()
  }));
  assert.ok(h.jobs.some(x=>x.kind==="reactivated"));
  assert.ok(!h.jobs.some(x=>x.kind==="trial_welcome"));
  assert.ok(h.jobs.some(x=>x.kind==="trial_3_day"));
});
test("both production sender and QA preview reject unverified sender fallback",()=>{
  assert.match(worker,/FROM_EMAIL\.includes\("@resend\.dev"\)/);
  assert.match(preview,/FROM\.includes\("@resend\.dev"\)/);
});

const previewLinks=read("supabase/functions/gatebrook-billing-email-preview/preview-links.ts");
function renderQaPreview(){
  const javascript=previewLinks
    .replace(/export const /g,"const ")
    .replace(/export type PreviewMessage = \\{[\\s\\S]*?\\};\\n/,"")
    .replace(/export function prepareBillingPreview\\(sample: PreviewMessage\\): PreviewMessage/,
             "function prepareBillingPreview(sample)");
  return new Function(javascript+"; return prepareBillingPreview;")();
}
test("all six QA email previews link only to the QA dashboard, never live billing",()=>{
  const compose=render();
  const prepare=renderQaPreview();
  for(const kind of kinds){
    const sample=compose(kind,{businessName:"QA Plumbing",
      trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"});
    const email=prepare(sample);
    assert.match(email.subject,/^\\[Gatebrook QA test\\]/);
    assert.match(email.html,/https:\\/\\/gatebrook\\.work\\/qa-dashboard\\.html/);
    assert.match(email.text,/https:\\/\\/gatebrook\\.work\\/qa-dashboard\\.html/);
    assert.doesNotMatch(email.html,/https:\\/\\/gatebrook\\.work\\/billing\\.html/);
    assert.doesNotMatch(email.text,/https:\\/\\/gatebrook\\.work\\/billing\\.html/);
    assert.match(email.text,/not a real billing notice/i);
    assert.match(email.html,/not a real billing notice/i);
  }
});
test("production templates retain real billing links while QA preview changes links",()=>{
  const compose=render();
  const prepare=renderQaPreview();
  const original=compose("trial_1_day",{
    businessName:"QA Plumbing",trialEnd:"2026-11-06T00:02:50Z",plan:"monthly"
  });
  const previewEmail=prepare(original);
  assert.match(original.text,/https:\\/\\/gatebrook\\.work\\/billing\\.html/);
  assert.doesNotMatch(original.text,/qa-dashboard\\.html/);
  assert.match(previewEmail.text,/qa-dashboard\\.html/);
  assert.match(preview,/prepareBillingPreview\\(sample\\)/);
  assert.match(page,/Test-email links lead back to this QA dashboard/);
});
