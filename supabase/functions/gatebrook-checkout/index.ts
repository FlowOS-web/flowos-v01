import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const MONTHLY_PRICE = Deno.env.get("STRIPE_PRICE_MONTHLY")!;
const ANNUAL_PRICE = Deno.env.get("STRIPE_PRICE_ANNUAL")!;
const SITE = "https://gatebrook.work";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const clean = (v: unknown, max: number) => typeof v === "string" ? v.trim().normalize("NFC").slice(0, max) : "";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  const origin = req.headers.get("origin");
  if (origin && origin !== SITE && origin !== "https://flowos-web.github.io") return reply(403, { error: "Origin not allowed" });
  if (!STRIPE_KEY || !MONTHLY_PRICE || !ANNUAL_PRICE) return reply(503, { error: "Billing is not configured yet. Please try again later." });
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Please sign in again." });
  const { data: auth, error: authError } = await db.auth.getUser(token);
  if (authError || !auth.user || auth.user.is_anonymous) return reply(401, { error: "Your session is invalid. Please sign in again." });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: "Invalid request." }); }
  const name = clean(body.business_name, 100);
  const industry = clean(body.industry, 120);
  const slug = clean(body.slug, 48).toLowerCase();
  const tagline = clean(body.tagline, 160);
  const plan = body.plan === "trial" ? "trial" : body.plan === "annual" ? "annual" : body.plan === "monthly" ? "monthly" : "";
  if (!name || !industry || !plan || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3 || slug.length > 48) return reply(400, { error: "Check the business details and plan, then try again." });
  if (["admin","api","auth","dashboard","index","login","onboarding","privacy","request","settings","signup","support","terms","www"].includes(slug)) return reply(400, { error: "That business link is reserved. Choose another." });

  // Reuse the authenticated user's incomplete setup; never trust a client-supplied user/business ID.
  const { data: existing } = await db.from("business_users").select("business_id,businesses(id,name,slug)").eq("user_id", auth.user.id).limit(1).maybeSingle();
  let businessId = existing?.business_id as string | undefined;
  let previousCheckoutSessionId: string | null = null;
  if (!businessId) {
    const { data: business, error: businessError } = await db.from("businesses").insert({
      name, slug, industry, owner_email: auth.user.email ?? null, active: false
    }).select("id").single();
    if (businessError || !business) return reply(businessError?.code === "23505" ? 409 : 503, { error: businessError?.code === "23505" ? "That public page link is already in use." : "Could not save business setup. Please retry." });
    businessId = business.id;
    const { error: memberError } = await db.from("business_users").insert({ business_id: businessId, user_id: auth.user.id, role: "owner" });
    if (memberError) { await db.from("businesses").delete().eq("id", businessId); return reply(503, { error: "Could not link your account to the business. Please retry." }); }
    const { error: profileError } = await db.from("business_public_profiles").upsert({
      business_id: businessId, slug, display_name: name, industry, tagline: tagline || null, active: false
    });
    if (profileError) return reply(503, { error: "Business profile setup could not be saved. Please retry." });
    await db.from("business_request_forms").upsert({ business_id: businessId, template_key: industry === "Auto detailing" ? "auto_detailing" : "general", page_title: "Request a Service", page_description: tagline || "Tell us what you need and we will follow up.", submit_label: "Submit Request", fields: [] });
  } else {
    // Do not let a customer turn an existing paid business into a different slug/name via a checkout retry.
    const { data: member } = await db.from("business_users").select("role").eq("business_id", businessId).eq("user_id", auth.user.id).maybeSingle();
    if (!member || member.role !== "owner") return reply(403, { error: "Business owner access is required." });
    const { data: sub } = await db.from("gatebrook_subscriptions").select("status,stripe_checkout_session_id,stripe_subscription_id,plan").eq("business_id", businessId).maybeSingle();
    previousCheckoutSessionId = sub?.stripe_checkout_session_id ?? null;
    if (sub && ["active","trialing","past_due"].includes(sub.status)) return reply(409, { error: "A subscription already exists for this workspace. Sign in to continue." });
    if (sub?.status === "incomplete" && sub.stripe_subscription_id)
      return reply(409, { error: "A subscription is already being activated. Check billing before starting another checkout.", next: "billing.html" });
    if (sub?.status === "incomplete" && sub.stripe_checkout_session_id) {
      // Old incomplete sessions must be reconciled before creating a fresh
      // subscription checkout. Do not create another checkout on Stripe errors.
      let prior: Record<string, unknown>;
      try {
        const priorResponse = await fetch(
          "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sub.stripe_checkout_session_id),
          { headers: { Authorization: "Bearer " + STRIPE_KEY } }
        );
        if (!priorResponse.ok) return reply(503, { error: "Could not verify the previous checkout. Please try again." });
        prior = await priorResponse.json();
      } catch {
        return reply(503, { error: "Could not contact Stripe to verify the previous checkout. Please try again." });
      }
      if (prior.status === "complete") return reply(409, {
        error: "Your previous checkout was completed. Please check billing status instead of starting another subscription.",
        next: "billing.html"
      });
      if (prior.status === "open") {
        const metadata = prior.metadata as Record<string, unknown> | null;
        if (prior.livemode !== true ||
            prior.id !== sub.stripe_checkout_session_id ||
            prior.mode !== "subscription" ||
            prior.payment_status === "paid" ||
            Boolean(prior.subscription) ||
            metadata?.business_id !== businessId ||
            metadata?.user_id !== auth.user.id ||
            prior.client_reference_id !== auth.user.id) {
          return reply(409, { error: "Your existing Stripe checkout needs review before it can be replaced. Please contact support." });
        }
        if (metadata?.checkout_option === plan &&
            prior.ui_mode === "hosted" && typeof prior.url === "string") {
          return reply(200, { url: prior.url });
        }
        // The customer explicitly chose a different plan or switched from
        // embedded to hosted Checkout. Expire ONLY the verified unpaid session.
        let expired: Record<string, unknown>;
        try {
          const expiry = await fetch(
            "https://api.stripe.com/v1/checkout/sessions/" +
              encodeURIComponent(sub.stripe_checkout_session_id) + "/expire",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + STRIPE_KEY,
                "Idempotency-Key": "gatebrook-replace-hosted-" + auth.user.id + "-" + sub.stripe_checkout_session_id
              }
            }
          );
          if (!expiry.ok) return reply(409, {
            error: "The previous checkout could not be closed safely. Refresh and try again."
          });
          expired = await expiry.json();
        } catch {
          return reply(503, { error: "We could not confirm the old checkout was closed. Refresh and try again." });
        }
        if (expired.id !== sub.stripe_checkout_session_id || expired.status !== "expired")
          return reply(409, { error: "The previous checkout is still active. Refresh and try again." });
      } else if (prior.status !== "expired") {
        return reply(409, { error: "Your previous checkout is in an unexpected state. Please contact support." });
      }
    }
    const { error: updateError } = await db.from("businesses").update({ name, slug, industry, owner_email: auth.user.email ?? null, active: false }).eq("id", businessId);
    if (updateError) return reply(409, { error: "Could not update this setup. Check whether the public link is available." });
    await db.from("business_public_profiles").upsert({ business_id: businessId, slug, display_name: name, industry, tagline: tagline || null, active: false });
  }
  const price = plan === "annual" ? ANNUAL_PRICE : MONTHLY_PRICE;
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("success_url", SITE + "/billing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", SITE + "/onboarding.html?checkout=cancelled");
  form.set("client_reference_id", auth.user.id);
  form.set("customer_email", auth.user.email ?? "");
  form.set("line_items[0][price]", price);
  form.set("line_items[0][quantity]", "1");
  form.set("metadata[business_id]", businessId);
  form.set("metadata[user_id]", auth.user.id);
  form.set("metadata[plan]", plan === "trial" ? "monthly" : plan);
  form.set("metadata[checkout_option]", plan);
  form.set("subscription_data[metadata][business_id]", businessId);
  form.set("subscription_data[metadata][user_id]", auth.user.id);
  form.set("subscription_data[metadata][plan]", plan === "trial" ? "monthly" : plan);
  form.set("subscription_data[metadata][checkout_option]", plan);
  if (plan === "trial") {
    form.set("subscription_data[trial_period_days]", "7");
    form.set("payment_method_collection", "always");
    form.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel");
  }
  const retryKey = (previousCheckoutSessionId ? previousCheckoutSessionId : "initial") + "-" + plan;
  const headers: Record<string, string> = { "Authorization": "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": "gatebrook-" + auth.user.id + "-" + businessId + "-" + retryKey };
  let session: Record<string, unknown>;
  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers, body: form });
    session = await response.json();
    if (!response.ok || typeof session.url !== "string") throw new Error("Stripe Checkout creation failed");
  } catch {
    return reply(503, { error: "Secure checkout could not be started. No payment was taken. Please retry." });
  }
  const { error: subError } = await db.from("gatebrook_subscriptions").upsert({
    business_id: businessId, user_id: auth.user.id, plan: plan === "trial" ? "monthly" : plan,
    status: "incomplete", stripe_checkout_session_id: session.id, updated_at: new Date().toISOString()
  }, { onConflict: "business_id" });
  if (subError) return reply(503, { error: "Checkout was created but setup could not be saved. Contact support before retrying." });
  return reply(200, { url: session.url });
});