/* Gatebrook subscription summary. Display only; Stripe determines final billing. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const KEY = "gatebrook_checkout_intent_v1";

  function getIntent() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (!raw || Date.now() - Number(raw.created_at) > 10800000) return null;
      const payload = {
        business_name:String(raw.business_name || "").trim().slice(0,100),
        industry:String(raw.industry || "").trim().slice(0,120),
        slug:String(raw.slug || "").toLowerCase().trim().slice(0,48),
        tagline:String(raw.tagline || "").trim().slice(0,160),
        plan:raw.plan
      };
      return payload.business_name && payload.industry
        && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.slug)
        && ["trial","monthly","annual"].includes(payload.plan) ? payload : null;
    } catch { return null; }
  }

  function render(intent) {
    if (!intent) return;
    $("gbCheckoutBusiness").textContent = intent.business_name;
    if (intent.plan === "trial") {
      $("gbCheckoutTitle").textContent = "Start your 7-day free trial.";
      $("gbCheckoutIntro").textContent = "Seven days of Gatebrook, on us. Enter your payment information securely to activate your trial.";
      $("gbCheckoutPlanName").textContent = "Gatebrook Monthly";
      $("gbCheckoutPlanRate").textContent = "$149 / month";
      $("gbCheckoutOfferLabel").textContent = "Free trial";
      $("gbCheckoutOfferValue").textContent = "7 days";
      $("gbCheckoutDueToday").textContent = "$0.00";
      $("gbCheckoutBillingTerms").textContent =
        "A payment method is required today. Your free trial starts after checkout. Unless you cancel before the trial ends, you'll be charged $149/month starting after seven days.";
    } else if (intent.plan === "annual") {
      $("gbCheckoutTitle").textContent = "Your Gatebrook workspace.";
      $("gbCheckoutIntro").textContent = "One annual plan for your customer requests and follow-ups.";
      $("gbCheckoutPlanName").textContent = "Gatebrook Annual";
      $("gbCheckoutPlanRate").textContent = "$1,490 / year";
      $("gbCheckoutOfferLabel").textContent = "Annual savings";
      $("gbCheckoutOfferValue").textContent = "Save $298";
      $("gbCheckoutDueToday").textContent = "$1,490.00";
      $("gbCheckoutBillingTerms").textContent = "$1,490 is due today, then every year unless canceled. Access continues through your paid period if you cancel.";
    } else {
      $("gbCheckoutTitle").textContent = "Your Gatebrook workspace.";
      $("gbCheckoutIntro").textContent = "One simple workspace for customer requests and follow-ups.";
      $("gbCheckoutPlanName").textContent = "Gatebrook Monthly";
      $("gbCheckoutPlanRate").textContent = "$149 / month";
      $("gbCheckoutOfferLabel").textContent = "Billing schedule";
      $("gbCheckoutOfferValue").textContent = "Monthly";
      $("gbCheckoutDueToday").textContent = "$149.00";
      $("gbCheckoutBillingTerms").textContent = "$149 is due today, then each month unless canceled. Access continues through your paid period if you cancel.";
    }
  }
  window.GatebrookCheckoutSummary = {getIntent, render};
})();