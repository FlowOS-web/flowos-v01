/* Gatebrook QA: isolated Stripe sandbox checkout. No live payment actions. */
(()=>{
  "use strict";
  const SUPABASE_URL="https://mxyikhxpzijrdrgowmxr.supabase.co";
  const SUPABASE_PUBLIC="sb_publishable_U-8BQS5nOCZtDLiss5CRxg_s9ioHW09";
  const client=window.supabase?.createClient(SUPABASE_URL,SUPABASE_PUBLIC);
  const $=id=>document.getElementById(id);
  const selection=[...document.querySelectorAll("[data-qa-plan]")];
  let plan="trial",busy=false,embeddedCheckout=null,checkedUser=null;
  const params=new URLSearchParams(location.search);
  const returning=params.get("checkout")==="success";
  function show(id,value){$(id).hidden=!value}
  function note(message,kind="neutral") {
    $("qaNotice").textContent=message;
    $("qaNotice").dataset.kind=kind;
    show("qaNotice",!!message);
  }
  function choose(value) {
    if(busy||embeddedCheckout)return;
    plan=value;
    selection.forEach(button=>{
      const selected=button.dataset.qaPlan===value;
      button.setAttribute("aria-pressed",String(selected));
      button.classList.toggle("selected",selected);
    });
    $("qaSubmit").textContent=value==="trial"?"Start free test trial":value==="annual"?"Open annual test checkout":"Open monthly test checkout";
  }
  async function getError(error){
    try{const details=await error?.context?.json();return details?.error||error?.message||"Unknown QA error"}catch{return error?.message||"Unable to reach QA service."}
  }
  async function fetchStatus(){
    if(!client)throw Error("The account service is unavailable.");
    const {data:{user},error:authError}=await client.auth.getUser();
    checkedUser=user;
    show("qaAuth",!user);
    if(!user) {
      show("qaSelect",false);show("qaVerified",false);
      note("Sign in with your approved Gatebrook test account to continue.","neutral");
      return;
    }
    if(authError)throw authError;
    const {data,error}=await client.functions.invoke("gatebrook-qa-status",{method:"GET"});
    if(error)throw Error(await getError(error));
    if(data?.sandbox!==true)throw Error("The QA status service returned an unexpected environment.");
    $("qaAccount").textContent=data.account_email||user.email||"Signed-in tester";
    show("qaAccountLine",true);
    if(data.allowed){
      show("qaSelect",false);show("qaAuth",false);show("qaVerified",true);
      show("qaPaymentContainer",false);
      $("qaStatusValue").textContent=data.status==="trialing"?"Trial active":"Sandbox subscription active";
      $("qaStatusPlan").textContent=data.plan==="annual"?"Annual":data.plan==="trial"?"7-day trial":"Monthly";
      $("qaWorkspaceName").textContent=data.workspace_name||"QA Workspace";
      const date=data.status==="trialing"?data.trial_end:data.current_period_end;
      $("qaStatusUntil").textContent=date?new Date(date).toLocaleString():"Not available";
      note("Stripe's verified sandbox subscription has activated QA access. Your live Gatebrook dashboard is unchanged.","success");
    }else{
      show("qaSelect",true);show("qaVerified",false);
      if(returning)note("Checkout returned, but QA access has not yet been confirmed by the signed sandbox webhook. Select Check status after webhook setup.","warn");
      else if(data.status==="incomplete")note("A test checkout is incomplete. You can reopen the same plan, if the session is still active.","neutral");
      else note("Test mode only. Payments here are simulated; no live card is charged.","neutral");
    }
  }
  async function start(){
    if(busy||embeddedCheckout)return;
    busy=true;
    $("qaSubmit").disabled=true;
    selection.forEach(x=>x.disabled=true);
    try{
      if(!client)throw Error("Authentication service is unavailable.");
      const {data:{user},error:userError}=await client.auth.getUser();
      if(userError||!user)throw Error("Sign in before starting the sandbox checkout.");
      if(typeof window.Stripe!=="function")throw Error("Stripe.js did not load. Refresh and try again.");
      note("Creating a Stripe QA checkout session…","neutral");
      const business_name=$("qaBusinessName").value.trim();
      if(business_name.length<2)throw Error("Enter a business name for the QA workspace.");
      const {data,error}=await client.functions.invoke("gatebrook-qa-checkout",{body:{plan,business_name}});
      if(error)throw Error(await getError(error));
      if(data?.mode!=="embedded"||typeof data?.client_secret!=="string"||
         typeof data?.publishable_key!=="string"||
         !data.publishable_key.startsWith("pk_test_"))throw Error("Sandbox configuration invalid. No payment was attempted.");
      embeddedCheckout=await window.Stripe(data.publishable_key).initEmbeddedCheckout({
        clientSecret:data.client_secret
      });
      show("qaPaymentContainer",true);
      embeddedCheckout.mount("#qaStripeMount");
      note("Secure test payment form is ready. Use only Stripe's test card number shown below.","success");
      $("qaPaymentContainer").scrollIntoView({behavior:"smooth",block:"start"});
    }catch(err){
      note(err?.message||"The QA checkout could not start.","error");
      busy=false;$("qaSubmit").disabled=false;
      selection.forEach(x=>x.disabled=false);
    }
  }
  selection.forEach(button=>button.addEventListener("click",()=>choose(button.dataset.qaPlan)));
  $("qaSubmit").addEventListener("click",start);
  $("qaRefresh").addEventListener("click",()=>fetchStatus().catch(err=>note(err.message,"error")));
  choose("trial");
  fetchStatus().catch(err=>note(err.message||"Unable to load QA status.","error"));
})();
