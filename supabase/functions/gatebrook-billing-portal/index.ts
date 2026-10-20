import { createClient } from "npm:@supabase/supabase-js@2.117.3";
const URL=Deno.env.get("SUPABASE_URL")!, SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, STRIPE=Deno.env.get("STRIPE_SECRET_KEY")!;
const db=createClient(URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Cache-Control":"no-store"};
const reply=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply(405,{error:"Method not allowed"});
 const origin=req.headers.get("origin");if(origin&&origin!=="https://gatebrook.work"&&origin!=="https://flowos-web.github.io")return reply(403,{error:"Origin not allowed"});
 if(!STRIPE)return reply(503,{error:"Billing is not configured yet."});
 const token=req.headers.get("authorization")?.replace(/^Bearer\\s+/i,"");if(!token)return reply(401,{error:"Please sign in again."});
 const {data:{user},error:authError}=await db.auth.getUser(token);if(authError||!user||user.is_anonymous)return reply(401,{error:"Your session is invalid."});
 const {data:sub,error}=await db.from("gatebrook_subscriptions").select("business_id,stripe_customer_id,status,user_id").eq("user_id",user.id).maybeSingle();
 if(error)return reply(503,{error:"Could not load subscription details."});
 if(!sub||!sub.stripe_customer_id||sub.user_id!==user.id)return reply(409,{error:"No Stripe billing account is linked yet."});
 const form=new URLSearchParams({customer:sub.stripe_customer_id,return_url:"https://gatebrook.work/billing.html?portal=return"});
 try{const res=await fetch("https://api.stripe.com/v1/billing_portal/sessions",{method:"POST",headers:{Authorization:"Bearer "+STRIPE,"Content-Type":"application/x-www-form-urlencoded"},body:form});const data=await res.json();if(!res.ok||typeof data.url!=="string")return reply(503,{error:"Stripe billing management is not available. Please retry."});return reply(200,{url:data.url})}catch{return reply(503,{error:"Stripe billing management is not available. Please retry."})}
});