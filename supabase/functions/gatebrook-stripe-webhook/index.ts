import { createClient } from "npm:@supabase/supabase-js@2.117.3";
const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
function equal(a: Uint8Array, b: Uint8Array) { if (a.length !== b.length) return false; let out = 0; for (let i=0;i<a.length;i++) out |= a[i] ^ b[i]; return out === 0; }
function hex(bytes: Uint8Array) { return [...bytes].map(x => x.toString(16).padStart(2,"0")).join(""); }
async function verify(raw: string, header: string, secret: string) {
  const parts = header.split(",").map(x=>x.trim().split("="));
  const timestamp = parts.find(x=>x[0]==="t")?.[1];
  const signatures = parts.filter(x=>x[0]==="v1").map(x=>x[1]);
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp)) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp+"."+raw)));
  return signatures.some(s => /^[0-9a-f]{64}$/i.test(s) && equal(digest, Uint8Array.from(s.match(/../g)!.map(x=>parseInt(x,16)))));
}
async function stripeSubscription(id: string) {
  const res = await fetch("https://api.stripe.com/v1/subscriptions/"+encodeURIComponent(id), { headers: { Authorization: "Bearer "+STRIPE_KEY } });
  const data = await res.json();
  if (!res.ok) throw new Error("Unable to retrieve subscription from Stripe");
  return data as Record<string, any>;
}
// Stripe invoices use both legacy invoice.subscription and newer
// parent.subscription_details.subscription / line-item parent paths.
// Resolve the subscribed resource, then re-fetch its current state from Stripe.
function subscriptionIdFromInvoice(inv: Record<string, any>): string | null {
  const candidates: unknown[] = [
    inv.subscription,
    inv.parent?.subscription_details?.subscription,
    ...(Array.isArray(inv.lines?.data) ? inv.lines.data.flatMap((line: Record<string, any>) => [
      line.subscription,
      line.parent?.subscription_item_details?.subscription,
      line.parent?.license_fee_subscription_details?.subscription
    ]) : [])
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.startsWith("sub_")) return value;
    if (typeof value === "object" && value !== null && typeof (value as any).id === "string"
       && (value as any).id.startsWith("sub_")) return (value as any).id;
  }
  return null;
}
function epoch(v: unknown) { return typeof v === "number" && Number.isFinite(v) ? new Date(v*1000).toISOString() : null; }
function periodValue(sub: Record<string, any>, key: "current_period_start" | "current_period_end") { return sub[key] ?? sub.items?.data?.[0]?.[key] ?? null; }
async function persistSubscription(sub: Record<string, any>, eventId: string) {
  const businessId = sub.metadata?.business_id;
  const userId = sub.metadata?.user_id;
  if (typeof businessId !== "string" || typeof userId !== "string") throw new Error("Subscription metadata missing");
  const status = ["incomplete","incomplete_expired","trialing","active","past_due","canceled","unpaid","paused"].includes(sub.status) ? sub.status : "incomplete";
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const { error } = await db.from("gatebrook_subscriptions").upsert({
    business_id: businessId, user_id: userId, stripe_customer_id: customerId ?? null,
    stripe_subscription_id: sub.id, plan: sub.metadata?.plan === "annual" ? "annual" : "monthly",
    status, trial_end: epoch(sub.trial_end), current_period_start: epoch(periodValue(sub,"current_period_start")),
    current_period_end: epoch(periodValue(sub,"current_period_end")), cancel_at_period_end: sub.cancel_at_period_end === true,
    last_stripe_event_id: eventId, updated_at: new Date().toISOString()
  }, { onConflict: "business_id" });
  if (error) throw new Error("Could not persist subscription state");
  const end = periodValue(sub,"current_period_end");
  const hasAccess = ["trialing","active"].includes(status) && (typeof end === "number" && end*1000 > Date.now() || status === "trialing" && typeof sub.trial_end === "number" && sub.trial_end*1000 > Date.now());
  const { error: businessError } = await db.from("businesses").update({ active: hasAccess }).eq("id", businessId);
  if (businessError) throw new Error("Could not update workspace access");
  const { error: profileError } = await db.from("business_public_profiles").update({ active: hasAccess }).eq("business_id", businessId);
  if (profileError) throw new Error("Could not update public profile access");
}
Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405,{error:"Method not allowed"});
  if (!STRIPE_KEY || !WEBHOOK_SECRET) return json(503,{error:"Webhook is not configured"});
  const signature = req.headers.get("stripe-signature");
  if (!signature) return json(400,{error:"Missing Stripe signature"});
  const raw = await req.text();
  if (!await verify(raw, signature, WEBHOOK_SECRET)) return json(400,{error:"Invalid Stripe signature"});
  let event: Record<string, any>;
  try { event = JSON.parse(raw); } catch { return json(400,{error:"Invalid event body"}); }
  if (event.livemode !== true || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object)
    return json(400,{error:"Invalid live Stripe event"});
  const { data: seen } = await db.from("gatebrook_stripe_events").select("event_id").eq("event_id",event.id).maybeSingle();
  if (seen) return json(200,{received:true,duplicate:true});
  try {
    const obj = event.data.object as Record<string, any>;
    if (event.type === "customer.subscription.deleted") {
      await persistSubscription(obj,event.id);
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      // Fetch current Stripe state so delayed/retried events cannot roll a newer status backward.
      await persistSubscription(await stripeSubscription(obj.id),event.id);
    } else if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      if (subscriptionId) await persistSubscription(await stripeSubscription(subscriptionId),event.id);
    } else if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
      const subscriptionId = subscriptionIdFromInvoice(obj);
      if (subscriptionId) await persistSubscription(await stripeSubscription(subscriptionId),event.id);
    }
    const { error: eventError } = await db.from("gatebrook_stripe_events").insert({event_id:event.id,event_type:event.type});
    if (eventError && eventError.code !== "23505") throw new Error("Could not record Stripe event");
    return json(200,{received:true});
  } catch (e) {
    console.error("Stripe webhook processing failed", event.id, event.type, e instanceof Error ? e.message : "unknown");
    return json(500,{error:"Webhook processing failed; Stripe may retry"});
  }
});