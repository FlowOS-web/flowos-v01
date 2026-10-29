import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const DB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(DB_URL, SERVICE, { auth:{persistSession:false,autoRefreshToken:false} });
const SITE = "https://gatebrook.work";
const allowedOrigins = new Set([SITE, "https://flowos-web.github.io"]);
function response(status:number, value:unknown, origin:string|null) {
  return new Response(JSON.stringify(value), {status,headers:{
    "Content-Type":"application/json","Cache-Control":"no-store",
    "Access-Control-Allow-Origin":allowedOrigins.has(origin||"") ? origin! : SITE,
    "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods":"GET, OPTIONS","Vary":"Origin"
  }});
}
function asTimestamp(value:unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}
Deno.serve(async req=>{
  const origin=req.headers.get("origin");
  if(req.method==="OPTIONS") return response(200,{ok:true},origin);
  if(req.method!=="GET") return response(405,{error:"Method not allowed"},origin);
  if(origin && !allowedOrigins.has(origin)) return response(403,{error:"Untrusted origin"},origin);
  const token=req.headers.get("authorization")?.replace(/^Bearer\\s+/i,"");
  if(!token) return response(401,{error:"Sign in to test Gatebrook QA."},origin);
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user||user.is_anonymous) return response(401,{error:"Sign in again to continue."},origin);
  const {data:tester,error:testerError}=await db.from("gatebrook_qa_testers")
    .select("user_id").eq("user_id",user.id).maybeSingle();
  if(testerError) return response(503,{error:"QA authorization check failed."},origin);
  if(!tester) return response(403,{error:"This account has not been enabled for Gatebrook QA."},origin);
  const {data:workspace,error:wsError}=await db.from("gatebrook_qa_workspaces")
    .select("id,name").eq("owner_user_id",user.id).maybeSingle();
  if(wsError) return response(503,{error:"QA workspace check failed."},origin);
  if(!workspace) return response(200,{sandbox:true,allowed:false,has_workspace:false,status:"not_started",account_email:user.email||null},origin);
  const {data:sub,error:subError}=await db.from("gatebrook_qa_subscriptions")
    .select("plan,status,trial_end,current_period_end,cancel_at_period_end,stripe_checkout_session_id")
    .eq("workspace_id",workspace.id).maybeSingle();
  if(subError) return response(503,{error:"QA subscription check failed."},origin);
  const status=sub?.status||"not_started";
  const expiration = status==="trialing" ? asTimestamp(sub?.trial_end) : asTimestamp(sub?.current_period_end);
  const allowed = ["trialing","active"].includes(status) && expiration!==null && expiration>Date.now();
  return response(200,{
    sandbox:true,allowed,has_workspace:true,workspace_name:workspace.name,
    status,plan:sub?.plan||null,trial_end:sub?.trial_end||null,
    current_period_end:sub?.current_period_end||null,
    cancel_at_period_end:sub?.cancel_at_period_end===true,
    pending_checkout:status==="incomplete"&&!!sub?.stripe_checkout_session_id
  },origin);
});
