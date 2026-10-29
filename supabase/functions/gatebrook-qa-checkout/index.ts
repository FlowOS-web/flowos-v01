import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_TEST = Deno.env.get("GATEBROOK_QA_STRIPE_SECRET_KEY") || "";
const STRIPE_PUBLIC_TEST = Deno.env.get("GATEBROOK_QA_STRIPE_PUBLISHABLE_KEY") || "";
const PRICE_MONTHLY = "price_1UW2J0H6B0zVSPUKp4kjPn1z";
const PRICE_ANNUAL = "price_1UW2IzH6B0zVSPUKLnfJI8nj";
const API_VERSION = "2026-09-30.endive";
const SITE = "https://gatebrook.work";
const origins = new Set([SITE,"https://flowos-web.github.io"]);
const db = createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const reply=(code:number,data:unknown,origin:string|null)=>new Response(JSON.stringify(data),{
  status:code,headers:{"Content-Type":"application/json","Cache-Control":"no-store",
    "Access-Control-Allow-Origin":origins.has(origin||"")?origin!:SITE,
    "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"}
});
async function stripe(path:string, options:RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Authorization","Bearer "+STRIPE_TEST);
  headers.set("Stripe-Version",API_VERSION);
  const res=await fetch("https://api.stripe.com/v1/"+path,{...options,headers});
  const value=await res.json();
  return {ok:res.ok,value};
}
Deno.serve(async req=>{
  const origin=req.headers.get("origin");
  if(req.method==="OPTIONS")return reply(200,{ok:true},origin);
  if(req.method!=="POST")return reply(405,{error:"Method not allowed"},origin);
  if(origin&&!origins.has(origin))return reply(403,{error:"Untrusted origin"},origin);
  // Fail closed: the QA path cannot use any live Stripe key.
  if(!/^(sk|rk)_test_[A-Za-z0-9_-]+$/.test(STRIPE_TEST) ||
     !/^pk_test_[A-Za-z0-9_-]+$/.test(STRIPE_PUBLIC_TEST)) {
    return reply(503,{error:"Sandbox checkout is not configured yet. Add the two GATEBROOK_QA Stripe test keys in Supabase Secrets."},origin);
  }
  const token=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
  if(!token)return reply(401,{error:"Please sign in first."},origin);
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user||user.is_anonymous||!user.email) return reply(401,{error:"A confirmed account is required for QA."},origin);
  const {data:tester,error:testerError}=await db.from("gatebrook_qa_testers")
    .select("user_id").eq("user_id",user.id).maybeSingle();
  if(testerError)return reply(503,{error:"Unable to verify QA permissions."},origin);
  if(!tester)return reply(403,{error:"This account is not approved for Gatebrook QA."},origin);
  let body:Record<string,unknown>;
  try{body=await req.json()}catch{return reply(400,{error:"Invalid checkout request."},origin)}
  const plan=body.plan==="trial"?"trial":body.plan==="monthly"?"monthly":body.plan==="annual"?"annual":null;
  const name=typeof body.business_name==="string"?body.business_name.trim().slice(0,100):"Gatebrook QA Workspace";
  if(!plan||name.length<2)return reply(400,{error:"Choose a valid plan and business name."},origin);
  const {data:oldWorkspace,error:wsError}=await db.from("gatebrook_qa_workspaces")
    .select("id").eq("owner_user_id",user.id).maybeSingle();
  if(wsError)return reply(503,{error:"Unable to check QA workspace."},origin);
  let workspaceId=oldWorkspace?.id;
  if(!workspaceId){
    const {data:newWorkspace,error:createError}=await db.from("gatebrook_qa_workspaces")
      .insert({owner_user_id:user.id,name}).select("id").single();
    if(createError||!newWorkspace)return reply(503,{error:"Could not prepare the QA workspace."},origin);
    workspaceId=newWorkspace.id;
  }
  const {data:prior,error:priorError}=await db.from("gatebrook_qa_subscriptions")
    .select("plan,status,stripe_checkout_session_id").eq("workspace_id",workspaceId).maybeSingle();
  if(priorError)return reply(503,{error:"Could not check QA billing status."},origin);
  if(prior&&["active","trialing","past_due","unpaid","paused"].includes(prior.status))
    return reply(409,{error:"The QA workspace already has a subscription. Check the QA dashboard before starting another."},origin);
  const oldSessionId=prior?.stripe_checkout_session_id;
  if(oldSessionId&&prior?.status==="incomplete"){
    let old:any;
    try{
      const response=await stripe("checkout/sessions/"+encodeURIComponent(oldSessionId));
      if(!response.ok)return reply(503,{error:"Could not verify the existing sandbox checkout."},origin);
      old=response.value;
    }catch{return reply(503,{error:"Could not contact Stripe to verify the QA checkout."},origin)}
    if(old.livemode!==false)return reply(409,{error:"Unsafe checkout mode detected."},origin);
    // Never expire a checkout we cannot prove belongs to this exact tester and QA workspace.
    if(old.id!==oldSessionId||!oldSessionId.startsWith("cs_test_")||
       old.mode!=="subscription"||old.ui_mode!=="embedded_page"||
       old.metadata?.qa_env!=="gatebrook_qa"||
       old.metadata?.qa_owner_user_id!==user.id||
       old.metadata?.qa_workspace_id!==workspaceId||
       old.metadata?.qa_plan!==prior?.plan||
       old.client_reference_id!==user.id) {
      return reply(409,{error:"Existing checkout could not be verified. No changes were made."},origin);
    }
    if(old.status==="complete"||old.subscription||
       (old.payment_status&&old.payment_status!=="unpaid")) {
      return reply(409,{error:"The previous checkout may have completed. Check QA status before retrying."},origin);
    }
    if(old.status==="open"){
      if(prior?.plan===plan&&typeof old.client_secret==="string")
        return reply(200,{mode:"embedded",client_secret:old.client_secret,publishable_key:STRIPE_PUBLIC_TEST,reused:true},origin);
      // A different plan was selected. Only the unpaid, open, verified QA session can
      // be expired. This closes the old form so a new sandbox trial can be started.
      if(prior?.plan===plan)
        return reply(409,{error:"Unable to reopen the existing checkout. Try again later."},origin);
      try{
        const expired=await stripe("checkout/sessions/"+encodeURIComponent(oldSessionId)+"/expire",{
          method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"}
        });
        if(!expired.ok||expired.value.livemode!==false||
           expired.value.id!==oldSessionId||expired.value.status!=="expired") {
          return reply(409,{error:"Unable to safely close the previous test checkout. Check its status before retrying."},origin);
        }
      }catch{
        return reply(503,{error:"Could not close the previous sandbox checkout. Please retry."},origin);
      }
    }else if(old.status!=="expired"){
      return reply(409,{error:"Existing checkout has an unexpected status."},origin);
    }
  }
  const form=new URLSearchParams();
  form.set("mode","subscription");
  form.set("ui_mode","embedded_page");
  form.set("return_url",SITE+"/qa.html?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("redirect_on_completion","always");
  form.set("client_reference_id",user.id);
  form.set("customer_email",user.email);
  form.set("line_items[0][price]",plan==="annual"?PRICE_ANNUAL:PRICE_MONTHLY);
  form.set("line_items[0][quantity]","1");
  form.set("payment_method_collection","always");
  for(const [key,value] of Object.entries({
    qa_env:"gatebrook_qa",qa_workspace_id:workspaceId,qa_owner_user_id:user.id,qa_plan:plan
  })){
    form.set("metadata["+key+"]",value);
    form.set("subscription_data[metadata]["+key+"]",value);
  }
  if(plan==="trial"){
    form.set("subscription_data[trial_period_days]","7");
    form.set("subscription_data[trial_settings][end_behavior][missing_payment_method]","cancel");
  }
  let session:any;
  try{
    const headers=new Headers({"Content-Type":"application/x-www-form-urlencoded",
      "Idempotency-Key":"gatebrook-qa-"+user.id+"-"+workspaceId+"-"+plan+"-"+(oldSessionId||"initial")});
    const created=await stripe("checkout/sessions",{method:"POST",headers,body:form});
    if(!created.ok||created.value.livemode!==false||
       typeof created.value.client_secret!=="string"||
       typeof created.value.id!=="string"||!created.value.id.startsWith("cs_test_"))
       return reply(503,{error:"Stripe rejected the sandbox checkout. Verify the Gatebrook QA keys and prices."},origin);
    session=created.value;
  }catch{return reply(503,{error:"Stripe sandbox checkout is unavailable. No real payment was attempted."},origin)}
  const {error:saveError}=await db.from("gatebrook_qa_subscriptions").upsert({
    workspace_id:workspaceId,owner_user_id:user.id,plan,status:"incomplete",
    stripe_checkout_session_id:session.id,stripe_subscription_id:null,stripe_customer_id:null,
    trial_end:null,current_period_end:null,cancel_at_period_end:false,updated_at:new Date().toISOString()
  },{onConflict:"workspace_id"});
  if(saveError)return reply(503,{error:"Sandbox checkout was created but could not be saved. Contact Gatebrook QA support."},origin);
  return reply(200,{mode:"embedded",client_secret:session.client_secret,publishable_key:STRIPE_PUBLIC_TEST,reused:false},origin);
});
