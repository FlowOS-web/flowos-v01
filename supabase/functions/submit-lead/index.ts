import { withSupabase } from "npm:@supabase/server@1";
import { renderBrandedEmail, renderBrandedEmailText, type BrandedEmailSpec } from "./email-brand.ts";


/*
==================================================
SECRETS / CONFIG
==================================================
*/

const TURNSTILE_SECRET_KEY =
  Deno.env.get("TURNSTILE_SECRET_KEY");

const RESEND_API_KEY =
  Deno.env.get("RESEND_API_KEY");

const FROM_EMAIL =
  Deno.env.get("FROM_EMAIL") ||
  "Gatebrook <onboarding@resend.dev>";

// Keep existing request links working while the custom domain becomes primary.
const ALLOWED_HOSTNAMES = new Set([
  "flowos-web.github.io",
  "gatebrook.work",
]);


/*
==================================================
CORS
==================================================
*/

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",

  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};


/*
==================================================
HELPERS
==================================================
*/

function cleanText(
  value: unknown,
  maxLength = 500
) {

  return String(value ?? "")
    .trim()
    .slice(0, maxLength);

}


function escapeHtml(value: unknown) {

  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}


function validEmail(value: string) {

  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(
    value
  );

}


function validUuid(value: string) {

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );

}


/*
==================================================
EMAIL SENDER
==================================================
*/

async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) {

  if (!RESEND_API_KEY) {

    throw new Error(
      "RESEND_API_KEY is missing."
    );

  }


  const response =
    await fetch(
      "https://api.resend.com/emails",
      {

        method: "POST",

        headers: {

          "Content-Type":
            "application/json",

          "Authorization":
            `Bearer ${RESEND_API_KEY}`,

        },

        body: JSON.stringify({

          from:
            FROM_EMAIL,

          to: [
            to
          ],

          subject:
            subject,

          html:
            html,
          text: text,

        }),

      }
    );


  const responseText =
    await response.text();


  if (!response.ok) {

    console.error(
      "Resend error:",
      response.status,
      responseText
    );


    throw new Error(
      `Email failed with status ${response.status}`
    );

  }

}


/*
==================================================
MAIN HANDLER
==================================================
*/

