const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(root,p),"utf8");
const sources = {
  checkout:read("supabase/functions/gatebrook-qa-checkout/index.ts"),
  status:read("supabase/functions/gatebrook-qa-status/index.ts"),
  webhook:read("supabase/functions/gatebrook-qa-webhook/index.ts"),
  page:read("qa.html"),
  client:read("qa.js"),
  dashboard:read("qa-dashboard.html")
};
function node(id) {
  return {
    id,hidden:true,value:id==="qaBusinessName"?"J&J Plumbing QA":"",
    textContent:"",disabled:false,dataset:{},handlers:{},attributes:{},
    classList:{toggle(){}},
    addEventListener(name,fn){this.handlers[name]=fn},
    setAttribute(key,value){this.attributes[key]=value},
    scrollIntoView(){}
  };
}
function harness({signedIn=true,allowed=false,status="not_started"}={}){
  const ids=["qaNotice","qaAuth","qaSelect","qaVerified","qaPaymentContainer","qaAccount",
    "qaAccountLine","qaSubmit","qaBusinessName","qaStripeMount","qaStatusValue",
    "qaStatusPlan","qaWorkspaceName","qaStatusUntil","qaRefresh"];
  const nodes=Object.fromEntries(ids.map(id=>[id,node(id)]));
  const buttons=["trial","monthly","annual"].map(plan=>{
    const b=node("plan-"+plan);b.dataset.qaPlan=plan;return b;
  });
  let mount=null,redirect=null;
  const calls=[];
  const db={
    auth:{getUser:async()=>({data:{user:signedIn?{id:"test-user",email:"tester@example.test"}:null},error:null})},
    functions:{invoke:async(name,options)=>{
      calls.push({name,options});
      if(name==="gatebrook-qa-status")return{data:{sandbox:true,allowed,
        workspace_name:"J&J QA",status,plan:"trial",
        trial_end:"2026-11-05T23:15:12Z"},error:null};
      if(name==="gatebrook-qa-checkout")return{data:{mode:"embedded",client_secret:"cs_test_mock",
        publishable_key:"pk_test_mock"},error:null};
      throw Error("unexpected function "+name);
    }}
  };
  const context={
    window:{
      supabase:{createClient:()=>db},
      Stripe:key=>{
        assert.equal(key,"pk_test_mock");
        return{initEmbeddedCheckout:async({clientSecret})=>{
          assert.equal(clientSecret,"cs_test_mock");
          return{mount:selector=>mount=selector};
        }}
      }
    },
    document:{
      getElementById:id=>{
        assert.ok(nodes[id],"Unknown DOM node: "+id);
        return nodes[id];
      },
      querySelectorAll:selector=>{
        assert.equal(selector,"[data-qa-plan]");
        return buttons;
      }
    },
    location:{search:"",assign:url=>redirect=url},
    URLSearchParams
  };
  vm.runInNewContext(sources.client,context,{filename:"qa.js",timeout:3000});
  return {nodes,buttons,calls,get mount(){return mount},get redirect(){return redirect},
    async settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve))},
    async click(id){await nodes[id].handlers.click();await this.settle()}
  };
}

