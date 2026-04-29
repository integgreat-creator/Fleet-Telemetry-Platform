/**
 * fleet-signup edge function
 *
 * Handles fleet manager registration atomically using the service role key:
 *   1. Creates the auth user (marked as email-confirmed immediately)
 *   2. Creates the fleet record + trial subscription linked to that user
 *   3. Returns { ok: true } — the client signs in with signInWithPassword()
 *
 * The client handles sign-in rather than receiving a server-side session
 * because setSession() is unreliable across browsers and doesn't consistently
 * fire onAuthStateChange, preventing the dashboard from loading.
 *
 * "Already exists" path: if the auth account exists but has no fleet (e.g.
 * after a fleet deletion), credentials are verified via signInWithPassword and
 * a new fleet is created for the existing account.
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
  // Optional. The Auth screen reads i18n.language at submit time and passes
  // it through so first-time customers don't have to re-toggle the
  // LanguageSwitcher post-login to "lock in" their reminder language.
  // Phase 1.8.1.
  let preferred_language: string | null | undefined;
  try {
    ({ email, password, fleet_name, preferred_language } = await req.json());
  } catch {
    return err("Invalid JSON body");
  }

  if (!email || !password || !fleet_name) {
    return err("email, password, and fleet_name are required");
  }

  // Whitelist the language value before it lands in the DB. Anything outside
  // the supported set falls back to NULL (= "no opinion expressed", same as
  // the existing-fleet default). Defensive against a malformed client header
  // or a future locale we haven't added yet.
  const SUPPORTED_LANGUAGES = ['en', 'ta'] as const;
  const normalizedLanguage =
    typeof preferred_language === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(preferred_language)
      ? preferred_language
      : null;

  // Service-role client — bypasses RLS for admin operations
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const normalizedEmail = email.trim().toLowerCase();

  // ── Anon client — used for sign-in steps ────────────────────────────────────
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);

  // ── Helper: create fleet + subscription for a known user ID ─────────────────
  // Returns { ok: true } on success — the client signs in independently.
  async function createFleetForUser(userId: string): Promise<Response> {
    const { data: newFleet, error: fleetError } = await adminClient
      .from("fleets")
      .insert({
        name:                fleet_name.trim(),
        organization:        fleet_name.trim(),
        manager_id:          userId,
        preferred_language:  normalizedLanguage,
      })
      .select("id")
      .single();

    if (fleetError || !newFleet) {
      return err(`Fleet creation failed: ${fleetError?.message ?? "unknown"}`, 500);
    }

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

    // Return ok — the client will call signInWithPassword to establish the session.
    // Returning a server-side session and using setSession() on the client is
    // unreliable (onAuthStateChange doesn't always fire); a client-side signIn
    // is the single reliable path that loads the dashboard.
    return json({ ok: true });
  }

  // 1. Create the auth user, marking the email as confirmed so they can
  //    sign in immediately without needing an email confirmation link.
  const { data: { user }, error: createError } =
    await adminClient.auth.admin.createUser({
      email:         normalizedEmail,
      password,
      email_confirm: true,
    });

  if (createError) {
    if (createError.message.toLowerCase().includes("already")) {
      // The auth account exists — likely because the user previously deleted their
      // fleet but the auth.users row was kept.  Verify credentials by signing in:
      //   - If sign-in succeeds AND the user has no fleet  → create a new fleet
      //   - If sign-in succeeds AND the user has a fleet   → genuine conflict
      //   - If sign-in fails (wrong password)              → reject cleanly
      const { data: existingSignIn, error: signInErr } =
        await anonClient.auth.signInWithPassword({ email: normalizedEmail, password });

      if (signInErr || !existingSignIn?.user || !existingSignIn.session) {
        // Wrong password or other auth error — do not reveal details
        return err("An account with this email already exists. Please log in.", 409);
      }

      // Check whether this account still has a fleet
      const { data: existingFleet } = await adminClient
        .from("fleets")
        .select("id")
        .eq("manager_id", existingSignIn.user.id)
        .maybeSingle();

      if (existingFleet) {
        // Account has an active fleet — tell them to log in normally
        return err("An account with this email already exists. Please log in.", 409);
      }

      // No fleet — create one. Client will sign in with signInWithPassword.
      return createFleetForUser(existingSignIn.user.id);
    }
    return err(createError.message, 400);
  }

  if (!user) return err("Failed to create user account", 500);

  // Create fleet. If that fails, roll back the auth user.
  const fleetResponse = await createFleetForUser(user.id);
  if (!fleetResponse.ok) {
    await adminClient.auth.admin.deleteUser(user.id);
  }
  return fleetResponse;
});
