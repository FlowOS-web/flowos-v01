const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const webhook=read("supabase/functions/gatebrook-stripe-webhook/index.ts");
const access=read("supabase/functions/gatebrook-access/index.ts");
const requestMigration=read("supabase/migrations/202610300002_gatebrook_request_subscription_enforcement.sql");
const fixture=({status="active",stripeId="sub_live_current",checkoutId="cs_live_recent",userId="test-user",owner=true}={})=>{
  const tables={
    business_users:owner?{role:"owner"}:null,
    gatebrook_subscriptions:{user_id:userId,status,stripe_subscription_id:stripeId,stripe_checkout_session_id:checkoutId}
  };
  const db={from(table){
    assert.ok(table in tables,"Only approved database tables may be read");
    return {select(){return this},eq(){return this},async maybeSingle(){return {data:tables[table],error:null}}};
  }};
  const session={id:checkoutId,livemode:true,status:"complete",mode:"subscription",subscription:"sub_live_new",
    client_reference_id:userId,metadata:{business_id:"business-1",user_id:userId}};
  return {db,session};
};
function enrollmentGuard(input){
 const from=webhook.indexOf("async function subscriptionMatchesEnrollment(");
 const end=webhook.indexOf("\nfunction epoch(",from);
 assert.ok(from>=0&&end>from,"Expected actual subscription verification function");
 const snippet=webhook.slice(from,end);
 const start=snippet.indexOf("async function subscriptionMatchesEnrollment(");
 const js=snippet.slice(start).replace("sub: Record<string, any>): Promise<boolean>","sub)");
 const scenario=input||fixture();
 const checkout=async id=>{
   assert.equal(id,scenario.session.id,"Only the expected checkout may be checked");
   return scenario.session;
 };
 return new Function("db","stripeCheckoutSession",js+";return subscriptionMatchesEnrollment;")(scenario.db,checkout);
}
const sub=(id,status="active",userId="test-user")=>({
 id,livemode:true,status,metadata:{business_id:"business-1",user_id:userId}
});
test("A matching, owned Stripe subscription is accepted",async()=>{
 const check=enrollmentGuard(fixture());
 assert.equal(await check(sub("sub_live_current")),true);
});
test("Delayed canceled subscription cannot overwrite a newer active subscription",async()=>{
 const check=enrollmentGuard(fixture({status:"active",stripeId:"sub_live_new"}));
 assert.equal(await check(sub("sub_live_old","canceled")),false);
});
test("A prior failed-payment event cannot alter a different active subscription",async()=>{
 const check=enrollmentGuard(fixture({status:"active",stripeId:"sub_live_new"}));
 assert.equal(await check(sub("sub_live_old","past_due")),false);
});
test("New subscription requires a completed owner-matched Checkout",async()=>{
 const scenario=fixture({status:"incomplete",stripeId:"sub_live_previous"});
 const check=enrollmentGuard(scenario);
 assert.equal(await check(sub("sub_live_new")),true);
 scenario.session.status="open";
 assert.equal(await check(sub("sub_live_new")),false);
 scenario.session.status="complete";scenario.session.client_reference_id="different-user";
 assert.equal(await check(sub("sub_live_new")),false);
});
test("Owner mismatch and sandbox subscriptions are rejected",async()=>{
 const check=enrollmentGuard(fixture({owner:false}));
 assert.equal(await check(sub("sub_live_current")),false);
 const check2=enrollmentGuard(fixture());
 assert.equal(await check2({...sub("sub_live_current"),livemode:false}),false);
});
test("An old canceled subscription cannot undo an in-progress replacement checkout",async()=>{
 const scenario=fixture({status:"incomplete",stripeId:"sub_live_old"});
 scenario.session.subscription=null;
 const check=enrollmentGuard(scenario);
 assert.equal(await check(sub("sub_live_old","canceled")),false);
});
test("Webhook fails closed on event-journal query errors and verifies Stripe signatures",()=>{
 assert.match(webhook,/if\(seenError\)return json\(503/);
 assert.match(webhook,/verify\(raw, signature, WEBHOOK_SECRET\)/);
 assert.match(webhook,/event\.livemode !== true/);
});
test("Webhook validates enrollment before persisting or setting active state",()=>{
 assert.match(webhook,/if\(!await subscriptionMatchesEnrollment\(sub\)\)return/);
 assert.match(webhook,/stripe_checkout_session_id/);
 assert.match(webhook,/checkout\.client_reference_id===userId/);
 assert.match(webhook,/checkout\.status==="complete"/);
});
test("Dashboard access rejects missing expiry and allows only paid period or trial",()=>{
 assert.doesNotMatch(access,/!sub\?\.current_period_end/);
 assert.match(access,/Number\.isFinite\(periodEnd\)&&periodEnd>now/);
 assert.match(access,/sub\?\.status==="trialing"&&Number\.isFinite\(trialEnd\)&&trialEnd>now/);
 assert.match(access,/\["active","trialing"\]\.includes\(sub\.status\)/);
});
test("Both request intake functions check current subscription entitlement",()=>{
 for(const fn of ["gatebrook_receive_request","gatebrook_receive_request_custom"]){
   const start=requestMigration.indexOf("CREATE OR REPLACE FUNCTION public."+fn+"(");
   assert.ok(start>=0,"Migration retains "+fn);
   const end=requestMigration.indexOf("$function$;",start);
   assert.ok(end>start);
   const part=requestMigration.slice(start,end);
   assert.match(part,/if not flowos_private\.gatebrook_business_has_access\(p_business_id\)/);
   assert.match(part,/Workspace subscription inactive/);
 }
});
test("Public form and manual review are blocked on inactive subscription",()=>{
 assert.match(requestMigration,/where p\.slug = p_slug and p\.active = true\s+and flowos_private\.gatebrook_business_has_access\(p\.business_id\)/);
 const reviewer=requestMigration.slice(requestMigration.indexOf("CREATE OR REPLACE FUNCTION public.gatebrook_review_request("));
 assert.match(reviewer,/if not flowos_private\.gatebrook_business_has_access\(p_business_id\)/);
 assert.match(reviewer,/where bu\.user_id=auth\.uid\(\) and bu\.business_id=p_business_id and bu\.role='owner'/);
});
