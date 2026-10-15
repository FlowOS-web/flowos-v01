import { withSupabase } from "npm:@supabase/server@1";

const RESEND_API_KEY =
  Deno.env.get("RESEND_API_KEY");

const FROM_EMAIL =
  Deno.env.get("FROM_EMAIL") ||
  "FlowOS <onboarding@resend.dev>";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",

  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",

  "Access-Control-Allow-Methods":
    "POST, OPTIONS",
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanText(
  value: unknown,
  maxLength = 500
) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(
    value
  );
}

async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {

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
          from: FROM_EMAIL,
          to: [to],
          subject,
          html,
        }),
      }
    );


  const body =
    await response.text();


  if (!response.ok) {

    console.error(
      "Resend error:",
      response.status,
      body
    );


    throw new Error(
      `Email failed with status ${response.status}`
    );

  }


  return body;
}


const handler =
  withSupabase(
    {
      auth: "publishable"
    },

    async (
      req,
      ctx
    ) => {

      if (
        req.method !== "POST"
      ) {

        return Response.json(
          {
            error:
              "Method not allowed."
          },
          {
            status: 405,
            headers:
              corsHeaders
          }
        );

      }


      if (
        !RESEND_API_KEY
      ) {

        return Response.json(
          {
            error:
              "RESEND_API_KEY is not configured."
          },
          {
            status: 500,
            headers:
              corsHeaders
          }
        );

      }


      let body;

      try {

        body =
          await req.json();

      }

      catch {

        return Response.json(
          {
            error:
              "Invalid JSON body."
          },
          {
            status: 400,
            headers:
              corsHeaders
          }
        );

      }


      /*
      ==========================================
      CLEAN + VALIDATE LEAD
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

      const serviceLocation =
        cleanText(
          body.service_location,
          300
        );

      const preferredDate =
        cleanText(
          body.preferred_date,
          50
        );

      const notes =
        cleanText(
          body.notes,
          2000
        );

      const vehicle =
        cleanText(
          body.vehicle,
          200
        );

      const vehicleType =
        cleanText(
          body.vehicle_type,
          120
        );


      if (
        !businessId ||
        !customerName ||
        !service
      ) {

        return Response.json(
          {
            error:
              "Missing required lead information."
          },
          {
            status: 400,
            headers:
              corsHeaders
          }
        );

      }


      /*
      ==========================================
      LOOK UP BUSINESS SECURELY
      ==========================================
      */

      const {
        data: business,
        error: businessError
      } =
        await ctx.supabaseAdmin

          .from("businesses")

          .select(
            `
            id,
            name,
            owner_email,
            industry,
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


      if (businessError) {

        console.error(
          "Business lookup error:",
          businessError
        );


        return Response.json(
          {
            error:
              "Business lookup failed."
          },
          {
            status: 500,
            headers:
              corsHeaders
          }
        );

      }


      if (!business) {

        return Response.json(
          {
            error:
              "Business not found or inactive."
          },
          {
            status: 404,
            headers:
              corsHeaders
          }
        );

      }


      if (
        !business.owner_email ||
        !looksLikeEmail(
          business.owner_email
        )
      ) {

        return Response.json(
          {
            error:
              "Business notification email is not configured."
          },
          {
            status: 422,
            headers:
              corsHeaders
          }
        );

      }


      const businessName =
        cleanText(
          business.name,
          200
        );


      /*
      ==========================================
      OWNER EMAIL
      ==========================================
      */

      const ownerHtml = `
        <div style="
          font-family:
            Arial,
            sans-serif;
          max-width:
            620px;
          margin:
            0 auto;
          line-height:
            1.55;
          color:
            #171717;
        ">

          <h2 style="
            margin-bottom:
              5px;
          ">
            New FlowOS Lead
          </h2>

          <p style="
            color:
              #666;
            margin-top:
              0;
          ">
            ${escapeHtml(
              businessName
            )}
          </p>

          <hr style="
            border:
              0;
            border-top:
              1px solid #ddd;
            margin:
              22px 0;
          ">


          <p>
            <strong>
              Customer
            </strong><br>

            ${escapeHtml(
              customerName
            )}
          </p>


          <p>
            <strong>
              Phone
            </strong><br>

            ${escapeHtml(
              phone ||
              "Not provided"
            )}
          </p>


          <p>
            <strong>
              Email
            </strong><br>

            ${escapeHtml(
              customerEmail ||
              "Not provided"
            )}
          </p>


          <p>
            <strong>
              Service
            </strong><br>

            ${escapeHtml(
              service
            )}
          </p>


          <p>
            <strong>
              Preferred Date
            </strong><br>

            ${escapeHtml(
              preferredDate ||
              "Not provided"
            )}
          </p>


          <p>
            <strong>
              Service Location
            </strong><br>

            ${escapeHtml(
              serviceLocation ||
              "Not provided"
            )}
          </p>


          ${
            vehicle
              ?
              `
              <p>
                <strong>
                  Vehicle
                </strong><br>

                ${escapeHtml(
                  vehicle
                )}

                ${
                  vehicleType
                    ?
                    ` — ${escapeHtml(
                      vehicleType
                    )}`
                    :
                    ""
                }
              </p>
              `
              :
              ""
          }


          <p>
            <strong>
              Notes
            </strong><br>

            ${escapeHtml(
              notes ||
              "None"
            )}
          </p>


          <hr style="
            border:
              0;
            border-top:
              1px solid #ddd;
            margin:
              22px 0;
          ">


          <p style="
            font-size:
              12px;
            color:
              #777;
          ">
            This lead was captured
            automatically by FlowOS.
          </p>

        </div>
      `;


      try {

        await sendEmail({

          to:
            business.owner_email,

          subject:
            `New Lead: ${customerName} — ${service}`,

          html:
            ownerHtml,

        });

      }

      catch(error) {

        console.error(
          "Owner email failed:",
          error
        );


        return Response.json(
          {
            error:
              "Owner notification failed."
          },
          {
            status: 502,
            headers:
              corsHeaders
          }
        );

      }


      /*
      ==========================================
      CUSTOMER CONFIRMATION
      ==========================================

      The customer cannot choose
      arbitrary message content.
      The email template is controlled
      entirely by FlowOS.
      */

      let customerConfirmationSent =
        false;


      if (
        customerEmail &&
        looksLikeEmail(
          customerEmail
        )
      ) {

        const customerHtml = `
          <div style="
            font-family:
              Arial,
              sans-serif;
            max-width:
              620px;
            margin:
              0 auto;
            line-height:
              1.55;
            color:
              #171717;
          ">

            <h2>
              Request Received
            </h2>

            <p>
              Hi ${escapeHtml(
                customerName
              )},
            </p>


            <p>
              ${escapeHtml(
                businessName
              )} received your
              service request.
            </p>


            <p>
              <strong>
                Service:
              </strong>

              ${escapeHtml(
                service
              )}
            </p>


            ${
              preferredDate
                ?
                `
                <p>
                  <strong>
                    Preferred date:
                  </strong>

                  ${escapeHtml(
                    preferredDate
                  )}
                </p>
                `
                :
                ""
            }


            <p>
              The business will
              follow up with you
              to confirm the details.
            </p>


            <p style="
              font-size:
                12px;
              color:
                #777;
              margin-top:
                28px;
            ">
              Powered by FlowOS
            </p>

          </div>
        `;


        try {

          await sendEmail({

            to:
              customerEmail,

            subject:
              `We received your request — ${businessName}`,

            html:
              customerHtml,

          });


          customerConfirmationSent =
            true;

        }

        catch(error) {

          /*
          IMPORTANT:
          Owner already received
          the lead, so do not fail
          the whole request.
          */

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

          owner_notification_sent:
            true,

          customer_confirmation_sent:
            customerConfirmationSent,

          business:
            businessName,
        },
        {
          status: 200,
          headers:
            corsHeaders
        }
      );

    }
  );


export default {

  async fetch(
    req: Request
  ) {

    /*
    ==========================================
    CORS PREFLIGHT
    ==========================================
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
    Run Supabase publishable-key
    authentication.
    */

    // Current request pages send notifications inside submit-lead after
    // Turnstile validation. This older standalone endpoint is server-only.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const provided = req.headers.get("authorization") || "";
    const expected = serviceKey ? "Bearer " + serviceKey : "";
    const encoder = new TextEncoder();
    const [actualHash, expectedHash] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(provided)),
      crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    let mismatch = 0;
    const actualBytes = new Uint8Array(actualHash);
    const expectedBytes = new Uint8Array(expectedHash);
    for (let i = 0; i < actualBytes.length; i++) mismatch |= actualBytes[i] ^ expectedBytes[i];
    if (!serviceKey || mismatch !== 0) {
      return Response.json({ error: "Server authorization required." }, { status: 403, headers: corsHeaders });
    }

    const response =
      await handler(req);


    /*
    Ensure every response includes
    browser CORS headers.
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

        headers
      }
    );

  }

};
