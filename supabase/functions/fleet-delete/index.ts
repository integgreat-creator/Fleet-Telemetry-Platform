/**
 * fleet-delete edge function
 *
 * Supports two modes:
 *
 * MODE A — Full delete (legacy, cleanup_only absent or false):
 *   Verifies caller owns the fleet, deletes the fleet record (DB cascade
 *   removes all child data), then purges driver auth.users via service role.
 *   POST { fleet_id }
 *
 * MODE B — Auth cleanup only (cleanup_only: true):
 *   Called by the web client AFTER it has already deleted the fleet via the
 *   Supabase JS client. Receives driver_user_ids directly and purges those
 *   auth.users entries. No fleet verification needed (fleet is already gone).
 *   POST { cleanup_only: true, driver_user_ids: string[] }
 *
 * Both modes require: Authorization: Bearer <user-jwt>
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

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth:   { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return err("Invalid or expired session", 401);

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // MODE B — Auth cleanup only
  // The fleet has already been deleted client-side; just purge driver auth users.
  // ══════════════════════════════════════════════════════════════════════════════
  if (body.cleanup_only === true) {
    const driverUserIds = Array.isArray(body.driver_user_ids)
      ? (body.driver_user_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];

    if (driverUserIds.length === 0) {
      return json({ success: true, drivers_purged: 0, driver_purge_errors: 0 });
    }

    const results = await Promise.allSettled(
      driverUserIds.map(uid => adminClient.auth.admin.deleteUser(uid))
    );

    const errors = results.filter(r => r.status === "rejected").length;

    return json({
      success:             true,
      drivers_purged:      driverUserIds.length - errors,
      driver_purge_errors: errors,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MODE A — Full delete
  // ══════════════════════════════════════════════════════════════════════════════
  const fleet_id = body.fleet_id as string | undefined;
  if (!fleet_id) return err("fleet_id is required");

  // Verify caller is the fleet manager
  const { data: fleet, error: fleetErr } = await userClient
    .from("fleets")
    .select("id, name, manager_id")
    .eq("id", fleet_id)
    .single();

  if (fleetErr || !fleet) return err("Fleet not found", 404);
  if (fleet.manager_id !== user.id) return err("You are not authorised to delete this fleet", 403);

  // Collect driver user_ids before deletion
  const { data: driverRows } = await adminClient
    .from("driver_accounts")
    .select("user_id")
    .eq("fleet_id", fleet_id);

  const driverUserIds: string[] = (driverRows ?? [])
    .map((d: { user_id: string }) => d.user_id)
    .filter(Boolean);

  // Delete the fleet — ON DELETE CASCADE removes all child rows
  const { error: deleteErr } = await adminClient
    .from("fleets")
    .delete()
    .eq("id", fleet_id);

  if (deleteErr) return err(`Failed to delete fleet: ${deleteErr.message}`, 500);

  // Purge driver auth users (best-effort)
  const results = await Promise.allSettled(
    driverUserIds.map(uid => adminClient.auth.admin.deleteUser(uid))
  );

  const errors = results.filter(r => r.status === "rejected").length;

  return json({
    success:             true,
    fleet_name:          fleet.name,
    drivers_purged:      driverUserIds.length - errors,
    driver_purge_errors: errors,
  });
});
