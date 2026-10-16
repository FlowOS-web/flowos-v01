/* Gatebrook transactional email presentation.
   All dynamic content is HTML-escaped; no external images, fonts or trackers. */
export type BrandedEmailField = { label: string; value: string };
export type BrandedEmailSpec = {
  eyebrow: string;
  title: string;
  businessName: string;
  description: string;
  preheader: string;
  fields: BrandedEmailField[];
  message: string;
  action?: { label: string; url: string };
};
function escapeEmailHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
export function renderBrandedEmail(spec: BrandedEmailSpec): string {
  const rows = spec.fields.map(field => {
    const value = escapeEmailHtml(field.value).replace(/\r\n|\r|\n/g, "<br>");
    return [
      '<tr>',
      '<td valign="top" width="34%" style="padding:15px 14px 15px 20px;border-bottom:1px solid #323b38;color:#abb8b1;font:600 11px/1.5 Arial,Helvetica,sans-serif;letter-spacing:1px;text-transform:uppercase;">',
      escapeEmailHtml(field.label),
      '</td>',
      '<td valign="top" style="padding:15px 20px 15px 8px;border-bottom:1px solid #323b38;color:#f5f5f2;font:500 15px/1.6 Arial,Helvetica,sans-serif;overflow-wrap:anywhere;word-break:break-word;">',
      value,
      '</td></tr>'
    ].join("");
  }).join("");

  const button = spec.action ? [
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:27px"><tr>',
    '<td bgcolor="#244633" style="background:#244633;border:1px solid #5b8469;border-radius:7px;">',
    '<a href="', escapeEmailHtml(spec.action.url),
    '" style="display:inline-block;padding:15px 22px;color:#f5f5f2;text-decoration:none;font:700 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:1px;">',
    escapeEmailHtml(spec.action.label),
    ' &#8594;</a></td></tr></table>'
  ].join("") : "";

  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<title>', escapeEmailHtml(spec.title), '</title></head>',
    '<body style="margin:0;padding:0;background-color:#090b0b;color:#f5f5f2;">',
    '<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;max-height:0;overflow:hidden;">',
    escapeEmailHtml(spec.preheader), '</div>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#090b0b" style="width:100%;background:#090b0b;">',
    '<tr><td align="center" style="padding:38px 16px 42px;">',
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">',
    '<tr><td style="padding:0 2px 22px;">',
    '<span style="color:#f5f5f2;font:700 19px/1.3 Arial,Helvetica,sans-serif;letter-spacing:4px;">GATEBROOK</span>',
    '<span style="display:block;padding-top:9px;color:#a9b9ae;font:600 10px/1.4 Arial,Helvetica,sans-serif;letter-spacing:2px;">SERVICE OPERATIONS, REFINED.</span>',
    '</td></tr>',
    '<tr><td bgcolor="#192021" style="background:#192021;border:1px solid #3a4540;border-radius:12px;overflow:hidden;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">',
    '<tr><td height="3" bgcolor="#336a4b" style="font-size:0;line-height:0;background:#336a4b;height:3px;">&nbsp;</td></tr>',
    '<tr><td style="padding:35px 28px 25px;">',
    '<div style="color:#8fbd9e;font:700 11px/1.5 Arial,Helvetica,sans-serif;letter-spacing:2px;text-transform:uppercase;">',
    escapeEmailHtml(spec.eyebrow), '</div>',
    '<h1 style="margin:16px 0 14px;color:#f5f5f2;font:600 34px/1.12 Arial,Helvetica,sans-serif;letter-spacing:-1px;">',
    escapeEmailHtml(spec.title), '</h1>',
    '<div style="color:#d0dcd3;font:600 15px/1.5 Arial,Helvetica,sans-serif;">',
    escapeEmailHtml(spec.businessName), '</div>',
    '<p style="margin:18px 0 0;color:#b6c2b9;font:400 15px/1.7 Arial,Helvetica,sans-serif;">',
    escapeEmailHtml(spec.description), '</p>',
    '</td></tr>',
    '<tr><td style="padding:0 28px 0;">',
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="#222a29" style="background:#222a29;border:1px solid #3b4640;border-radius:8px;">',
    rows,
    '</table></td></tr>',
    '<tr><td style="padding:23px 28px 34px;">',
    '<p style="margin:0;color:#b6c2b9;font:400 14px/1.75 Arial,Helvetica,sans-serif;">',
    escapeEmailHtml(spec.message), '</p>',
    button,
    '</td></tr></table></td></tr>',
    '<tr><td style="padding:22px 2px 0;border-top:1px solid #2c3933;">',
    '<p style="margin:0;color:#abb8b0;font:400 11px/1.65 Arial,Helvetica,sans-serif;">',
    'GATEBROOK &nbsp;/&nbsp; CUSTOMER REQUESTS<br>',
    'This is an automated message. Please contact the business directly if you need to update your request.',
    '</p></td></tr>',
    '</table></td></tr></table></body></html>'
  ].join("");
}
export function renderBrandedEmailText(spec: BrandedEmailSpec): string {
  const lines = [
    "GATEBROOK / CUSTOMER REQUESTS", "",
    spec.title, spec.businessName, "",
    spec.description, ""
  ];
  for (const field of spec.fields) {
    lines.push(field.label + ": " + field.value);
  }
  lines.push("", spec.message);
  if (spec.action) lines.push("", spec.action.label + ": " + spec.action.url);
  lines.push("", "Powered by Gatebrook.");
  return lines.join("\n");
}
