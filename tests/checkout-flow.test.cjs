// Gatebrook checkout smoke tests. All remote services are mocked; zero charges.
// Run: node --test tests/checkout-flow.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const sample = {
  business_name:"Sandbox Example Services",
  industry:"Home cleaning",
  slug:"sandbox-example-services",
  tagline:"Demo only",
  plan:"trial",
  created_at:Date.now(),
};

function element(id) {
  return {
    id, textContent:"", value:"", disabled:false, hidden:true,
    handlers:{}, attributes:{},
    classList:{ toggle() {}, add() {}, remove() {} },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

const nodeIds = [
  "gbCheckoutBusiness","gbCheckoutTitle","gbCheckoutIntro","gbCheckoutPlanName",
  "gbCheckoutPlanRate","gbCheckoutOfferLabel","gbCheckoutOfferValue",
  "gbCheckoutDueToday","gbCheckoutBillingTerms","gbCheckoutLoading",
  "gbCheckoutError","gbEmbeddedMount","gbCheckoutNotice",
  "gbCheckoutLoadingText","gbCheckoutErrorTitle","gbCheckoutErrorText",
  "gbCheckoutUseHosted","gbCheckoutRetry",
];

async function settle() {
  for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
}

function checkoutHarness(options={}) {
  const nodes = Object.fromEntries(nodeIds.map(id => [id,element(id)]));
  const calls = [];
  let redirect = null;
  let mounted = false;
  let stripeInitialized = null;
  const db = {
    auth:{
      getUser:async()=>({
        data:{user:options.authenticated === false ? null : {id:"mock-user"}},
        error: options.authenticated === false ? {message:"not signed in"} : null
      })
    },
    functions:{
      invoke:async(name,request)=>{
        calls.push({name,request});
        if(name==="gatebrook-checkout") return {
          data:{url:"https://checkout.stripe.com/c/pay/sandbox-mock"}
        };
        if(options.mode==="missing-key") return {
          error:{message:"unavailable",context:{json:async()=>({code:"embedded_unavailable"})}}
        };
        if(options.mode==="hosted") return {
          data:{mode:"hosted",url:"https://checkout.stripe.com/c/pay/existing-mock"}
        };
        if(options.mode==="rejected") return {
          error:{message:"forbidden",context:{json:async()=>({error:"No owner access"})}}
        };
        return {
          data:{
            mode:"embedded",
            client_secret:"cs_test_mock_only",
            publishable_key:"pk_test_mock_only"
          }
        };
      }
    }
  };
  const window = {
    supabase:{createClient:()=>db},
    GatebrookCheckoutSummary:{
      getIntent:()=>options.intent===null ? null : options.intent || sample,
      render:()=>{},
    },
    Stripe: options.stripeUnavailable ? undefined : key=>{
      stripeInitialized=key;
      return {initEmbeddedCheckout:async({clientSecret})=>{
        assert.equal(clientSecret,"cs_test_mock_only");
        return {mount:selector=>{
          assert.equal(selector,"#gbEmbeddedMount");
          mounted=true;
        }};
      }};
    },
  };
  const document = {getElementById:id=>nodes[id] || null};
  const location = {assign:url=>{redirect=url}};
  vm.runInNewContext(read("checkout.js"), {window,document,location,URL},
    {filename:"checkout.js",timeout:3000});
  return {
    nodes,calls,get redirect(){return redirect},
    get mounted(){return mounted},
    get stripeInitialized(){return stripeInitialized},
    async settle(){await settle()},
    async click(id){await nodes[id].handlers.click();await settle()},
  };
}

function planHarness(plan) {
  const nodes=Object.fromEntries(nodeIds.map(id=>[id,element(id)]));
  const current={...sample,plan,created_at:Date.now()};
  const sessionStorage={getItem:k=>k==="gatebrook_checkout_intent_v1"?JSON.stringify(current):null};
  const window={};
  vm.runInNewContext(read("checkout-summary.js"),{
    window,document:{getElementById:id=>nodes[id]},sessionStorage,
  },{filename:"checkout-summary.js",timeout:3000});
  const data=window.GatebrookCheckoutSummary.getIntent();
  assert.equal(data.plan,plan);
  window.GatebrookCheckoutSummary.render(data);
  return nodes;
}

test("trial summary is seven days free followed by $149/month",()=>{
  const v=planHarness("trial");
  assert.equal(v.gbCheckoutDueToday.textContent,"$0.00");
  assert.match(v.gbCheckoutBillingTerms.textContent,/7-day|seven days/i);
  assert.match(v.gbCheckoutBillingTerms.textContent,/149\/month/);
  assert.match(v.gbCheckoutBillingTerms.textContent,/cancel/i);
});
test("monthly summary shows $149 due immediately",()=>{
  const v=planHarness("monthly");
  assert.equal(v.gbCheckoutDueToday.textContent,"$149.00");
  assert.match(v.gbCheckoutPlanRate.textContent,/149/);
});
test("annual summary shows $1490 due immediately",()=>{
  const v=planHarness("annual");
  assert.equal(v.gbCheckoutDueToday.textContent,"$1,490.00");
  assert.match(v.gbCheckoutBillingTerms.textContent,/year/i);
});
test("embedded checkout mounts only a Stripe test-key mock",async()=>{
  const h=checkoutHarness({mode:"embedded"});
  await h.settle();
  assert.equal(h.mounted,true);
  assert.equal(h.stripeInitialized,"pk_test_mock_only");
  assert.equal(h.redirect,null);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,"gatebrook-embedded-checkout");
});
test("missing embedded config never automatically opens hosted Stripe",async()=>{
  const h=checkoutHarness({mode:"missing-key"});
  await h.settle();
  assert.equal(h.mounted,false);
  assert.equal(h.redirect,null);
  assert.equal(h.nodes.gbCheckoutUseHosted.hidden,false);
  assert.equal(h.calls.length,1);
  await h.click("gbCheckoutUseHosted");
  assert.match(h.redirect,/^https:\/\/checkout\.stripe\.com\//);
  assert.equal(h.calls[1].name,"gatebrook-checkout");
});
test("an old hosted session never automatically redirects away",async()=>{
  const h=checkoutHarness({mode:"hosted"});
  await h.settle();
  assert.equal(h.redirect,null);
  assert.equal(h.nodes.gbCheckoutUseHosted.hidden,false);
});
test("a signed-out user cannot create a checkout session",async()=>{
  const h=checkoutHarness({authenticated:false});
  await h.settle();
  assert.equal(h.calls.length,0);
  assert.equal(h.redirect,null);
  assert.equal(h.nodes.gbCheckoutError.hidden,false);
});
test("the checkout page only renders Stripe-controlled card fields",()=>{
  const html=read("checkout.html");
  assert.match(html,/src="https:\/\/js\.stripe\.com\/v3\//);
  assert.match(html,/id="gbEmbeddedMount"/);
  assert.doesNotMatch(html,/<input[^>]+(?:cc-number|card-number|card-number-input)/i);
});
test("embedded function checks mode and identity before checkout",()=>{
  const src=read("supabase/functions/gatebrook-embedded-checkout/index.ts");
  assert.match(src,/STRIPE_PUBLISHABLE_KEY/);
  assert.match(src,/keyMode !== publicMode/);
  assert.match(src,/db\.auth\.getUser\(token\)/);
  assert.match(src,/form\.set\("ui_mode", "embedded"\)/);
  assert.match(src,/subscription_data\[trial_period_days\]/);
  assert.match(src,/prior\.status === "complete"/);
  assert.match(src,/metadata\?\.user_id !== auth\.user\.id/);
  assert.doesNotMatch(src,/return reply\(200, \{ mode: "hosted", url: prior\.url \}\)/);
});
test("signed webhook is verified before subscription state can be changed",()=>{
  const src=read("supabase/functions/gatebrook-stripe-webhook/index.ts");
  const signature=src.indexOf("await verify(raw, signature, WEBHOOK_SECRET)");
  const dbWrite=src.indexOf('db.from("gatebrook_subscriptions").upsert');
  assert.ok(signature>0 && dbWrite>=0);
  assert.match(src,/Missing Stripe signature/);
  assert.match(src,/Invalid Stripe signature/);
  assert.match(src,/gatebrook_stripe_events/);
  assert.match(src,/customer\.subscription\.updated/);
  assert.match(src,/customer\.subscription\.deleted/);
});
test("subscription access is checked server-side",()=>{
  const src=read("supabase/functions/gatebrook-access/index.ts");
  assert.match(src,/db\.auth\.getUser\(token\)/);
  assert.match(src,/gatebrook_subscriptions/);
  assert.match(src,/"active","trialing"/);
  assert.match(read("billing.html"),/gatebrook-access/);
});
test("sandbox test does not load any live Stripe secret or call a payment API",()=>{
  const mockSource=read("tests/checkout-flow.test.cjs");
  assert.doesNotMatch(mockSource,/sk_live_[A-Za-z0-9]{4}/);
  assert.doesNotMatch(mockSource,/fetch\("https:\/\/api\.stripe\.com/);
});
