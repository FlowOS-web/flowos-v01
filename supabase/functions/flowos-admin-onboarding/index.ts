import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { createHandler, type AdminClient } from "./handler.ts";

// The service role stays inside this Edge Function. Auth verifies the bearer
// token, and restricted RPCs check the administrator and live session.
const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);
Deno.serve(createHandler({ client: client as unknown as AdminClient }));
