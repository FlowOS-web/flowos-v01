import { createClient } from "npm:@supabase/supabase-js@2.117.3";
const url = Deno.env.get("SUPABASE_URL")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(url, service, {auth:{persistSession:false,autoRefreshToken:false}});
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET, OPTIONS","Cache-Control":"no-store","Vary":"Origin"};
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="GET")return reply(405,{error:"Method not allowed"});
 const origin=req.headers.get("origin");if(origin&&origin!=="https://gatebrook.work"&&origin!=="https://flowos-web.github.io")return reply(403,{error:"Origin not allowed"});
 const token=req.headers.get("authorization")?.replace(/^Bearer\s+/i,"");if(!token)return reply(401,{error:"Sign in required"});
 const {data:{user},error}=await db.auth.getUser(token);if(error||!user||user.is_anonymous)return reply(401,{error:"Session expired"});
 const {data:membership,error:memberError}=await db.from("business_users").select("business_id,role").eq("user_id",user.id).order("business_id").limit(1).maybeSingle();
 if(memberError)return reply(503,{error:"Could not check workspace access"});
 if(!membership)return reply(200,{allowed:false,reason:"setup_required",next:"onboarding.html"});
 const {data:sub,error:subError}=await db.from("gatebrook_subscriptions").select("status,current_period_end,cancel_at_period_end,trial_end,plan").eq("business_id",membership.business_id).maybeSingle();
 if(subError)return reply(503,{error:"Could not check subscription status"});
 // Preserve access to the seeded Northstar demo workspace, which predates billing
 // and intentionally has no Stripe subscription record. This exception is scoped
 // to the active demo slug; all other businesses remain subscription-gated.
 if(!sub){
   const {data:business,error:businessError}=await db.from("businesses").select("slug,active").eq("id",membership.business_id).maybeSingle();
   if(businessError)return reply(503,{error:"Could not check workspace status"});
   if(business?.active===true&&business.slug==="flowos-demo"){
     return reply(200,{allowed:true,business_id:membership.business_id,role:membership.role,status:"demo",plan:null,trial_end:null,current_period_end:null,cancel_at_period_end:false});
   }
 }
 const periodValid=!sub?.current_period_end||Date.parse(sub.current_period_end)>Date.now();
 const allowed=!!sub&&["active","trialing"].includes(sub.status)&&periodValid;
 if(!allowed)return reply(200,{allowed:false,reason:sub?.status||"setup_required",next:sub&&sub.status!=="incomplete"&&sub.status!=="incomplete_expired"?"billing.html":"onboarding.html",status:sub?.status??null});
 return reply(200,{allowed:true,business_id:membership.business_id,role:membership.role,status:sub.status,plan:sub.plan,trial_end:sub.trial_end,current_period_end:sub.current_period_end,cancel_at_period_end:sub.cancel_at_period_end});
});