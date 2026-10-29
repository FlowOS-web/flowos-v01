import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_TEST = Deno.env.get("GATEBROOK_QA_STRIPE_SECRET_KEY")||"";
const WEBHOOK_SECRET = Deno.env.get("GATEBROOK_QA_WEBHOOK_SECRET")||"";
const db=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const API_VERSION="2026-09-30.endive";
const respond=(code:number,value:unknown)=>new Response(JSON.stringify(value),{
  status:code,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}
});
function constantEqual(a:Uint8Array,b:Uint8Array) {
  if(a.length!==b.length)return false;
  let n=0;for(let i=0;i<a.length;i++)n|=a[i]^b[i];return n===0;
}
async function verify(raw:string,header:string,secret:string) {
  const parts=header.split(",").map(x=>x.trim().split("="));
  const seconds=parts.find(x=>x[0]==="t")?.[1]||"";
  const signs=parts.filter(x=>x[0]==="v1").map(x=>x[1]);
  if(!/^\d+$/.test(seconds)||Math.abs(Date.now()/1000-Number(seconds))>300||!signs.length)return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const expected=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(seconds+"."+raw)));
  return signs.some(s=>{
    if(!/^[0-9a-f]{64}$/i.test(s))return false;
    const received=Uint8Array.from((s.match(/../g)||[]).map(h=>parseInt(h,16)));
    return constantEqual(expected,received);
  });
}
async function getStripe(path:string) {
  const res=await fetch("https://api.stripe.com/v1/"+path,{headers:{
    "Authorization":"Bearer "+STRIPE_TEST,"Stripe-Version":API_VERSION
  }});
  if(!res.ok)throw Error("Sandbox Stripe API request unsuccessful");
  return await res.json();
}
function subscriptionIdFromInvoice(inv:any) {
  const sources=[
    inv?.subscription,inv?.parent?.subscription_details?.subscription,
    inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
  ];
  const value=sources.find(x=>typeof x==="string"||typeof x?.id==="string");
  return typeof value==="string"?value:typeof value?.id==="string"?value.id:null;
}
function timestamp(value:unknown) {
  return typeof value==="number"&&Number.isFinite(value)?new Date(value*1000).toISOString():null;
}
function getPeriod(sub:any) {
  return sub.current_period_end??sub.items?.data?.[0]?.current_period_end??null;
}
async function persistVerifiedSubscription(id:string,checkCheckoutId?:string) {
  const sub=await getStripe("subscriptions/"+encodeURIComponent(id));
  if(sub.livemode!==false||sub.metadata?.qa_env!=="gatebrook_qa")return "ignored";
  const workspaceId=sub.metadata?.qa_workspace_id;
  const ownerId=sub.metadata?.qa_owner_user_id;
  if(typeof workspaceId!=="string"||typeof ownerId!=="string")return "ignored";
  const {data:workspace,error:wsError}=await db.from("gatebrook_qa_workspaces")
    .select("id,owner_user_id").eq("id",workspaceId).maybeSingle();
  if(wsError)throw Error("Could not check QA workspace");
  if(!workspace||workspace.owner_user_id!==ownerId)return "ignored";
  const {data:tester,error:testerError}=await db.from("gatebrook_qa_testers")
    .select("user_id").eq("user_id",ownerId).maybeSingle();
  if(testerError)throw Error("Could not check QA tester");
  if(!tester)return "ignored";
  const {data:record,error:recordError}=await db.from("gatebrook_qa_subscriptions")
    .select("workspace_id,owner_user_id,stripe_checkout_session_id,stripe_subscription_id")
    .eq("workspace_id",workspaceId).maybeSingle();
  if(recordError)throw Error("Could not check QA subscription record");
  if(!record||record.owner_user_id!==ownerId||!record.stripe_checkout_session_id)return "ignored";
  if(checkCheckoutId&&checkCheckoutId!==record.stripe_checkout_session_id)return "ignored";
  if(record.stripe_subscription_id&&record.stripe_subscription_id!==sub.id)return "ignored";
  const session=await getStripe("checkout/sessions/"+encodeURIComponent(record.stripe_checkout_session_id));
  const sessionSub=typeof session.subscription==="string"?session.subscription:session.subscription?.id;
  if(session.livemode!==false||session.id!==record.stripe_checkout_session_id||
    sessionSub!==sub.id||session.mode!=="subscription"||
    session.metadata?.qa_env!=="gatebrook_qa"||session.metadata?.qa_workspace_id!==workspaceId)return "ignored";
  // A signed but early event cannot activate unpaid checkout. Stripe retries
  // the event; subsequent paid/subscription events will reconcile the state.
  if(session.status!=="complete")throw Error("Sandbox checkout not complete yet");
  if(session.payment_status==="unpaid"&&sub.status!=="trialing")return "pending";
  const status=["incomplete","incomplete_expired","trialing","active","past_due","unpaid","canceled","paused"]
    .includes(sub.status)?sub.status:"incomplete";
  const plan=sub.metadata?.qa_plan==="annual"?"annual":sub.metadata?.qa_plan==="trial"?"trial":"monthly";
  const {error:saveError}=await db.from("gatebrook_qa_subscriptions").update({
    status,plan,stripe_subscription_id:sub.id,
    stripe_customer_id:typeof sub.customer==="string"?sub.customer:sub.customer?.id||null,
    trial_end:timestamp(sub.trial_end),current_period_end:timestamp(getPeriod(sub)),
    cancel_at_period_end:sub.cancel_at_period_end===true,
    updated_at:new Date().toISOString()
  }).eq("workspace_id",workspaceId).eq("stripe_checkout_session_id",record.stripe_checkout_session_id);
  if(saveError)throw Error("Unable to persist sandbox subscription");
  return "updated";
}
Deno.serve(async req=>{
  if(req.method!=="POST")return respond(405,{error:"Method not allowed"});
  if(!/^(sk|rk)_test_[A-Za-z0-9_-]+$/.test(STRIPE_TEST)||
     !/^whsec_[A-Za-z0-9]+$/.test(WEBHOOK_SECRET))
    return respond(503,{error:"Sandbox webhook credentials not configured"});
  const signature=req.headers.get("stripe-signature");
  if(!signature)return respond(400,{error:"Missing Stripe signature"});
  const raw=await req.text();
  if(!await verify(raw,signature,WEBHOOK_SECRET))return respond(400,{error:"Invalid Stripe signature"});
  let event:any;
  try{event=JSON.parse(raw)}catch{return respond(400,{error:"Invalid event body"})}
  if(event.livemode!==false||typeof event.id!=="string"||typeof event.type!=="string"||!event.data?.object)
    return respond(400,{error:"Invalid sandbox event"});
  const {data:previous,error:readError}=await db.from("gatebrook_qa_events")
    .select("event_id").eq("event_id",event.id).maybeSingle();
  if(readError)return respond(503,{error:"Could not check event history"});
  if(previous)return respond(200,{received:true,duplicate:true});
  const obj=event.data.object;
  let result="ignored";
  try{
    if(["checkout.session.completed","checkout.session.async_payment_succeeded"].includes(event.type)){
      const id=typeof obj.subscription==="string"?obj.subscription:obj.subscription?.id;
      if(obj.metadata?.qa_env==="gatebrook_qa"&&typeof id==="string")
        result=await persistVerifiedSubscription(id,obj.id);
    } else if(["customer.subscription.created","customer.subscription.updated","customer.subscription.deleted"].includes(event.type)){
      if(typeof obj.id==="string")result=await persistVerifiedSubscription(obj.id);
    } else if(["invoice.paid","invoice.payment_failed"].includes(event.type)){
      const id=subscriptionIdFromInvoice(obj);
      if(id)result=await persistVerifiedSubscription(id);
    }
    if(result==="pending")return respond(202,{received:true,pending:true});
    if(result==="updated"){
      const {error:saveEvent}=await db.from("gatebrook_qa_events").insert({
        event_id:event.id,event_type:event.type
      });
      if(saveEvent&&saveEvent.code!=="23505")throw Error("Could not record QA webhook event");
    }
    return respond(200,{received:true,processed:result==="updated"});
  }catch(e){
    console.error("QA webhook processing failed",event.id,event.type,e instanceof Error?e.message:"unknown");
    return respond(500,{error:"Sandbox webhook processing failed; Stripe may retry"});
  }
});
