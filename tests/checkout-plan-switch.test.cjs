// Regression tests for switching plans while an incomplete Stripe session is open.
// No Stripe credentials, network calls, or real payments.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname,"..");
const embedded = fs.readFileSync(path.join(root,"supabase/functions/gatebrook-embedded-checkout/index.ts"),"utf8");
const hosted = fs.readFileSync(path.join(root,"supabase/functions/gatebrook-checkout/index.ts"),"utf8");
const OLD_SESSION = "cs_live_unpaid_annual_fixture";
const BUSINESS = "business-qa-fixture";
const OWNER = "user-qa-fixture";
const metadata = {business_id:BUSINESS,user_id:OWNER,checkout_option:"annual"};
const prior = (changes={})=>({
 id:OLD_SESSION,livemode:true,status:"open",mode:"subscription",
 ui_mode:"embedded_page",payment_status:"unpaid",subscription:null,
 client_reference_id:OWNER,client_secret:"cs_live_secret_fixture",
 metadata:{...metadata},url:null,...changes
});

function extract(source){
 const start=source.indexOf('    if (sub?.status === "incomplete" && sub.stripe_checkout_session_id) {');
 const end=source.indexOf('    const { error: updateError }',start);
 assert.ok(start>0&&end>start,"Expected incomplete-session reconciliation block");
 return source.slice(start,end)
   .replace(/: Record<string, unknown>/g,"")
   .replace(/ as Record<string, unknown> \| null/g,"");
}

function fixture(source,opts={}){
 const calls=[];
 const session=prior(opts.prior||{});
 const fetch=async(url,options={})=>{
   const method=options.method||"GET";
   calls.push({url,method,headers:options.headers});
   if(method==="GET"){
     if(opts.failGet)return {ok:false,status:503,json:async()=>({error:{message:"unavailable"}})};
     return {ok:true,json:async()=>session};
   }
   if(method==="POST"&&url.endsWith("/expire")){
     if(opts.failExpire)return {ok:false,status:409,json:async()=>({error:{message:"busy"}})};
     return {ok:true,json:async()=>({id:OLD_SESSION,status:opts.expiryStatus||"expired"})};
   }
   throw Error("Unexpected simulated Stripe request: "+method+" "+url);
 };
 const run=new Function(
   "sub","plan","auth","businessId","STRIPE_KEY","keyMode",
   "PUBLISHABLE_KEY","STRIPE_API_VERSION","reply","fetch",
   "return (async()=>{\n"+extract(source)+"\nreturn {continued:true};\n})()"
 );
 const response=(status,payload)=>({status,...payload});
 return {
   calls,run:()=>run({status:"incomplete",stripe_checkout_session_id:OLD_SESSION},
     opts.plan||"trial",{user:{id:OWNER}},BUSINESS,
     "sk_live_mock", "live","pk_live_mock","2025-06-30.basil",response,fetch)
 };
}
test("An open old annual embedded session can be safely expired to start a trial",async()=>{
 const f=fixture(embedded);
 assert.deepEqual(await f.run(),{continued:true});
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].method,"GET");
 assert.equal(f.calls[1].method,"POST");
 assert.match(f.calls[1].url,/\/expire$/);
});
test("Same-plan embedded_page session resumes without creating or expiring",async()=>{
 const f=fixture(embedded,{plan:"annual"});
 const res=await f.run();
 assert.equal(res.status,200);
 assert.equal(res.mode,"embedded");
 assert.equal(res.client_secret,"cs_live_secret_fixture");
 assert.equal(f.calls.length,1);
});
test("Previously completed Checkout cannot be expired or duplicated",async()=>{
 const f=fixture(embedded,{prior:{status:"complete",payment_status:"paid",subscription:"sub_live_fixture"}});
 const res=await f.run();
 assert.equal(res.status,409);
 assert.equal(res.next,"billing.html");
 assert.equal(f.calls.length,1);
});
test("A paid or subscription-attached open session cannot be expired",async()=>{
 for(const changes of [{payment_status:"paid"},{subscription:"sub_live_existing"}]){
   const f=fixture(embedded,{prior:changes});
   assert.equal((await f.run()).status,409);
   assert.equal(f.calls.length,1);
 }
});
test("A session with different business or user cannot be touched",async()=>{
 for(const changes of [
   {metadata:{...metadata,business_id:"other_business"}},
   {metadata:{...metadata,user_id:"other_user"}},
   {client_reference_id:"other_user"},
   {livemode:false},
   {mode:"payment"}
 ]){
   const f=fixture(embedded,{prior:changes});
   assert.equal((await f.run()).status,409);
   assert.equal(f.calls.length,1);
 }
});
test("Failure to verify Stripe session fails closed; never starts replacement",async()=>{
 const f=fixture(embedded,{failGet:true});
 assert.equal((await f.run()).status,503);
 assert.equal(f.calls.length,1);
});
test("Failure to confirm expired session prevents new checkout",async()=>{
 const a=fixture(embedded,{failExpire:true});
 assert.equal((await a.run()).status,409);
 assert.equal(a.calls.length,2);
 const b=fixture(embedded,{expiryStatus:"open"});
 assert.equal((await b.run()).status,409);
});
test("Already-expired session proceeds without second expiration",async()=>{
 const f=fixture(embedded,{prior:{status:"expired"}});
 assert.deepEqual(await f.run(),{continued:true});
 assert.equal(f.calls.length,1);
});
test("Hosted fallback safely expires old embedded session when needed",async()=>{
 const f=fixture(hosted);
 assert.deepEqual(await f.run(),{continued:true});
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[1].method,"POST");
});
test("Hosted same-plan session is reused without expiration",async()=>{
 const f=fixture(hosted,{plan:"annual",prior:{ui_mode:"hosted",url:"https://checkout.stripe.com/c/pay/mock"}});
 const res=await f.run();
 assert.equal(res.status,200);
 assert.equal(res.url,"https://checkout.stripe.com/c/pay/mock");
 assert.equal(f.calls.length,1);
});
test("Hosted session with invalid business linkage is never expired",async()=>{
 const f=fixture(hosted,{prior:{metadata:{...metadata,business_id:"someone_else"}}});
 assert.equal((await f.run()).status,409);
 assert.equal(f.calls.length,1);
});
test("Both functions reject an incomplete subscription already created",()=>{
 for(const source of [embedded,hosted]){
   assert.match(source,/sub\?\.status === "incomplete" && sub\.stripe_subscription_id/);
   assert.match(source,/next: "billing\.html"/);
 }
});
test("New Stripe Checkout idempotency keys distinguish trial vs annual plan",()=>{
 for(const source of [embedded,hosted]){
   assert.match(source,/const retryKey = \(previousCheckoutSessionId \? previousCheckoutSessionId : "initial"\) \+ "-" \+ plan/);
 }
});
test("Embedded mode is Stripe's modern embedded_page on retrieval",()=>{
 assert.match(embedded,/\["embedded_page","embedded"\]\.includes\(String\(prior\.ui_mode\)\)/);
});