const handler =
  withSupabase(
    {
      auth: "none"
    },

    async (
      req,
      ctx
    ) => {

      /*
      ------------------------------------------
      METHOD
      ------------------------------------------
      */

      if (
        req.method !== "POST"
      ) {

        return Response.json(
          {
            error:
              "Method not allowed."
          },
          {
            status: 405
          }
        );

      }


      /*
      ------------------------------------------
      SERVER CONFIG CHECK
      ------------------------------------------
      */

      if (
        !TURNSTILE_SECRET_KEY
      ) {

        console.error(
          "TURNSTILE_SECRET_KEY missing."
        );


        return Response.json(
          {
            error:
              "Server security configuration is unavailable."
          },
          {
            status: 500
          }
        );

      }


      /*
      ------------------------------------------
      READ REQUEST
      ------------------------------------------
      */

      let body;


      try {

        body =
          await req.json();

      }

      catch {

        return Response.json(
          {
            error:
              "Invalid request."
          },
          {
            status: 400
          }
        );

      }


      /*
      ==========================================
      TURNSTILE VALIDATION
      ==========================================
      */

      const turnstileToken =
        cleanText(
          body.turnstile_token,
          2048
        );


      if (
        !turnstileToken
      ) {

        return Response.json(
          {
            error:
              "Please complete the security check."
          },
          {
            status: 400
          }
        );

      }


      const remoteIp =
        req.headers.get(
          "cf-connecting-ip"
        );


      const verifyPayload: Record<
        string,
        string
      > = {

        secret:
          TURNSTILE_SECRET_KEY,

        response:
          turnstileToken,

      };


      if (
        remoteIp
      ) {

        verifyPayload.remoteip =
          remoteIp;

      }


      let turnstileResult;


      try {

        const verificationResponse =
          await fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            {

              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body:
                JSON.stringify(
                  verifyPayload
                ),

            }
          );


        turnstileResult =
          await verificationResponse
            .json();

      }

      catch(error) {

        console.error(
          "Turnstile request failed:",
          error
        );


        return Response.json(
          {
            error:
              "Security verification temporarily failed. Please try again."
          },
          {
            status: 503
          }
        );

      }


      if (
        !turnstileResult.success
      ) {

        console.warn(
          "Turnstile rejected submission:",
          turnstileResult[
            "error-codes"
          ]
        );


        return Response.json(
          {
            error:
              "Security verification failed. Please try again."
          },
          {
            status: 403
          }
        );

      }


      /*
      Accept tokens only from our explicitly trusted site hostnames.
      */

      if (
        !ALLOWED_HOSTNAMES.has(turnstileResult.hostname)
      ) {

        console.warn(
          "Unexpected Turnstile hostname:",
          turnstileResult.hostname
        );


        return Response.json(
          {
            error:
              "Invalid submission origin."
          },
          {
            status: 403
          }
        );

      }


      /*
      ==========================================
      CLEAN LEAD DATA
      ==========================================
      */

      const businessId =
        cleanText(
          body.business_id,
          100
        );


      const customerName =
        cleanText(
          body.customer_name,
          120
        );


      const phone =
        cleanText(
          body.phone,
          50
        );


      const customerEmail =
        cleanText(
          body.email,
          200
        );


      const service =
        cleanText(
          body.service,
          200
        );


      const preferredDate =
        cleanText(
          body.preferred_date,
          30
        );


      const serviceLocation =
        cleanText(
          body.service_location,
          300
        );


      const notes =
        cleanText(
          body.notes,
          2000
        );


      /*
      ==========================================
      VALIDATION
      ==========================================
      */

      if (
        !validUuid(
          businessId
        )
      ) {

        return Response.json(
          {
            error:
              "Invalid business."
          },
          {
            status: 400
          }
        );

      }


      if (
        customerName.length < 2
      ) {

        return Response.json(
          {
            error:
              "Please enter your name."
          },
          {
            status: 400
          }
        );

      }


      if (
        !service
      ) {

        return Response.json(
          {
            error:
              "Please select a service."
          },
          {
            status: 400
          }
        );

      }


      if (
        !phone &&
        !customerEmail
      ) {

        return Response.json(
          {
            error:
              "Please enter a phone number or email."
          },
          {
            status: 400
          }
        );

      }


      if (
        customerEmail &&
        !validEmail(
          customerEmail
        )
      ) {

        return Response.json(
          {
            error:
              "Please enter a valid email address."
          },
          {
            status: 400
          }
        );

      }


      /*
      ==========================================
      BUSINESS LOOKUP
      ==========================================
      */

      const {
        data: business,
        error: businessError
      } =
        await ctx.supabaseAdmin

          .from(
            "businesses"
          )

          .select(
            `
              id,
              name,
              owner_email,
              active
            `
          )

          .eq(
            "id",
            businessId
          )

          .eq(
            "active",
            true
          )

          .maybeSingle();


      if (
        businessError ||
        !business
      ) {

        console.error(
          "Business lookup failed:",
          businessError
        );


        return Response.json(
          {
            error:
              "Business is unavailable."
          },
          {
            status: 404
          }
        );

      }


      /*
      ==========================================
      SERVICE VALIDATION
      ==========================================
      */

      const {
        data: validService,
        error: serviceError
      } =
        await ctx.supabaseAdmin

          .from(
            "business_services"
          )

          .select(
            "id"
          )

          .eq(
            "business_id",
            businessId
          )

          .eq(
            "name",
            service
          )

          .eq(
            "active",
            true
          )

          .maybeSingle();


      if (
        serviceError ||
        !validService
      ) {

        console.error(
          "Service validation failed:",
          serviceError
        );


        return Response.json(
          {
            error:
              "That service is unavailable."
          },
          {
            status: 400
          }
        );

      }


      /*
      ==========================================
      SAVE LEAD
      ==========================================
      */

      const {
        data: savedLead,
        error: insertError
      } =
        await ctx.supabaseAdmin

          .from(
            "leads"
          )

          .insert({

            business_id:
              businessId,

            customer_name:
              customerName,

            phone:
              phone || null,

            email:
              customerEmail || null,

            vehicle:
              null,

            vehicle_type:
              null,

            service:
              service,

            preferred_date:
              preferredDate || null,

            service_location:
              serviceLocation || null,

            notes:
              notes || null,

            status:
              "new",

            source:
              "website",

          })

          .select(
            "id"
          )

          .single();


      if (
        insertError
      ) {

        console.error(
          "Lead insert failed:",
          insertError
        );


        return Response.json(
          {
            error:
              "Your request could not be saved. Please try again."
          },
          {
            status: 500
          }
        );

      }


      /*
      ==========================================
      OWNER NOTIFICATION EMAIL
      ==========================================
      */

      let ownerNotificationSent =
        false;


      if (
        business.owner_email &&
        validEmail(
          business.owner_email
        )
      ) {

        const ownerEmailSpec: BrandedEmailSpec = {
          eyebrow: "NEW CUSTOMER INQUIRY",
          title: "A new request.",
          businessName: business.name,
          description: "A customer has submitted a service request. Review the details below and follow up from your workspace.",
          preheader: "New customer request for " + business.name + ": " + service,
          fields: [
            { label: "Customer", value: customerName },
            { label: "Phone", value: phone || "Not provided" },
            { label: "Email", value: customerEmail || "Not provided" },
            { label: "Service", value: service },
            { label: "Preferred date", value: preferredDate || "Not provided" },
            { label: "Service location", value: serviceLocation || "Not provided" },
            { label: "Notes", value: notes || "None" }
          ],
          message: "This request is saved in Gatebrook. Sign in to manage the customer and track the next steps.",
          action: { label: "OPEN BUSINESS DASHBOARD", url: "https://gatebrook.work/dashboard.html" }
        };
        const ownerHtml = renderBrandedEmail(ownerEmailSpec);
        const ownerText = renderBrandedEmailText(ownerEmailSpec);

        try {

          await sendEmail({

            to:
              business.owner_email,

            subject:
              `New Lead: ${customerName} — ${service}`,

            html:
              ownerHtml,
            text: ownerText,

          });


          ownerNotificationSent =
            true;

        }

        catch(error) {

          /*
          Lead is already saved,
          so email failure does NOT
          destroy the customer request.
          */

          console.error(
            "Owner email failed:",
            error
          );

        }

      }


      /*
      ==========================================
      CUSTOMER CONFIRMATION EMAIL
      ==========================================
      */

      let customerConfirmationSent =
        false;


      if (
        customerEmail &&
        validEmail(
          customerEmail
        )
      ) {

        const customerEmailSpec: BrandedEmailSpec = {
          eyebrow: "REQUEST CONFIRMATION",
          title: "Request received.",
          businessName: business.name,
          description: "Hi " + customerName + ", your request has been delivered to " + business.name + ".",
          preheader: "Your service request was received by " + business.name,
          fields: [
            { label: "Service", value: service },
            ...(preferredDate ? [{ label: "Preferred date", value: preferredDate }] : [])
          ],
          message: "The business will follow up to confirm the details. Your request is not yet a confirmed appointment."
        };
        const customerHtml = renderBrandedEmail(customerEmailSpec);
        const customerText = renderBrandedEmailText(customerEmailSpec);

        try {

          await sendEmail({

            to:
              customerEmail,

            subject:
              `We received your request — ${business.name}`,

            html:
              customerHtml,
            text: customerText,

          });


          customerConfirmationSent =
            true;

        }

        catch(error) {

          console.error(
            "Customer confirmation failed:",
            error
          );

        }

      }


      /*
      ==========================================
      SUCCESS
      ==========================================
      */

      return Response.json(
        {

          success:
            true,

          lead_id:
            savedLead.id,

          owner_notification_sent:
            ownerNotificationSent,

          customer_confirmation_sent:
            customerConfirmationSent,

        },
        {
          status: 200
        }
      );

    }
  );


/*
==================================================
CORS WRAPPER
==================================================
*/

export default {

  async fetch(
    req: Request
  ) {

    /*
    Browser preflight request
    */

    if (
      req.method === "OPTIONS"
    ) {

      return new Response(
        "ok",
        {
          status: 200,
          headers:
            corsHeaders
        }
      );

    }


    /*
    Actual function request
    */

    const response =
      await handler(req);


    /*
    Add CORS headers to
    every response.
    */

    const headers =
      new Headers(
        response.headers
      );


    for (
      const [
        key,
        value
      ]
      of Object.entries(
        corsHeaders
      )
    ) {

      headers.set(
        key,
        value
      );

    }


    return new Response(
      response.body,
      {

        status:
          response.status,

        statusText:
          response.statusText,

        headers:
          headers,

      }
    );

  }

};
