/* Gatebrook embedded payment form. Stripe owns all card-entry fields. */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const publicKey = "sb_publishable_U-8BQS5nOCZtDLiss5CRxg_s9ioHW09";
  const url = "https://mxyikhxpzijrdrgowmxr.supabase.co";
  const client = window.supabase?.createClient(url, publicKey);
  const info = window.GatebrookCheckoutSummary;
  const details = info?.getIntent() || null;
  let busy = false;
  let allowHostedFallback = false;
  let checkout = null;

  function visible(id, value) { $(id).hidden = !value; }
  function status(message) {
    visible("gbCheckoutLoading", true);
    visible("gbCheckoutError", false);
    visible("gbEmbeddedMount", false);
    $("gbCheckoutLoadingText").textContent = message;
  }
  function failure(title, message, canFallback = false) {
    visible("gbCheckoutLoading", false);
    visible("gbCheckoutError", true);
    visible("gbEmbeddedMount", false);
    $("gbCheckoutErrorTitle").textContent = title;
    $("gbCheckoutErrorText").textContent = message;
    allowHostedFallback = canFallback;
    visible("gbCheckoutUseHosted", canFallback);
  }
  async function readFailure(error) {
    let info = {};
    try { info = await error?.context?.json(); } catch { /* No JSON details. */ }
    return { code:info?.code || "", message:info?.error || error?.message || "Please try again." };
  }
  async function requireSession() {
    if (!client) throw Error("The account service could not load.");
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) throw Error("Please sign in to continue.");
  }
  function openHosted(link) {
    const parsed = new URL(link);
    if (parsed.protocol !== "https:" || parsed.hostname !== "checkout.stripe.com") throw Error("Invalid checkout link.");
    location.assign(parsed.href);
  }
  async function hostedFallback() {
    if (busy || !allowHostedFallback || !details) return;
    busy = true;
    $("gbCheckoutUseHosted").disabled = true;
    status("Opening secure checkout…");
    try {
      await requireSession();
      const { data, error } = await client.functions.invoke("gatebrook-checkout", { body:details });
      if (error) throw Error((await readFailure(error)).message);
      if (data?.error) throw Error(data.error);
      openHosted(data.url);
    } catch (e) {
      failure("Couldn't open checkout", e.message || "Please try again.", true);
    } finally {
      $("gbCheckoutUseHosted").disabled = false;
      busy = false;
    }
  }
  async function start() {
    if (busy) return;
    busy = true;
    allowHostedFallback = false;
    visible("gbCheckoutNotice", false);
    status("Preparing your secure payment form…");
    try {
      if (!details) throw Error("Return to business setup to choose your plan.");
      await requireSession();
      if (typeof window.Stripe !== "function") {
        failure("Embedded payment form unavailable", "Your browser couldn't load Stripe's payment form. You can use the existing secure checkout.", true);
        return;
      }
      const { data, error } = await client.functions.invoke("gatebrook-embedded-checkout", { body:details });
      if (error) {
        const reason = await readFailure(error);
        if (reason.code === "embedded_unavailable") {
          failure("Secure checkout is available", "The in-page form needs one final Stripe setting. You can continue through the current checkout.", true);
          return;
        }
        throw Error(reason.message);
      }
      if (data?.mode === "hosted") {
        openHosted(data.url);
        return;
      }
      if (data?.mode !== "embedded" || typeof data.client_secret !== "string" || !/^pk_(?:live|test)_/.test(data.publishable_key)) {
        throw Error("Stripe did not return an embedded payment session.");
      }
      checkout = await window.Stripe(data.publishable_key).initEmbeddedCheckout({ clientSecret:data.client_secret });
      visible("gbCheckoutLoading", false);
      visible("gbCheckoutError", false);
      visible("gbEmbeddedMount", true);
      checkout.mount("#gbEmbeddedMount");
    } catch (e) {
      failure("Unable to load payment details", e.message || "Please try again shortly.");
    } finally { busy = false; }
  }

  $("gbCheckoutRetry").addEventListener("click", start);
  $("gbCheckoutUseHosted").addEventListener("click", hostedFallback);
  if (details) {
    info.render(details);
    start();
  } else {
    failure("Finish business setup first", "Choose your business details and subscription plan before continuing.");
  }
})();