import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { renderBillingEmail, type BillingEmailKind } from "./email-template.ts";
import { prepareBillingPreview } from "./preview-links.ts";

// Sandbox tester-controlled mail preview. It NEVER creates a checkout, changes
// subscription status or accepts arbitrary recipients.
const URL=Deno.env.get("SUPABASE_URL")!;
const SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND=Deno.env.get("RESEND_API_KEY")||"";
const FROM=Deno.env.get("BILLING_FROM_EMAIL")||
 Deno.env.get("FROM_EMAIL")||"";
const db=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const origins=new Set(["https://gatebrook.work","https://flowos-web.github.io"]);
const types=new Set(["trial_welcome","trial_3_day","trial_1_day","trial_converted","trial_expired","reactivated"]);
function result(code:number,data:unknown,origin:string|null) {
 return new Response(JSON.stringify(data),{status:code,headers:{
  "Content-Type":"application/json","Cache-Control":"no-store",
  "Access-Control-Allow-Origin":origins.has(origin||"")?origin!:"https://gatebrook.work",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
  "Access-Control-Allow-Methods":"POST,OPTIONS","Vary":"Origin"
 }});
}
Deno.serve(async req=>{
 const origin=req.headers.get("origin");
 if(req.method==="OPTIONS")return result(200,{ok:true},origin);
 if(req.method!=="POST")return result(405,{error:"Method not allowed"},origin);
 if(origin&&!origins.has(origin))return result(403,{error:"Untrusted origin"},origin);
 const token=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");
 if(!token)return result(401,{error:"Sign in to Gatebrook QA first."},origin);
 const {data:{user},error:authError}=await db.auth.getUser(token);
 if(authError||!user||user.is_anonymous||!user.email||!user.email_confirmed_at)
  return result(401,{error:"A confirmed Gatebrook QA account is required."},origin);
 const {data:tester,error:testerError}=await db.from("gatebrook_qa_testers")
   .select("user_id").eq("user_id",user.id).maybeSingle();
 if(testerError)return result(503,{error:"Unable to verify tester permissions."},origin);
 if(!tester)return result(403,{error:"This account is not enabled for QA email tests."},origin);
 let body:any;
 try{body=await req.json()}catch{return result(400,{error:"Invalid request"},origin)}
 const kind=body?.kind;
 if(typeof kind!=="string"||!types.has(kind))
  return result(400,{error:"Choose a valid example email."},origin);
 if(!RESEND||!FROM||FROM.includes("@resend.dev"))return result(503,{error:"A verified Gatebrook email sender is not configured."},origin);
 const day=new Date().toISOString().slice(0,10);
 const existing=await db.from("gatebrook_billing_email_previews")
  .select("status,attempts").eq("user_id",user.id).eq("kind",kind)
  .eq("preview_day",day).maybeSingle();
 if(existing.error)return result(503,{error:"Unable to check QA email limits."},origin);
 if(existing.data?.status==="sent")return result(409,{error:"That example was already sent today. Select another email type."},origin);
 if(existing.data?.status==="pending")return result(409,{error:"A preview send is already in progress."},origin);
 if((existing.data?.attempts||0)>=3)return result(429,{error:"Retry limit reached for this preview today."},origin);
 if(existing.data){
   const {data:retry,error}=await db.from("gatebrook_billing_email_previews")
    .update({status:"pending",attempts:existing.data.attempts+1,updated_at:new Date().toISOString()})
    .eq("user_id",user.id).eq("kind",kind).eq("preview_day",day).eq("status","failed")
    .select("user_id").maybeSingle();
   if(error||!retry)return result(409,{error:"Another preview request is in progress."},origin);
 }else{
   const {error}=await db.from("gatebrook_billing_email_previews").insert({
    user_id:user.id,kind,preview_day:day,attempts:1,status:"pending"
   });
   if(error)return result(error.code==="23505"?409:503,{error:"Unable to reserve QA preview."},origin);
 }
 try{
   // Stable preview content for the UTC day: retries use the same Resend idempotency key.
   const hours=kind==="trial_1_day"?24:kind==="trial_3_day"?72:168;
   const fakeEnd=new Date(Date.parse(day+"T12:00:00.000Z")+hours*3600e3).toISOString();
   const sample=renderBillingEmail(kind as BillingEmailKind,{
    businessName:"Gatebrook QA Test Workspace",plan:"monthly",trialEnd:fakeEnd
   });
   const example=prepareBillingPreview(sample);
   const response=await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{
      "Authorization":"Bearer "+RESEND,"Content-Type":"application/json",
      "Idempotency-Key":"gatebrook-preview-"+user.id+"-"+kind+"-"+day
    },
    body:JSON.stringify({from:FROM,to:[user.email],
      subject:example.subject,html:example.html,
      text:example.text})
   });
   const mail=await response.json().catch(()=>({}));
   if(!response.ok||typeof mail.id!=="string")throw Error("Email provider rejected the test message ("+response.status+").");
   const {error:saveError}=await db.from("gatebrook_billing_email_previews")
    .update({status:"sent",resend_email_id:mail.id,updated_at:new Date().toISOString()})
    .eq("user_id",user.id).eq("kind",kind).eq("preview_day",day);
   if(saveError)throw Error("Email accepted but delivery journal could not be updated.");
   return result(200,{ok:true,kind,provider_accepted:true},origin);
 }catch(e){
   await db.from("gatebrook_billing_email_previews").update({
     status:"failed",updated_at:new Date().toISOString()
   }).eq("user_id",user.id).eq("kind",kind).eq("preview_day",day);
   console.error("QA billing email preview failed",kind,e instanceof Error?e.message:"unknown");
   return result(503,{error:"Could not send the example email. Check Resend delivery configuration."},origin);
 }
});
