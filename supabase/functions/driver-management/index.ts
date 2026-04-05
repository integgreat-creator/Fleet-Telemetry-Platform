/**
 * driver-management edge function
 *
 * Handles Path B — fleet manager creates a driver account with credentials.
 * The service_role key lives here (server-side) and is NEVER sent to the client.
 *
 * POST { action: 'create', name, email, password, phone?, vehicle_id?, fleet_id }
 *   → creates auth user + driver_accounts row, returns { driver_id, email }
 *
 * POST { action: 'delete', driver_id }
 *   → deletes driver_accounts row + auth user
 *
 * GET  ?action=list
 *   → returns all drivers for the caller's fleet
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(msg: string, status = 400) { return json({ error: msg }, status); }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // All routes require authentication
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err("Missing Authorization header", 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err("Unauthorized", 401);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Verify caller owns a fleet
  const { data: fleet, error: fleetErr } = await adminClient
    .from("fleets")
    .select("id, name")
    .eq("manager_id", user.id)
    .single();

  if (fleetErr || !fleet) return err("No fleet found for this account", 403);

  // ── GET list ────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data: drivers, error: driversErr } = await adminClient
      .from("driver_accounts")
      .select("*, vehicles(id, name, vin, make, model)")
      .eq("fleet_id", fleet.id)
      .order("created_at", { ascending: false });

    if (driversErr) return err(driversErr.message, 500);
    return json(drivers ?? []);
  }

  if (req.method !== "POST") return err("Method not allowed", 405);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body");

  // ── create ──────────────────────────────────────────────────────────────────
  if (body.action === "create") {
    const { name, email, password, phone, vehicle_id } = body;
    if (!name || !email || !password) {
      return err("name, email, and password are required");
    }

    // Create auth user (email pre-confirmed — no verification email)
    const { data: { user: newUser }, error: createErr } =
      await adminClient.auth.admin.createUser({
        email:         email.trim().toLowerCase(),
        password,
        email_confirm: true,
      });

    if (createErr) {
      if (createErr.message.toLowerCase().includes("already")) {
        return err("A driver with this email already exists", 409);
      }
      return err(createErr.message, 400);
    }
    if (!newUser) return err("Failed to create driver account", 500);

    // Create driver_accounts row
    const { data: driverAccount, error: daErr } = await adminClient
      .from("driver_accounts")
      .insert({
        user_id:    newUser.id,
        fleet_id:   fleet.id,
        vehicle_id: vehicle_id ?? null,
        name:       name.trim(),
        phone:      phone?.trim() ?? null,
        email:      email.trim().toLowerCase(),
      })
      .select()
      .single();

    if (daErr) {
      // Roll back auth user if driver_accounts insert fails
      await adminClient.auth.admin.deleteUser(newUser.id);
      return err(daErr.message, 500);
    }

    return json({
      driver_id:  driverAccount.id,
      user_id:    newUser.id,
      email:      email.trim().toLowerCase(),
      name:       name.trim(),
      vehicle_id: vehicle_id ?? null,
    });
  }

  // ── delete ──────────────────────────────────────────────────────────────────
  if (body.action === "delete") {
    const { driver_id } = body;
    if (!driver_id) return err("driver_id is required");

    // Fetch the driver to get user_id and verify it belongs to this fleet
    const { data: driver, error: fetchErr } = await adminClient
      .from("driver_accounts")
      .select("user_id")
      .eq("id", driver_id)
      .eq("fleet_id", fleet.id)
      .single();

    if (fetchErr || !driver) return err("Driver not found", 404);

    // Delete driver_accounts row
    await adminClient.from("driver_accounts").delete().eq("id", driver_id);

    // Delete auth user
    await adminClient.auth.admin.deleteUser(driver.user_id);

    return json({ success: true });
  }

  return err("Unknown action");
});
