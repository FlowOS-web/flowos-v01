import { createClient } from "npm:@supabase/supabase-js@2.117.3";

// An internal, synthetic-only Stripe QA billing-clock runner.
// Never accepts customer IDs, email addresses, payment keys or amounts from callers.
const SUPABASE_URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON=Deno.env.get("SUPABASE_ANON_KEY")||"";
const STRIPE=Deno.env.get("GATEBROOK_QA_STRIPE_SECRET_KEY")||"";
const ACCOUNT="gatebrook_qa_clocktest";
const LABEL="gatebrook-failed-renewal-2026-10";
const PRICE="price_1UW2J0H6B0zVSPUKp4kjPn1z";
const db=createClient(SUPABASE_URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const reply=(status:number,result:unknown)=>new Response(JSON.stringify(result),{
  status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
type Run=Record<string,any>;
const iso=()=>new Date().toISOString();
const date=(seconds:unknown)=>typeof seconds==="number"?new Date(seconds*1000).toISOString():null;
const stripeEndpoint="https://api.stripe.com/v1/";
async function stripe(path:string, form?:Record<string,string>) {
  const headers=new Headers({
    "Authorization":"Bearer "+STRIPE,
    "Stripe-Version":"2026-09-30.endive"
  });
  const options:RequestInit={headers,method:form?"POST":"GET"};
  if(form){
    headers.set("Content-Type","application/x-www-form-urlencoded");
    options.body=new URLSearchParams(form);
  }
  const response=await fetch(stripeEndpoint+path,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error("Stripe sandbox "+path.split("?")[0]+" failed: "+(data.error?.code||response.status));
  if(data.livemode===true)throw Error("Unexpected live Stripe object");
  return data;
}
async function runRecord():Promise<Run|null> {
  const {data,error}=await db.from("gatebrook_qa_clock_runs").select("*").eq("label",LABEL).maybeSingle();
  if(error)throw Error("QA run lookup failed");
  return data;
}
async function setRun(fields:Record<string,unknown>) {
  const {error}=await db.from("gatebrook_qa_clock_runs")
    .update({...fields,updated_at:iso()}).eq("label",LABEL);
  if(error)throw Error("QA run journal update failed");
}
async function workspaceStatus(run:Run) {
  const {data,error}=await db.from("gatebrook_qa_subscriptions")
    .select("status,trial_end,current_period_end,cancel_at_period_end,stripe_subscription_id")
    .eq("workspace_id",run.workspace_id).maybeSingle();
  if(error)throw Error("QA access journal query failed");
  if(!data)return {status:"missing",allowed:false};
  const expiration=data.status==="trialing"?data.trial_end:data.current_period_end;
  const allowed=["trialing","active"].includes(data.status)&&
    typeof expiration==="string"&&Date.parse(expiration)>Date.now();
  return {status:data.status,allowed,trial_end:data.trial_end,
    current_period_end:data.current_period_end,cancel_at_period_end:data.cancel_at_period_end};
}
async function statusViaAuth(run:Run){
  // A new admin magic link is generated locally, never sent to any inbox.
  // The special synthetic account cannot send or receive customer emails.
  if(!run.owner_user_id||!ANON)return {checked:false,reason:"Missing synthetic user or anon configuration"};
  const {data:owner,error:ownerErr}=await db.auth.admin.getUserById(run.owner_user_id);
  if(ownerErr||!owner?.user?.email?.endsWith("@example.invalid"))
    return {checked:false,reason:"Not a synthetic QA email"};
  const {data:link,error:linkErr}=await db.auth.admin.generateLink({
    type:"magiclink",email:owner.user.email
  });
  const tokenHash=link?.properties?.hashed_token;
  if(linkErr||typeof tokenHash!=="string")
    return {checked:false,reason:"Could not create QA auth token"};
  const authDb=createClient(SUPABASE_URL,ANON,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:verified,error:verifyErr}=await authDb.auth.verifyOtp({
    type:"magiclink",token_hash:tokenHash
  });
  if(verifyErr||!verified?.session?.access_token)
    return {checked:false,reason:"Could not exchange synthetic auth token"};
  const res=await fetch(SUPABASE_URL+"/functions/v1/gatebrook-qa-status",{
    headers:{"Authorization":"Bearer "+verified.session.access_token,"apikey":ANON}
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok||data.sandbox!==true)
    return {checked:false,reason:"QA gate did not answer successfully",http:res.status};
  return {checked:true,status:data.status,allowed:data.allowed};
}
async function clockReady(run:Run){
  const clock=await stripe("test_helpers/test_clocks/"+encodeURIComponent(run.stripe_clock_id));
  if(clock.id!==run.stripe_clock_id)return {ready:false,clock_status:"mismatch"};
  return {ready:clock.status==="ready",clock_status:clock.status,frozen_time:clock.frozen_time};
}
async function setup(){
  let run=await runRecord();
  if(run&&run.stage!=="new")return {ok:true,stage:run.stage,id:run.id,already_started:true};
  if(!run){
    const {data,error}=await db.from("gatebrook_qa_clock_runs")
      .insert({label:LABEL,stage:"new"}).select("*").single();
    if(error||!data)throw Error("Unable to initialize synthetic QA run");
    run=data;
  }
  // The account name is reserved under .invalid: no accidental real recipient.
  const email="qa-clock-"+run.id.replaceAll("-","")+"@example.invalid";
  const pwd=crypto.randomUUID()+crypto.randomUUID();
  const created=await db.auth.admin.createUser({
    email,password:pwd,email_confirm:true,
    app_metadata:{gatebrook_qa_clock_fixture:true}
  });
  if(created.error||!created.data.user)throw Error("Cannot create synthetic QA auth account: "+(created.error?.code||created.error?.status||"unknown"));
  const owner=created.data.user.id;
  const tester=await db.from("gatebrook_qa_testers").insert({user_id:owner});
  if(tester.error)throw Error("Cannot authorize synthetic QA tester");
  const {data:workspace,error:wsErr}=await db.from("gatebrook_qa_workspaces")
    .insert({owner_user_id:owner,name:"Automated Failed Renewal QA"}).select("id").single();
  if(wsErr||!workspace)throw Error("Cannot create isolated QA workspace");
  await setRun({owner_user_id:owner,workspace_id:workspace.id,stage:"workspace_created"});
  const clock=await stripe("test_helpers/test_clocks",{
    frozen_time:String(Math.floor(Date.now()/1000)),
    name:"Gatebrook QA - synthetic failed renewal"
  });
  if(typeof clock.id!=="string"||!clock.id.startsWith("clock_"))
    throw Error("Stripe did not create a sandbox test clock");
  await setRun({stripe_clock_id:clock.id,stage:"clock_created"});
  const customer=await stripe("customers",{
    "name":"Gatebrook QA - Failed Renewal - Synthetic Only",
    "description":"Created by Gatebrook internal QA clock runner. No real email.",
    "test_clock":clock.id,
    "payment_method":"pm_card_visa",
    "metadata[qa_env]":ACCOUNT,
    "metadata[qa_run_id]":run.id
  });
  if(typeof customer.id!=="string"||!customer.id.startsWith("cus_"))
    throw Error("Stripe did not create a test customer");
  await setRun({stripe_customer_id:customer.id,stage:"customer_created"});
  const cards=await stripe("customers/"+encodeURIComponent(customer.id)+"/payment_methods?type=card&limit=10");
  const good=cards.data?.find((pm:any)=>pm?.card?.last4==="4242");
  if(!good?.id)throw Error("Stripe did not attach the success test card");
  const subscription=await stripe("subscriptions",{
    "customer":customer.id,
    "items[0][price]":PRICE,
    "items[0][quantity]":"1",
    "default_payment_method":good.id,
    "collection_method":"charge_automatically",
    "trial_period_days":"7",
    "metadata[qa_env]":ACCOUNT,
    "metadata[qa_run_id]":run.id,
    "metadata[qa_workspace_id]":workspace.id,
    "metadata[qa_owner_user_id]":owner,
    "metadata[qa_plan]":"monthly"
  });
  if(subscription.status!=="trialing"||typeof subscription.trial_end!=="number")
    throw Error("Test clock trial did not start");
  const insert=await db.from("gatebrook_qa_subscriptions").insert({
    workspace_id:workspace.id,owner_user_id:owner,plan:"monthly",status:"trialing",
    stripe_checkout_session_id:null,stripe_subscription_id:subscription.id,
    stripe_customer_id:customer.id,trial_end:date(subscription.trial_end),
    current_period_end:date(subscription.items?.data?.[0]?.current_period_end),
    cancel_at_period_end:false
  });
  if(insert.error)throw Error("Unable to create isolated test subscription record");
  await setRun({stripe_subscription_id:subscription.id,successful_payment_method_id:good.id,
    stage:"trialing"});
  run=await runRecord();
  const actual=await statusViaAuth(run!);
  return {ok:true,stage:"trialing",clock_id:clock.id,subscription_id:subscription.id,
    qa_status:await workspaceStatus(run!),actual_gate:actual};
}
async function activate(run:Run){
  if(run.stage==="trial_advancing")return inspect(run);
  if(run.stage!=="trialing")return {ok:false,reason:"Not a trialing synthetic test",stage:run.stage};
  const sub=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id));
  if(sub.status!=="trialing"||typeof sub.trial_end!=="number")
    return {ok:false,reason:"Stripe trial not ready for advancement",stripe_status:sub.status};
  const result=await stripe("test_helpers/test_clocks/"+encodeURIComponent(run.stripe_clock_id)+"/advance",{
    frozen_time:String(sub.trial_end+3600)
  });
  await setRun({stage:"trial_advancing"});
  return {ok:true,stage:"trial_advancing",clock_status:result.status,target_time:sub.trial_end+3600};
}
async function prepareFailure(run:Run){
  if(run.stage==="failure_prepared")return {ok:true,stage:run.stage};
  if(run.stage!=="active")return {ok:false,reason:"First activate the test subscription",stage:run.stage};
  const sub=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id));
  if(sub.status!=="active")return {ok:false,reason:"Stripe subscription not paid and active"};
  const pm=await stripe("payment_methods/pm_card_chargeCustomerFail/attach",{
    customer:run.stripe_customer_id
  });
  if(pm.customer!==run.stripe_customer_id||pm.card?.last4!=="0341")
    throw Error("Stripe did not attach the expected decline-after-saving card");
  const updated=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id),{
    default_payment_method:pm.id,
    proration_behavior:"none"
  });
  if(updated.default_payment_method!==pm.id)
    throw Error("Failed to install decline-only payment method");
  await setRun({failed_payment_method_id:pm.id,stage:"failure_prepared"});
  return {ok:true,stage:"failure_prepared",payment_method_last4:"0341"};
}
async function failRenewal(run:Run){
  if(run.stage==="renewal_advancing")return inspect(run);
  if(run.stage!=="failure_prepared")
    return {ok:false,reason:"Declined renewal not prepared",stage:run.stage};
  const sub=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id));
  const due=sub.items?.data?.[0]?.current_period_end??sub.current_period_end;
  if(sub.status!=="active"||typeof due!=="number")
    return {ok:false,reason:"Active subscription period not available"};
  const advanced=await stripe("test_helpers/test_clocks/"+encodeURIComponent(run.stripe_clock_id)+"/advance",{
    frozen_time:String(due+3600)
  });
  await setRun({stage:"renewal_advancing"});
  return {ok:true,stage:"renewal_advancing",clock_status:advanced.status,target_time:due+3600};
}
async function recover(run:Run){
  if(run.stage==="recovery_requested")return inspect(run);
  if(run.stage!=="failed")
    return {ok:false,reason:"Payment failure must be verified before recovery",stage:run.stage};
  const sub=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id));
  const invoiceId=typeof sub.latest_invoice==="string"?sub.latest_invoice:sub.latest_invoice?.id;
  if(typeof invoiceId!=="string")throw Error("Missing failed renewal invoice");
  const inv=await stripe("invoices/"+encodeURIComponent(invoiceId));
  if(inv.status!=="open"||inv.amount_remaining!==14900||inv.amount_paid!==0)
    return {ok:false,reason:"Expected $149 unpaid renewal invoice not found",
      invoice_status:inv.status,amount_remaining:inv.amount_remaining};
  const {data:local}=await db.from("gatebrook_qa_subscriptions").select("status")
    .eq("workspace_id",run.workspace_id).maybeSingle();
  if(local?.status!=="past_due"&&local?.status!=="unpaid")
    return {ok:false,reason:"Failed-payment webhook has not updated QA access"};
  const updated=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id),{
    default_payment_method:run.successful_payment_method_id,
    proration_behavior:"none"
  });
  if(updated.default_payment_method!==run.successful_payment_method_id)
    throw Error("Could not restore working test card");
  const paid=await stripe("invoices/"+encodeURIComponent(invoiceId)+"/pay",{
    payment_method:run.successful_payment_method_id,
    off_session:"true"
  });
  await setRun({stage:"recovery_requested",stripe_renewal_invoice_id:invoiceId});
  return {ok:true,stage:"recovery_requested",invoice_id:invoiceId,
    invoice_status:paid.status,amount_paid:paid.amount_paid};
}
async function inspect(run:Run){
  if(!run?.stripe_subscription_id)
    return {ok:false,stage:run?.stage||"not_started",reason:"No subscription exists"};
  const clock=await clockReady(run);
  const sub=await stripe("subscriptions/"+encodeURIComponent(run.stripe_subscription_id));
  const invoiceId=typeof sub.latest_invoice==="string"?sub.latest_invoice:sub.latest_invoice?.id;
  const invoice=invoiceId?await stripe("invoices/"+encodeURIComponent(invoiceId)):null;
  const qa=await workspaceStatus(run);
  let stage=run.stage;
  const result:any={ok:true,stage,clock,subscription_status:sub.status,
    qa_status:qa,invoice:{
      id:invoice?.id||null,status:invoice?.status||null,
      amount_due:invoice?.amount_due??null,amount_paid:invoice?.amount_paid??null,
      attempt_count:invoice?.attempt_count??null
    }};
  if(clock.ready&&stage==="trial_advancing"&&sub.status==="active"&&qa.status==="active"&&
     invoice?.status==="paid"&&invoice.amount_paid===14900){
    stage="active";
    await setRun({stage,access_before:qa.allowed===true});
  }
  if(clock.ready&&stage==="renewal_advancing"&&["past_due","unpaid"].includes(sub.status)&&
      ["past_due","unpaid"].includes(qa.status)&&qa.allowed===false&&
      invoice?.status==="open"&&invoice.attempt_count>=1&&invoice.amount_paid===0){
    stage="failed";
    await setRun({stage,access_after_failure:false,stripe_renewal_invoice_id:invoiceId});
  }
  if(clock.ready&&stage==="recovery_requested"&&sub.status==="active"&&
     qa.status==="active"&&qa.allowed===true&&
     invoice?.status==="paid"&&invoice.amount_paid===14900){
    stage="recovered";
    await setRun({stage,access_after_recovery:true});
  }
  result.stage=stage;
  // Authenticated QA status gate is checked on each stable stage. It is also
  // exercised in setup as an independent sign-in, not an admin database query.
  if(["trialing","active","failed","recovered"].includes(stage)){
    result.authenticated_gate=await statusViaAuth(run);
    if(result.authenticated_gate?.checked){
      if(stage==="active"&&result.authenticated_gate.allowed!==true)
        result.verification_warning="Authenticated QA access did not activate";
      if(stage==="failed"&&result.authenticated_gate.allowed!==false)
        result.verification_warning="Authenticated QA access did not revoke";
      if(stage==="recovered"&&result.authenticated_gate.allowed!==true)
        result.verification_warning="Authenticated QA access did not restore";
    }
  }
  return result;
}
Deno.serve(async req=>{
  if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
  if(!/^(sk|rk)_test_[A-Za-z0-9_-]+$/.test(STRIPE))
    return reply(503,{error:"QA-only Stripe key configuration missing"});
  const token=req.headers.get("x-gatebrook-qa-clock-runner")||"";
  if(token.length!==64)return reply(401,{error:"Unauthorized"});
  const {data:allowed,error:authErr}=await db.rpc("gatebrook_qa_verify_clock_runner",{p_token:token});
  if(authErr||allowed!==true)return reply(401,{error:"Unauthorized"});
  let action="";
  try{action=(await req.json()).action||""}catch{return reply(400,{error:"Bad request"})}
  if(!["setup","activate","prepare_failure","fail_renewal","recover","inspect"].includes(action))
    return reply(400,{error:"Unsupported QA-only test action"});
  try{
    const run=await runRecord();
    const result=action==="setup"?await setup():
      !run?{ok:false,reason:"QA scenario not initialized"}:
      action==="activate"?await activate(run):
      action==="prepare_failure"?await prepareFailure(run):
      action==="fail_renewal"?await failRenewal(run):
      action==="recover"?await recover(run):await inspect(run);
    return reply(200,result);
  }catch(e){
    console.error("Synthetic QA clock runner action failed",action,e instanceof Error?e.message:"unknown");
    await setRun({last_error:e instanceof Error?e.message.slice(0,250):"Unknown failure"}).catch(()=>{});
    return reply(503,{ok:false,stage:action,error:e instanceof Error?e.message:"Unknown QA error"});
  }
});