test("QA-only functions never write into live businesses or subscriptions",()=>{
  for(const [name,src] of Object.entries({
    checkout:sources.checkout,status:sources.status,webhook:sources.webhook
  })){
    assert.doesNotMatch(src,/\.from\(["'](?:gatebrook_subscriptions|businesses|business_users|business_public_profiles)["']\)/,name);
    assert.match(src,/gatebrook_qa_/);
  }
});
test("QA checkout never accepts live Stripe credentials",()=>{
  assert.match(sources.checkout,/GATEBROOK_QA_STRIPE_SECRET_KEY/);
  assert.match(sources.checkout,/GATEBROOK_QA_STRIPE_PUBLISHABLE_KEY/);
  assert.match(sources.checkout,/^\s*if\(!\/\^\(sk\|rk\)_test_/m);
  assert.match(sources.checkout,/\!\/\^pk_test_/);
  assert.match(sources.checkout,/created\.value\.livemode!==false/);
  assert.doesNotMatch(sources.checkout,/Deno\.env\.get\("STRIPE_SECRET_KEY"\)/);
});
test("sandbox prices, trial term and embedded UI are hard-wired",()=>{
  assert.match(sources.checkout,/price_1UW2J0H6B0zVSPUKp4kjPn1z/);
  assert.match(sources.checkout,/price_1UW2IzH6B0zVSPUKLnfJI8nj/);
  assert.match(sources.checkout,/form\.set\("ui_mode","embedded_page"\)/);
  assert.match(sources.checkout,/form\.set\("subscription_data\[trial_period_days\]","7"\)/);
  assert.match(sources.checkout,/form\.set\("return_url",SITE\+"\/qa\.html/);
});
test("QA checkout requires login and approved tester identity",()=>{
  assert.match(sources.checkout,/db\.auth\.getUser\(token\)/);
  assert.match(sources.checkout,/gatebrook_qa_testers/);
  assert.match(sources.checkout,/qa_owner_user_id/);
  assert.match(sources.checkout,/if\(!tester\)return reply\(403/);
});
test("QA status grants access only with a valid, unexpired trial or period",()=>{
  assert.match(sources.status,/db\.auth\.getUser\(token\)/);
  assert.match(sources.status,/gatebrook_qa_testers/);
  assert.match(sources.status,/status==="trialing"/);
  assert.match(sources.status,/expiration>Date\.now\(\)/);
});
test("QA webhook requires HMAC verification and rejects live events",()=>{
  assert.match(sources.webhook,/await verify\(raw,signature,WEBHOOK_SECRET\)/);
  assert.match(sources.webhook,/event\.livemode!==false/);
  assert.match(sources.webhook,/Invalid Stripe signature/);
  assert.match(sources.webhook,/GATEBROOK_QA_WEBHOOK_SECRET/);
});
test("QA webhook verifies checkout ownership before writing a subscription",()=>{
  assert.match(sources.webhook,/sessionSub!==sub\.id/);
  assert.match(sources.webhook,/session\.status!=="complete"/);
  assert.match(sources.webhook,/session\.metadata\?\.qa_workspace_id!==workspaceId/);
  assert.match(sources.webhook,/gatebrook_qa_events/);
  assert.match(sources.webhook,/event\.id/);
});
test("QA checkout client initializes only a pk_test key",()=>{
  assert.match(sources.client,/startsWith\("pk_test_"\)/);
  assert.match(sources.client,/initEmbeddedCheckout/);
  assert.match(sources.client,/gatebrook-qa-checkout/);
  assert.doesNotMatch(sources.client,/gatebrook-checkout["']/);
});
test("sandbox pages clearly identify test mode and do not reveal real card inputs",()=>{
  assert.match(sources.page,/QA Sandbox — no real charges/);
  assert.match(sources.page,/https:\/\/js\.stripe\.com\/v3\//);
  assert.doesNotMatch(sources.page,/<input[^>]*(?:card_number|credit_card_number|cc-number)/i);
  assert.match(sources.dashboard,/gatebrook-qa-status/);
  assert.doesNotMatch(sources.dashboard,/from\(["']leads["']\)/);
});
test("signed-out visitors cannot launch QA checkout",async()=>{
  const h=harness({signedIn:false});
  await h.settle();
  assert.equal(h.nodes.qaAuth.hidden,false);
  assert.equal(h.nodes.qaSelect.hidden,true);
  assert.equal(h.calls.length,0);
});
test("an approved tester can initialize an isolated embedded form",async()=>{
  const h=harness();
  await h.settle();
  assert.equal(h.nodes.qaSelect.hidden,false);
  await h.click("qaSubmit");
  assert.equal(h.mount,"#qaStripeMount");
  assert.equal(h.redirect,null);
  assert.equal(h.calls.map(x=>x.name).join(","),"gatebrook-qa-status,gatebrook-qa-checkout");
  assert.equal(h.calls[1].options.body.plan,"trial");
});
test("verified trial unlocks only the QA preview",async()=>{
  const h=harness({allowed:true,status:"trialing"});
  await h.settle();
  assert.equal(h.nodes.qaVerified.hidden,false);
  assert.equal(h.nodes.qaSelect.hidden,true);
  assert.equal(h.nodes.qaStatusValue.textContent,"Trial active");
});


// Exercise the actual plan-switch branch with a Stripe sandbox stub. No network calls.
function qaPlanSwitchHarness({storedPlan="annual",requestedPlan="trial",status="open",
   paymentStatus="unpaid",subscription=null,owner="test-user",
   workspace="test-workspace",expirationOk=true,metadataOwner=owner}={}) {
  const markerStart='    if(old.livemode!==false)return reply(409,{error:"Unsafe checkout mode detected."},origin);';
  const markerEnd='  const form=new URLSearchParams();';
  const start=sources.checkout.indexOf(markerStart);
  const end=sources.checkout.indexOf(markerEnd,start);
  assert.ok(start>=0&&end>start,"Expected the actual QA plan-switch block");
  const branch=sources.checkout.slice(start,end);
  const calls=[];
  const sessionId="cs_test_existing";
  const stripe=async (endpoint, options)=>{
    calls.push({endpoint,options});
    assert.equal(endpoint,"checkout/sessions/"+sessionId+"/expire");
    assert.equal(options.method,"POST");
    return {ok:expirationOk,value:expirationOk?
      {id:sessionId,livemode:false,status:"expired"}:
      {error:{message:"Cannot expire session"}}};
  };
  const old={
    id:sessionId,livemode:false,status,mode:"subscription",ui_mode:"embedded_page",
    payment_status:paymentStatus,subscription,client_secret:"cs_test_mock_secret",
    client_reference_id:owner,
    metadata:{qa_env:"gatebrook_qa",qa_owner_user_id:metadataOwner,
      qa_workspace_id:workspace,qa_plan:storedPlan}
  };
  const context={
    old, oldSessionId:sessionId, user:{id:owner},workspaceId:workspace,
    prior:{plan:storedPlan},plan:requestedPlan,STRIPE_PUBLIC_TEST:"pk_test_mock",
    reply:(code,data)=>({code,data}),origin:null,stripe,encodeURIComponent
  };
  const wrapped="(async function(){\n{\n"+branch+"\nreturn {code:200,data:{next:'create'}};\n})()";
  return Promise.resolve(vm.runInNewContext(wrapped,context)).then(result=>({result,calls}));
}
test("switching plans expires only an open unpaid sandbox session",async()=>{
  const x=await qaPlanSwitchHarness();
  assert.equal(x.result.code,200);
  assert.equal(x.result.data.next,"create");
  assert.equal(x.calls.length,1);
});
test("reopening the same plan reuses its embedded client secret",async()=>{
  const x=await qaPlanSwitchHarness({storedPlan:"trial",requestedPlan:"trial"});
  assert.equal(x.result.code,200);
  assert.equal(x.result.data.reused,true);
  assert.equal(x.calls.length,0);
});
test("checkout for another owner cannot be expired by the plan switch",async()=>{
  const x=await qaPlanSwitchHarness({metadataOwner:"someone-else"});
  assert.equal(x.result.code,409);
  assert.equal(x.calls.length,0);
});
test("a completed sandbox checkout cannot be expired",async()=>{
  const x=await qaPlanSwitchHarness({status:"complete"});
  assert.equal(x.result.code,409);
  assert.equal(x.calls.length,0);
});
test("a potentially paid sandbox checkout cannot be expired",async()=>{
  const x=await qaPlanSwitchHarness({paymentStatus:"paid"});
  assert.equal(x.result.code,409);
  assert.equal(x.calls.length,0);
});
test("an unsuccessful Stripe expiration cannot create the replacement checkout",async()=>{
  const x=await qaPlanSwitchHarness({expirationOk:false});
  assert.equal(x.result.code,409);
  assert.equal(x.calls.length,1);
});
test("already expired checkout can be replaced without extra Stripe mutation",async()=>{
  const x=await qaPlanSwitchHarness({status:"expired"});
  assert.equal(x.result.code,200);
  assert.equal(x.result.data.next,"create");
  assert.equal(x.calls.length,0);
});
