/**
 * invite-api edge function
 *
 * Handles the QR invite flow (Path A):
 *
 * POST { action: 'create', vehicle_name, driver_phone, driver_email?, fleet_id }
 *   → creates invitation row, returns { token, invite_url }
 *
 * GET  ?action=get&token=<token>
 *   → returns invite details for the mobile app to display
 *
 * POST { action: 'accept', token, vin, make, model, year }
 *   → creates vehicle, marks invitation accepted, returns { vehicle_id, fleet_id }
 *
 * GET  ?action=poll&token=<token>
 *   → returns { status } for the web dashboard to poll
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

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const action = req.method === "GET"
    ? url.searchParams.get("action")
    : (await req.clone().json().catch(() => ({}))).action;

  // ── GET: get invite details (no auth required — mobile uses this) ──────────
  if (req.method === "GET" && action === "get") {
    const token = url.searchParams.get("token");
    if (!token) return err("token is required");

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await adminClient
      .from("invitations")
      .select("fleet_name, vehicle_name, status, expires_at")
      .eq("invite_token", token)
      .single();

    if (error || !data) return err("Invitation not found", 404);
    if (data.status === "accepted") return err("Invitation already accepted", 410);
    if (new Date(data.expires_at) < new Date()) return err("Invitation has expired", 410);

    return json(data);
  }

  // ── GET: poll status (fleet manager dashboard) ────────────────────────────
  if (req.method === "GET" && action === "poll") {
    const token = url.searchParams.get("token");
    if (!token) return err("token is required");

    // Verify caller is authenticated
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

    const { data, error } = await adminClient
      .from("invitations")
      .select("status, vehicle_id")
      .eq("invite_token", token)
      .single();

    if (error || !data) return err("Invitation not found", 404);
    return json({ status: data.status, vehicle_id: data.vehicle_id });
  }

  // ── POST actions ──────────────────────────────────────────────────────────
  if (req.method !== "POST") return err("Method not allowed", 405);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body");

  // ── create: fleet manager creates an invitation ───────────────────────────
  if (body.action === "create") {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err("Missing Authorization header", 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return err("Unauthorized", 401);

    const { vehicle_name, driver_phone, driver_email, fleet_id } = body;
    if (!vehicle_name || !driver_phone || !fleet_id) {
      return err("vehicle_name, driver_phone, and fleet_id are required");
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify the caller owns this fleet
    const { data: fleet, error: fleetErr } = await adminClient
      .from("fleets")
      .select("id, name")
      .eq("id", fleet_id)
      .eq("manager_id", user.id)
      .single();

    if (fleetErr || !fleet) return err("Fleet not found or access denied", 403);

    const token = generateToken();

    const { data: invite, error: inviteErr } = await adminClient
      .from("invitations")
      .insert({
        fleet_id,
        fleet_name:   fleet.name,
        invite_token: token,
        vehicle_name: vehicle_name.trim(),
        driver_phone: driver_phone.trim(),
        driver_email: driver_email?.trim() ?? null,
        status:       "pending",
      })
      .select()
      .single();

    if (inviteErr) return err(inviteErr.message, 500);

    return json({
      token,
      invite_url: `vehiclesense://join?token=${token}`,
      invite_id:  invite.id,
    });
  }

  // ── accept: driver accepts the invitation on mobile app ───────────────────
  if (body.action === "accept") {
    const { token, vin, make, model, year } = body;
    if (!token || !vin || !make || !model || !year) {
      return err("token, vin, make, model, and year are required");
    }
    if (vin.length < 11) return err("VIN must be at least 11 characters");

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch and validate the invitation
    const { data: invite, error: inviteErr } = await adminClient
      .from("invitations")
      .select("*")
      .eq("invite_token", token)
      .single();

    if (inviteErr || !invite) return err("Invitation not found", 404);
    if (invite.status === "accepted") return err("Invitation already accepted", 410);
    if (new Date(invite.expires_at) < new Date()) return err("Invitation has expired", 410);

    // Get fleet manager's user_id to set as owner
    const { data: fleet, error: fleetErr } = await adminClient
      .from("fleets")
      .select("manager_id")
      .eq("id", invite.fleet_id)
      .single();

    if (fleetErr || !fleet) return err("Fleet not found", 404);

    // Create the vehicle
    const { data: vehicle, error: vehicleErr } = await adminClient
      .from("vehicles")
      .insert({
        name:         invite.vehicle_name,
        vin:          vin.trim().toUpperCase(),
        make:         make.trim(),
        model:        model.trim(),
        year:         parseInt(year),
        owner_id:     fleet.manager_id,
        fleet_id:     invite.fleet_id,
        driver_phone: invite.driver_phone,
        is_active:    true,
        health_score: 100,
      })
      .select()
      .single();

    if (vehicleErr) return err(vehicleErr.message, 500);

    // Mark invitation as accepted
    await adminClient
      .from("invitations")
      .update({ status: "accepted", vehicle_id: vehicle.id })
      .eq("invite_token", token);

    return json({ vehicle_id: vehicle.id, fleet_id: invite.fleet_id });
  }

  return err("Unknown action");
});
