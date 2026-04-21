/**
 * fleet-delete edge function
 *
 * Permanently deletes a fleet and ALL associated data:
 *   1. Verifies the caller is the fleet manager (manager_id = userId)
 *   2. Collects all driver user_ids so we can purge their auth accounts
 *   3. Deletes the fleet record — ON DELETE CASCADE handles:
 *        vehicles → sensor_data, alerts, trips, thresholds, device_health
 *        driver_accounts → (cascade from fleet_id)
 *        subscriptions
 *        invitations
 *   4. Deletes every driver's auth.users entry via the service-role admin API
 *      (DB cascade cannot reach auth schema)
 *
 * NOTE: The manager's own auth user is NOT deleted here.
 * The client is responsible for calling supabase.auth.signOut() after success.
 *
 * POST { fleet_id }
 * Authorization: Bearer <user-jwt>
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
  if (req.method !== "POST")   return err("Method not allowed", 405);

  // ── Authenticate caller ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return err("Missing authorization token", 401);

  const userJwt = authHeader.slice(7);

  // Use the user-scoped client to verify their identity (RLS is applied here)
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return err("Invalid or expired session", 401);

  // ── Parse body ───────────────────────────────────────────────────────────────
  let fleet_id: string;
  try {
    ({ fleet_id } = await req.json());
  } catch {
    return err("Invalid JSON body");
  }

  if (!fleet_id) return err("fleet_id is required");

  // ── Verify caller is the fleet manager ──────────────────────────────────────
  const { data: fleet, error: fleetErr } = await userClient
    .from("fleets")
    .select("id, name, manager_id")
    .eq("id", fleet_id)
    .single();

  if (fleetErr || !fleet) return err("Fleet not found", 404);
  if (fleet.manager_id !== user.id) return err("You are not authorised to delete this fleet", 403);

  // ── Service-role client for privileged operations ────────────────────────────
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Collect driver user_ids before deleting ──────────────────────────────────
  const { data: driverRows } = await adminClient
    .from("driver_accounts")
    .select("user_id")
    .eq("fleet_id", fleet_id);

  const driverUserIds: string[] = (driverRows ?? [])
    .map((d: { user_id: string }) => d.user_id)
    .filter(Boolean);

  // ── Delete the fleet (cascades to all child rows) ────────────────────────────
  const { error: deleteErr } = await adminClient
    .from("fleets")
    .delete()
    .eq("id", fleet_id);

  if (deleteErr) {
    return err(`Failed to delete fleet: ${deleteErr.message}`, 500);
  }

  // ── Delete driver auth users (best-effort; failures are logged, not fatal) ───
  const driverDeleteResults = await Promise.allSettled(
    driverUserIds.map(uid => adminClient.auth.admin.deleteUser(uid))
  );

  const driverDeleteErrors = driverDeleteResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map(r => String(r.reason));

  // ── Done ─────────────────────────────────────────────────────────────────────
  return json({
    success: true,
    fleet_name:           fleet.name,
    drivers_purged:       driverUserIds.length - driverDeleteErrors.length,
    driver_purge_errors:  driverDeleteErrors.length,
  });
});
