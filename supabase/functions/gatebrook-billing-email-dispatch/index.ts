import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { renderBillingEmail, type BillingEmailKind } from "./email-template.ts";

// Production-only dispatcher: no public request may select recipients or send mail.
const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL = Deno.env.get("BILLING_FROM_EMAIL") ||
  Deno.env.get("FROM_EMAIL") || "";
const db=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const nowIso=()=>new Date().toISOString();
const out=(code:number,value:unknown)=>new Response(JSON.stringify(value),{
  status:code,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
type SubscriptionRow={
  business_id:string;user_id:string;stripe_subscription_id:string;status:string;
  trial_end:string|null;current_period_end:string|null;cancel_at_period_end:boolean;
  plan:"monthly"|"annual";created_at:string;
};
type EmailJob={
  id:string;business_id:string;stripe_subscription_id:string;
  kind:BillingEmailKind;cycle_key:string;due_at:string;status:string;attempts:number;
};
const inactive=new Set(["canceled","paused","unpaid","incomplete_expired"]);
function ms(v:string|null|undefined){const n=v?Date.parse(v):NaN;return Number.isFinite(n)?n:null}
async function enqueue(row:SubscriptionRow,kind:BillingEmailKind,cycleKey:string,dueAt:string) {
  const {error}=await db.from("gatebrook_billing_email_jobs").upsert({
    business_id:row.business_id,stripe_subscription_id:row.stripe_subscription_id,
    kind,cycle_key:cycleKey,due_at:dueAt,status:"queued"
  },{onConflict:"stripe_subscription_id,kind,cycle_key",ignoreDuplicates:true});
  if(error)throw new Error("Unable to enqueue billing email");
}
async function scan(row:SubscriptionRow) {
  const {data:prior,error:oldError}=await db.from("gatebrook_billing_email_state")
    .select("last_status,last_trial_end,stripe_subscription_id,transition_seq")
    .eq("business_id",row.business_id).maybeSingle();
  if(oldError)throw new Error("Unable to read prior email state");
  const newSubscription=!prior||prior.stripe_subscription_id!==row.stripe_subscription_id;
  const prevStatus=prior?.last_status||null;
  const sameSubscription=!newSubscription;
  const seq=(prior?.transition_seq||0)+(prevStatus&&prevStatus!==row.status?1:0)+(newSubscription&&prior?1:0);
  const trial=ms(row.trial_end);
  const cycle=trial?new Date(trial).toISOString():"no-trial";
  if(row.status==="trialing"&&trial&&trial>Date.now()){
    // New customers receive welcome; returning customers receive reactivation.
    const created=ms(row.created_at);
    if(newSubscription&&(!prevStatus||!inactive.has(prevStatus))&&
       created&&Date.now()-created<24*3600e3)
      await enqueue(row,"trial_welcome",cycle,nowIso());
    await enqueue(row,"trial_3_day",cycle,new Date(trial-3*864e5).toISOString());
    await enqueue(row,"trial_1_day",cycle,new Date(trial-864e5).toISOString());
  }
  if(sameSubscription&&prevStatus==="trialing"&&row.status==="active"&&trial&&trial<=Date.now())
    await enqueue(row,"trial_converted",cycle,nowIso());
  if(sameSubscription&&prevStatus&&!inactive.has(prevStatus)&&inactive.has(row.status))
    await enqueue(row,"trial_expired","transition-"+seq,nowIso());
  if(prevStatus&&inactive.has(prevStatus)&&["active","trialing"].includes(row.status))
    await enqueue(row,"reactivated","transition-"+seq,nowIso());
  const {error}=await db.from("gatebrook_billing_email_state").upsert({
    business_id:row.business_id,stripe_subscription_id:row.stripe_subscription_id,
    last_status:row.status,last_trial_end:row.trial_end,
    transition_seq:seq,last_seen_at:nowIso()
  },{onConflict:"business_id"});
  if(error)throw new Error("Unable to save billing email state");
}
async function stripe(path:string) {
  const response=await fetch("https://api.stripe.com/v1/"+path,{
    headers:{"Authorization":"Bearer "+STRIPE_KEY}
  });
  if(!response.ok)throw new Error("Stripe subscription verification failed");
  return await response.json();
}
async function mark(job:EmailJob,status:"sent"|"skipped"|"failed"|"queued",
  more:Record<string,unknown>={}) {
  const {error}=await db.from("gatebrook_billing_email_jobs").update({
    status,locked_at:null,updated_at:nowIso(),...more
  }).eq("id",job.id).eq("status","processing");
  if(error)throw new Error("Could not record billing email delivery status");
}
async function processJob(job:EmailJob) {
  const {data:local,error:recordError}=await db.from("gatebrook_subscriptions")
    .select("business_id,user_id,stripe_subscription_id,plan,status,trial_end,current_period_end,cancel_at_period_end")
    .eq("business_id",job.business_id).maybeSingle();
  if(recordError)throw new Error("Unable to verify local subscription");
  if(!local||local.stripe_subscription_id!==job.stripe_subscription_id)
    return mark(job,"skipped",{last_error:"Subscription replaced or removed"});
  const sub=await stripe("subscriptions/"+encodeURIComponent(job.stripe_subscription_id));
  if(sub.livemode!==true||sub.id!==job.stripe_subscription_id||
     sub.metadata?.business_id!==local.business_id||
     sub.metadata?.user_id!==local.user_id||
     sub.status!==local.status) {
    return mark(job,"skipped",{last_error:"Live Stripe subscription mismatch"});
  }
  const subTrial=typeof sub.trial_end==="number"?sub.trial_end*1000:null;
  const localTrial=ms(local.trial_end);
  const start=ms(job.due_at)||0;
  const now=Date.now();
  const isReminder=job.kind==="trial_3_day"||job.kind==="trial_1_day";
  if(["trial_welcome","trial_3_day","trial_1_day"].includes(job.kind)){
    if(sub.status!=="trialing"||sub.cancel_at_period_end||
       (sub.cancel_at&&subTrial&&sub.cancel_at*1000<=subTrial)||
       !subTrial||!localTrial||subTrial!==localTrial||
       job.cycle_key!==new Date(subTrial).toISOString()||
       now>=subTrial)return mark(job,"skipped",{last_error:"Trial ended or changed"});
    if(isReminder&&(now<start||now>start+12*3600e3))
      return mark(job,"skipped",{last_error:"Trial reminder outside delivery window"});
  }
  if(job.kind==="trial_converted"){
    if(sub.status!=="active"||!subTrial||subTrial>now)
      return mark(job,"skipped",{last_error:"Subscription not converted"});
    const invoiceId=typeof sub.latest_invoice==="string"?sub.latest_invoice:sub.latest_invoice?.id;
    if(!invoiceId)throw new Error("Missing subscription invoice");
    const invoice=await stripe("invoices/"+encodeURIComponent(invoiceId));
    if(invoice.livemode!==true||invoice.status!=="paid")
      return mark(job,"skipped",{last_error:"Subscription invoice not paid"});
  }
  if(job.kind==="trial_expired"&&!inactive.has(sub.status))
    return mark(job,"skipped",{last_error:"Subscription access was restored"});
  if(job.kind==="reactivated"&&!["active","trialing"].includes(sub.status))
    return mark(job,"skipped",{last_error:"Subscription no longer active"});
  const {data:membership,error:memberError}=await db.from("business_users")
    .select("id").eq("business_id",local.business_id)
    .eq("user_id",local.user_id).eq("role","owner").maybeSingle();
  if(memberError)throw new Error("Unable to confirm account ownership");
  if(!membership)return mark(job,"skipped",{last_error:"Owner membership no longer valid"});
  const {data:workspace,error:businessError}=await db.from("businesses")
    .select("name").eq("id",local.business_id).maybeSingle();
  if(businessError)throw new Error("Unable to check business");
  if(!workspace)return mark(job,"skipped",{last_error:"Business removed"});
  const {data:auth,error:authError}=await db.auth.admin.getUserById(local.user_id);
  if(authError)throw new Error("Unable to find billing account");
  const owner=auth?.user;
  if(!owner?.email||!owner.email_confirmed_at||owner.is_anonymous)
    return mark(job,"skipped",{last_error:"No confirmed owner billing email"});
  const email=renderBillingEmail(job.kind,{
    businessName:workspace.name,trialEnd:local.trial_end,
    plan:local.plan==="annual"?"annual":"monthly"
  });
  const response=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":"Bearer "+RESEND_KEY,
      "Content-Type":"application/json","Idempotency-Key":"gatebrook-"+job.id},
    body:JSON.stringify({
      from:FROM_EMAIL,to:[owner.email],subject:email.subject,html:email.html,text:email.text
    })
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok){
    const code=typeof body?.name==="string"?body.name:"provider_error";
    if([400,401,403,404,422].includes(response.status))
      return mark(job,"failed",{last_error:"Resend rejected message ("+response.status+", "+code+")"});
    throw new Error("Resend transient error "+response.status);
  }
  if(typeof body.id!=="string")throw new Error("Email provider did not confirm acceptance");
  await mark(job,"sent",{resend_email_id:body.id,sent_at:nowIso(),last_error:null});
}
Deno.serve(async req=>{
  if(req.method!=="POST")return out(405,{error:"Method not allowed"});
  const token=req.headers.get("x-gatebrook-billing-job")||"";
  if(token.length!==64)return out(401,{error:"Unauthorized"});
  const {data:authorized,error:authError}=await db.rpc("gatebrook_billing_verify_job_token",{p_token:token});
  if(authError||authorized!==true)return out(401,{error:"Unauthorized"});
  // Never let the dispatcher send sandbox notifications or use test Stripe credentials.
  if(!/^(sk|rk)_live_[A-Za-z0-9_-]+$/.test(STRIPE_KEY)||!RESEND_KEY||
     !FROM_EMAIL||FROM_EMAIL.includes("@resend.dev"))
    return out(503,{error:"Production billing mail provider is not configured"});
  let scanned=0,claimed=0,sent=0,errors=0;
  try{
    for(let offset=0;offset<1000;offset+=200){
      const {data:rows,error}=await db.from("gatebrook_subscriptions")
        .select("business_id,user_id,stripe_subscription_id,status,trial_end,current_period_end,cancel_at_period_end,plan,created_at")
        .not("stripe_subscription_id","is",null)
        .order("created_at",{ascending:true}).range(offset,offset+199);
      if(error)throw new Error("Unable to load subscriptions");
      for(const row of rows||[]){await scan(row as SubscriptionRow);scanned++}
      if(!rows||rows.length<200)break;
    }
    const {data:jobs,error:claimError}=await db.rpc("gatebrook_billing_claim_email_jobs",{p_limit:12});
    if(claimError)throw new Error("Unable to claim email queue");
    claimed=(jobs||[]).length;
    for(const job of (jobs||[]) as EmailJob[]){
      try{await processJob(job);sent++}catch(err){
        errors++;
        console.error("Billing email job failed",job.id,err instanceof Error?err.message:"unknown");
        const attempts=job.attempts||1;
        await mark(job,attempts>=6?"failed":"queued",{
          due_at:new Date(Date.now()+Math.min(60,2**attempts)*60*1000).toISOString(),
          last_error:err instanceof Error?err.message.slice(0,180):"Transient error"
        });
      }
    }
    return out(200,{ok:true,scanned,claimed,processed:sent,errors});
  }catch(err){
    console.error("Billing email scan error",err instanceof Error?err.message:"unknown");
    return out(503,{error:"Billing email dispatcher temporarily unavailable",scanned,claimed,errors});
  }
});
