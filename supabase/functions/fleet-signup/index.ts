/**
 * fleet-signup edge function
 *
 * Handles fleet manager registration atomically using the service role key:
 *   1. Creates the auth user (marked as email-confirmed immediately)
 *   2. Creates the fleet record linked to that user
 *   3. Signs in the user and returns the session to the client
 *
 * This avoids the RLS timing problem where a direct client-side signUp()
 * returns a user but no session, causing the subsequent fleet INSERT to run
 * as an unauthenticated request and fail.
 *
 * POST { email, password, fleet_name }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err("Method not allowed", 405);

  let email: string, password: string, fleet_name: string;
  try {
    ({ email, password, fleet_name } = await req.json());
  } catch {
    return err("Invalid JSON body");
  }

  if (!email || !password || !fleet_name) {
    return err("email, password, and fleet_name are required");
  }

  // Service-role client — bypasses RLS for admin operations
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Create the auth user, marking the email as confirmed so they can
  //    sign in immediately without needing an email confirmation link.
  const { data: { user }, error: createError } =
    await adminClient.auth.admin.createUser({
      email:          email.trim().toLowerCase(),
      password,
      email_confirm:  true,
    });

  if (createError) {
    if (createError.message.toLowerCase().includes("already")) {
      return err("An account with this email already exists. Please log in.", 409);
    }
    return err(createError.message, 400);
  }

  if (!user) return err("Failed to create user account", 500);

  // 2. Create the fleet linked to this new manager
  const { data: newFleet, error: fleetError } = await adminClient
    .from("fleets")
    .insert({
      name:         fleet_name.trim(),
      organization: fleet_name.trim(),
      manager_id:   user.id,
    })
    .select("id")
    .single();

  if (fleetError || !newFleet) {
    // Roll back the auth user so the account isn't left in a half-created state
    await adminClient.auth.admin.deleteUser(user.id);
    return err(`Fleet creation failed: ${fleetError?.message ?? "unknown"}`, 500);
  }

  // 2b. Explicitly create the subscription row as a safety net.
  //     The fn_create_fleet_subscription trigger should do this automatically,
  //     but may be missing on some deployments. The ON CONFLICT DO NOTHING
  //     makes this idempotent if the trigger already fired.
  await adminClient.from("subscriptions").upsert(
    {
      fleet_id:      newFleet.id,
      plan:          "trial",
      status:        "trial",
      max_vehicles:  2,
      max_drivers:   3,
      trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "fleet_id", ignoreDuplicates: true }
  );

  // 3. Sign in with the regular anon client to obtain a proper session
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } =
    await anonClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });

  if (signInError || !signInData.session) {
    return err("Account created but sign-in failed. Please log in manually.", 500);
  }

  return json({ session: signInData.session });
});
