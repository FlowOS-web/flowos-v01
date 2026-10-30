// Link adaptation applies ONLY to QA preview messages.
// Real Gatebrook subscriber notices keep the live /billing.html URL.
export const QA_DASHBOARD_URL = "https://gatebrook.work/qa-dashboard.html";
export const LIVE_BILLING_URL = "https://gatebrook.work/billing.html";
export type PreviewMessage = { subject:string; html:string; text:string };

export function prepareBillingPreview(sample: PreviewMessage): PreviewMessage {
  const banner =
    "TEST PREVIEW — This is not a real billing notice. All buttons and billing links in this example open the Gatebrook QA dashboard, not live billing. No subscription or charge was changed.";
  const qaHtml = sample.html.replaceAll(LIVE_BILLING_URL, QA_DASHBOARD_URL);
  const qaText = sample.text.replaceAll(LIVE_BILLING_URL, QA_DASHBOARD_URL);
  const opening = '<table role="presentation" width="100%"';
  const htmlBanner = '<div style="background:#285a3a;color:#fff;text-align:center;padding:16px 18px;font:700 13px/1.6 Arial,sans-serif">' +
    banner + '</div>';
  return {
    subject: "[Gatebrook QA test] " + sample.subject,
    html: qaHtml.replace(opening,htmlBanner+opening),
    text: banner + "\n\n" + qaText
  };
}
