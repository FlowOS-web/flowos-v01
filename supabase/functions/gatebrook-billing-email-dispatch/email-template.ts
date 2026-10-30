// All dynamic account data is escaped before inserting it into HTML.
export type BillingEmailKind =
  "trial_welcome" | "trial_3_day" | "trial_1_day" |
  "trial_converted" | "trial_expired" | "reactivated";
export type BillingEmailDetails = {
  businessName:string; trialEnd:string|null; plan:"monthly"|"annual";
};
const SITE = "https://gatebrook.work";
const BILLING = SITE + "/billing.html";
const escapeHtml=(v:unknown)=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;")
  .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
const date=(iso:string|null)=>iso ?
  new Intl.DateTimeFormat("en-US",{dateStyle:"long",timeStyle:"short",timeZone:"UTC"}).format(new Date(iso))+" UTC" :
  "the date in your Billing page";
export function renderBillingEmail(kind:BillingEmailKind, d:BillingEmailDetails) {
  const end=date(d.trialEnd);
  const price=d.plan==="annual"?"$1,490/year":"$149/month";
  let eyebrow="", title="", subject="", description="", message="",button="";
  let fields:Array<[string,string]>=[];
  switch(kind){
    case "trial_welcome":
      eyebrow="YOUR FREE TRIAL IS ACTIVE";title="Welcome to Gatebrook.";
      subject="Your Gatebrook 7-day trial is active";
      description="Your seven-day trial for "+d.businessName+" has begun. Explore your dashboard and customize your request page.";
      fields=[["Trial ends",end],["After your trial",price]];
      message="Your payment method is stored with Stripe. Unless you cancel before the trial ends, your subscription will automatically renew at the rate shown, plus applicable tax. You can manage or cancel your plan from Billing.";
      button="Review billing";break;
    case "trial_3_day":
      eyebrow="TRIAL REMINDER";title="3 days left in your trial.";
      subject="Your Gatebrook trial ends in 3 days";
      description="Your Gatebrook trial for "+d.businessName+" is approaching its end. Billing is scheduled to begin automatically afterward.";
      fields=[["Trial ends",end],["Next subscription",price]];
      message="If you want to continue, no action is needed. To avoid the upcoming charge, cancel before your trial ends using the Billing page.";
      button="Manage your subscription";break;
    case "trial_1_day":
      eyebrow="FINAL TRIAL REMINDER";title="Your trial ends tomorrow.";
      subject="Reminder: your Gatebrook trial ends in 1 day";
      description="Your Gatebrook trial for "+d.businessName+" ends soon. Stripe will use your saved payment method when the subscription begins.";
      fields=[["Trial ends",end],["Upcoming recurring rate",price]];
      message="No action is needed to continue. To prevent the first charge, cancel before the trial ends from your Billing page.";
      button="View billing and cancellation";break;
    case "trial_converted":
      eyebrow="SUBSCRIPTION ACTIVE";title="Your subscription is active.";
      subject="Your Gatebrook trial ended — subscription active";
      description="Your trial for "+d.businessName+" is complete, and your paid subscription is now active.";
      fields=[["Plan",price],["Workspace",d.businessName]];
      message="View payment history and manage your plan from your Billing page.";
      button="Open Gatebrook";break;
    case "trial_expired":
      eyebrow="ACCESS UPDATE";title="Your workspace access has ended.";
      subject="Your Gatebrook access has ended";
      description="The subscription for "+d.businessName+" is no longer active.";
      fields=[["Workspace",d.businessName],["Current access","Inactive"]];
      message="Your existing workspace data is retained, but paid features and new requests are restricted. You can reactivate from Billing to restore access.";
      button="Reactivate Gatebrook";break;
    case "reactivated":
      eyebrow="WELCOME BACK";title="Gatebrook is active again.";
      subject="Your Gatebrook subscription has been reactivated";
      description="Your subscription for "+d.businessName+" has been reactivated.";
      fields=[["Workspace",d.businessName],["Plan",price]];
      message="You can return to your dashboard and resume using Gatebrook. Manage your plan from Billing at any time.";
      button="Open your dashboard";break;
  }
  const rows=fields.map(([key,value])=>
    '<tr><td style="padding:12px 18px;border-bottom:1px solid #374940;color:#9fb3a5;font:600 11px Arial,sans-serif;text-transform:uppercase">'+escapeHtml(key)+'</td>'+
    '<td style="padding:12px 18px;border-bottom:1px solid #374940;color:#f4f9f4;font:600 14px Arial,sans-serif">'+escapeHtml(value)+'</td></tr>'
  ).join("");
  const html=[
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>',escapeHtml(subject),'</title></head><body style="margin:0;background:#0b100d;color:#f1f5ef">',
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">',escapeHtml(description),'</div>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b100d"><tr><td align="center" style="padding:36px 16px">',
    '<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px">',
    '<tr><td style="padding:0 0 24px"><strong style="font:800 20px Arial,sans-serif;letter-spacing:3px;color:#f3f8f3">GATEBROOK</strong>',
    '<div style="margin-top:8px;color:#8ebba1;font:600 10px Arial,sans-serif;letter-spacing:2px">SERVICE OPERATIONS, REFINED.</div></td></tr>',
    '<tr><td style="background:#17221b;border:1px solid #365944;border-radius:14px;overflow:hidden">',
    '<div style="height:4px;background:#42845a"></div><div style="padding:32px 28px">',
    '<div style="color:#8dd9a6;font:700 11px Arial,sans-serif;letter-spacing:2px">',escapeHtml(eyebrow),'</div>',
    '<h1 style="color:#f6faf6;font:700 30px/1.17 Arial,sans-serif;letter-spacing:-1px;margin:15px 0 10px">',escapeHtml(title),'</h1>',
    '<p style="color:#c8d8cd;font:400 15px/1.75 Arial,sans-serif;margin:0 0 24px">',escapeHtml(description),'</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #3a5142;border-radius:8px;background:#202d24">',rows,'</table>',
    '<p style="color:#b8cabe;font:400 14px/1.7 Arial,sans-serif;margin:24px 0">',escapeHtml(message),'</p>',
    '<a href="',BILLING,'" style="display:inline-block;padding:14px 21px;border-radius:8px;background:#2a603d;color:white;text-decoration:none;font:700 13px Arial,sans-serif">',escapeHtml(button),' &#8594;</a>',
    '</div></td></tr><tr><td style="padding:20px 2px;color:#9eb2a4;font:12px/1.6 Arial,sans-serif">',
    'Gatebrook / Account &amp; Billing<br>',
    'This is a transactional account notice. You can manage or cancel your subscription in ',
    '<a href="',BILLING,'" style="color:#a6e4b6">Billing</a>.',
    '</td></tr></table></td></tr></table></body></html>'
  ].join("");
  const text=[
    "GATEBROOK / ACCOUNT & BILLING","",subject,"",description,"",
    ...fields.map(([key,value])=>key+": "+value),"",message,"",
    button+": "+BILLING,"","Manage or cancel: "+BILLING
  ].join("\n");
  return {subject,html,text};
}
