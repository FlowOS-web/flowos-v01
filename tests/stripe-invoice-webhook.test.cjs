const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root=path.resolve(__dirname,"..");
const liveWebhook=fs.readFileSync(path.join(root,"supabase/functions/gatebrook-stripe-webhook/index.ts"),"utf8");
const liveAccess=fs.readFileSync(path.join(root,"supabase/functions/gatebrook-access/index.ts"),"utf8");
const qaWebhook=fs.readFileSync(path.join(root,"supabase/functions/gatebrook-qa-webhook/index.ts"),"utf8");
const qaAccess=fs.readFileSync(path.join(root,"supabase/functions/gatebrook-qa-status/index.ts"),"utf8");

function invoiceResolver(){
  const start=liveWebhook.indexOf("function subscriptionIdFromInvoice(");
  const newGuardStart=liveWebhook.indexOf("\nasync function stripeCheckoutSession(",start);
  const end=newGuardStart>=0?newGuardStart:liveWebhook.indexOf("\nfunction epoch(",start);
  assert.ok(start>=0&&end>start,"Invoice resolver exists in the deployed webhook source");
  const js=liveWebhook.slice(start,end)
    .replace("inv: Record<string, any>","inv")
    .replace("): string | null",")")
    .replace("const candidates: unknown[]","const candidates")
    .replace("line: Record<string, any>","line")
    .replaceAll("(value as any)","value");
  return new Function(js+";return subscriptionIdFromInvoice;")();
}
test("new-format Stripe invoice parent resolves its subscription",()=>{
  const resolve=invoiceResolver();
  const actualStripeShape={
    parent:{type:"subscription_details",subscription_details:{
      subscription:"sub_qa_initial_failure",metadata:{qa_env:"gatebrook_failure_test"}
    }},
    lines:{data:[]}
  };
  assert.equal(resolve(actualStripeShape),"sub_qa_initial_failure");
});
test("legacy invoice.subscription references remain supported",()=>{
  assert.equal(invoiceResolver()({subscription:"sub_legacy_invoice"}),"sub_legacy_invoice");
});
test("expanded subscription id objects are supported",()=>{
  assert.equal(invoiceResolver()({subscription:{id:"sub_expanded_example"}}),"sub_expanded_example");
});
test("invoice line-item subscription link works when parent is absent",()=>{
  assert.equal(invoiceResolver()({lines:{data:[
    {parent:{type:"subscription_item_details",subscription_item_details:{subscription:"sub_line_example"}}}
  ]}}),"sub_line_example");
});
test("non-subscription invoices do not accidentally acquire dashboard access",()=>{
  assert.equal(invoiceResolver()({parent:{type:"invoice_item_details"},lines:{data:[{id:"il_only"}]}}),null);
  assert.equal(invoiceResolver()({subscription:"pi_not_a_subscription"}),null);
});
test("live webhook processes paid and failed invoices using verified current Stripe subscription",()=>{
  assert.match(liveWebhook,/event\.type === "invoice\.payment_failed" \|\| event\.type === "invoice\.paid"/);
  assert.match(liveWebhook,/subscriptionIdFromInvoice\(obj\)/);
  assert.match(liveWebhook,/persistSubscription\(await stripeSubscription\(subscriptionId\),event\.id\)/);
  assert.match(liveWebhook,/const subscriptionId = subscriptionIdFromInvoice\(obj\)/);
});
test("live webhook refuses signed sandbox events",()=>{
  assert.match(liveWebhook,/event\.livemode !== true/);
  assert.match(liveWebhook,/verify\(raw, signature, WEBHOOK_SECRET\)/);
});
test("live access gate denies incomplete, past_due, and unpaid states",()=>{
  assert.match(liveAccess,/\["active","trialing"\]\.includes\(sub\.status\)/);
  const access=(status,end,now)=>["active","trialing"].includes(status)&&end>now;
  const now=Date.now();
  for(const bad of ["incomplete","past_due","unpaid","canceled","paused","incomplete_expired"]){
    assert.equal(access(bad,now+30*86400000,now),false,bad+" must not grant access");
  }
  assert.equal(access("active",now+30*86400000,now),true);
  assert.equal(access("active",now-1,now),false);
});
test("QA webhook uses modern invoice resolution and enforces mapping to a verified checkout",()=>{
  assert.match(qaWebhook,/subscriptionIdFromInvoice\(obj\)/);
  assert.match(qaWebhook,/event\.livemode!==false/);
  assert.match(qaWebhook,/sessionSub!==sub\.id/);
  assert.match(qaAccess,/\["trialing","active"\]\.includes\(status\)/);
});
