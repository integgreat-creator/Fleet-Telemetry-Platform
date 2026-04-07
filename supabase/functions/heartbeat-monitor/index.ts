/**
 * heartbeat-monitor edge function
 *
 * Called by pg_cron every 2 minutes (or manually).
 * Scans device_health for vehicles that have gone silent > 120 seconds.
 * Creates vehicle_events records and triggers WhatsApp alerts.
 *
 * Also handles the 23-day pre-deletion email for vehicle_logs.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OFFLINE_THRESHOLD  = 120; // seconds

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const results: string[] = [];

  // ── 1. Find vehicles that have gone offline ────────────────────────────────
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD * 1000).toISOString();

  const { data: staleDevices } = await admin
    .from("device_health")
    .select("vehicle_id, last_ping_at, is_online, signal_strength")
    .eq("is_online", true)
    .lt("last_ping_at", cutoff);

  for (const device of (staleDevices ?? [])) {
    const vehicleId = device.vehicle_id;

    // Get vehicle + fleet info
    const { data: vehicle } = await admin
      .from("vehicles")
      .select("id, name, vin, fleet_id, fleets(name, whatsapp_number, manager_id, fleets_users:auth.users!manager_id(email))")
      .eq("id", vehicleId)
      .single();

    if (!vehicle) continue;

    const fleetId       = vehicle.fleet_id;
    const vehicleName   = vehicle.name || vehicle.vin;
    const lastPing      = new Date(device.last_ping_at);
    const minutesAgo    = Math.round((Date.now() - lastPing.getTime()) / 60000);

    // Check if there's already an unacknowledged offline event for this vehicle
    const { data: existingEvent } = await admin
      .from("vehicle_events")
      .select("id")
      .eq("vehicle_id", vehicleId)
      .eq("event_type", "device_offline")
      .eq("acknowledged", false)
      .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString()) // within last 10 min
      .maybeSingle();

    if (existingEvent) continue; // avoid duplicate events

    // Classify reason
    const { data: lastLog } = await admin
      .from("vehicle_logs")
      .select("ignition_status, speed")
      .eq("vehicle_id", vehicleId)
      .order("timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    let eventType: string = "device_offline";
    let title    = `Vehicle Offline: ${vehicleName}`;
    let description = `No data received for ${minutesAgo} minute${minutesAgo !== 1 ? "s" : ""}.`;
    let severity = "critical";

    if (lastLog?.ignition_status === true) {
      // Ignition was ON but device stopped sending — possible tamper
      eventType   = "device_tamper";
      title       = `Possible Device Tampering: ${vehicleName}`;
      description = `Ignition was ON but device stopped transmitting ${minutesAgo} minutes ago.`;
      severity    = "warning";
    }

    // Create vehicle_event
    const { data: newEvent } = await admin.from("vehicle_events").insert({
      vehicle_id:  vehicleId,
      fleet_id:    fleetId,
      event_type:  eventType,
      severity,
      title,
      description,
      metadata: {
        last_ping_at:     device.last_ping_at,
        minutes_offline:  minutesAgo,
        last_ignition:    lastLog?.ignition_status ?? null,
        last_speed:       lastLog?.speed ?? null,
        signal_strength:  device.signal_strength,
      },
    }).select().single();

    // Mark device as offline
    await admin
      .from("device_health")
      .update({ is_online: false })
      .eq("vehicle_id", vehicleId);

    results.push(`${eventType} event created for vehicle ${vehicleId}`);

    // Trigger WhatsApp alert
    if (newEvent && vehicle.fleets?.whatsapp_number) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-alerts`, {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            event_id:          newEvent.id,
            vehicle_name:      vehicleName,
            vehicle_vin:       vehicle.vin,
            event_type:        eventType,
            description,
            whatsapp_number:   vehicle.fleets.whatsapp_number,
          }),
        });
      } catch (e) {
        results.push(`WhatsApp alert failed for ${vehicleId}: ${e}`);
      }
    }
  }

  // ── 2. Pre-deletion email: vehicle_logs approaching 23 days ───────────────
  const emailCutoffStart = new Date(Date.now() - 23 * 24 * 3600 * 1000).toISOString();
  const emailCutoffEnd   = new Date(Date.now() - 22 * 24 * 3600 * 1000).toISOString();

  // Find fleets that have logs in the 23-day window and haven't been notified yet
  const { data: agingLogs } = await admin
    .from("vehicle_logs")
    .select("vehicle_id, vehicles(fleet_id)")
    .gte("timestamp", emailCutoffStart)
    .lt("timestamp", emailCutoffEnd)
    .limit(100);

  const fleetIdsToNotify = [...new Set(
    (agingLogs ?? []).map((l: any) => l.vehicles?.fleet_id).filter(Boolean)
  )];

  for (const fleetId of fleetIdsToNotify) {
    const { data: fleet } = await admin
      .from("fleets")
      .select("id, name, manager_id")
      .eq("id", fleetId)
      .single();

    if (!fleet) continue;

    const { data: managerUser } = await admin.auth.admin.getUserById(fleet.manager_id);
    const managerEmail = managerUser?.user?.email;
    if (!managerEmail) continue;

    // Count logs about to be deleted
    const { count } = await admin
      .from("vehicle_logs")
      .select("*", { count: "exact", head: true })
      .eq("vehicle_id",
        (await admin.from("vehicles").select("id").eq("fleet_id", fleetId)).data?.map((v: any) => v.id) ?? []
      )
      .lt("timestamp", emailCutoffEnd);

    // Send email notification via Supabase Auth admin
    await admin.auth.admin.inviteUserByEmail(managerEmail, {
      data: {
        notification_type: "data_retention_warning",
        fleet_name: fleet.name,
        log_count: count,
        deletion_date: new Date(Date.now() + 7 * 24 * 3600 * 1000).toLocaleDateString("en-IN"),
      },
      redirectTo: `${Deno.env.get("SITE_URL") ?? "https://vehiclesense.app"}/admin`,
    }).catch(() => null);

    results.push(`Retention warning email queued for fleet ${fleet.name}`);
  }

  return json({ processed: results.length, results });
});
