/**
 * geofence-monitor — server-side zone crossing engine.
 *
 * Triggered by a Supabase Database Webhook on vehicle_logs → INSERT.
 * Payload shape: { type: "INSERT", table: "vehicle_logs", record: {...} }
 *
 * For every incoming GPS point this function:
 *   1. Skips stale points (> 10 min old — from offline queue flush)
 *   2. Loads all active zone assignments for the vehicle
 *   3. Runs circle / polygon geometry checks
 *   4. Compares result against geofence_vehicle_state
 *   5. On state change: writes to vehicle_events, optionally calls
 *      whatsapp-alerts, updates geofence_vehicle_state
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS (reads across fleet
 * boundaries for internal processing; fleet scope is enforced manually).
 *
 * Driver-side / on-device checking is intentionally NOT implemented here —
 * it can be added later without changing this function.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Stale-point guard (seconds) ───────────────────────────────────────────────
const STALE_THRESHOLD_SEC = 600; // 10 minutes

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Returns true if (lat, lng) is within radiusMetres of (centerLat, centerLng). */
function isInsideCircle(
  lat: number, lng: number,
  centerLat: number, centerLng: number,
  radiusMetres: number,
): boolean {
  const R    = 6_371_000; // Earth radius in metres
  const dLat = (lat - centerLat) * Math.PI / 180;
  const dLng = (lng - centerLng) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(centerLat * Math.PI / 180) *
    Math.cos(lat       * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return dist <= radiusMetres;
}

/**
 * Ray-casting point-in-polygon.
 * coords: [[lat, lng], ...] in the same order they were drawn.
 */
function isInsidePolygon(
  lat: number, lng: number,
  coords: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [xi, yi] = coords[i];
    const [xj, yj] = coords[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns true if `now` falls within the [startTime, endTime] window.
 * Handles overnight ranges (e.g., "22:00" → "06:00").
 */
function isWithinTimeRestriction(
  now: Date,
  startTime: string | null,
  endTime:   string | null,
): boolean {
  if (!startTime || !endTime) return false;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const nowMins  = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  // Overnight range (e.g., 22:00–06:00)
  return startMin > endMin
    ? nowMins >= startMin || nowMins <= endMin
    : nowMins >= startMin && nowMins <= endMin;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const payload = await req.json();

    // Support both direct webhook payload and test POST with a record field
    const record = payload.record ?? payload;

    const vehicleId        = record.vehicle_id        as string | undefined;
    const lat              = record.latitude           as number | undefined;
    const lng              = record.longitude          as number | undefined;
    const speedKmh         = record.speed              as number | undefined;
    const recordTimestamp  = record.timestamp          as string | undefined;
    const driverAccountId  = record.driver_account_id as string | null | undefined;

    // Skip rows without coordinates
    if (!vehicleId || lat == null || lng == null) {
      return new Response(JSON.stringify({ skipped: 'no_coordinates' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Stale-point guard ────────────────────────────────────────────────────
    if (recordTimestamp) {
      const ageMs = Date.now() - new Date(recordTimestamp).getTime();
      if (ageMs > STALE_THRESHOLD_SEC * 1000) {
        return new Response(
          JSON.stringify({ skipped: 'stale', age_sec: Math.round(ageMs / 1000) }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db             = createClient(supabaseUrl, serviceRoleKey);

    // ── Load active assignments for this vehicle ──────────────────────────────
    const { data: assignments } = await db
      .from('geofence_assignments')
      .select(`
        id,
        alert_on_entry,
        alert_on_exit,
        alert_on_dwell,
        dwell_minutes,
        alert_channels,
        cooldown_minutes,
        geofences (
          id, fleet_id, name, zone_type, shape,
          center_lat, center_lng, radius_metres,
          coordinates,
          time_restriction_start, time_restriction_end,
          is_active
        )
      `)
      .eq('vehicle_id', vehicleId)
      .eq('is_active', true);

    if (!assignments?.length) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Look up fleet_id for this vehicle (needed for vehicle_events row)
    const { data: vehicleRow } = await db
      .from('vehicles')
      .select('fleet_id, name')
      .eq('id', vehicleId)
      .single();

    const fleetId     = vehicleRow?.fleet_id ?? '';
    const vehicleName = vehicleRow?.name     ?? vehicleId;

    let crossings = 0;
    const now = new Date();

    for (const assignment of assignments as any[]) {
      const zone = assignment.geofences;
      if (!zone) continue;
      // Skip zones that were deactivated after the assignment was created
      if (zone.is_active === false) continue;

      // ── Geometry check ──────────────────────────────────────────────────────
      let isNowInside: boolean;

      if (zone.shape === 'circle') {
        if (zone.center_lat == null || zone.center_lng == null || zone.radius_metres == null) continue;
        isNowInside = isInsideCircle(
          lat, lng,
          Number(zone.center_lat), Number(zone.center_lng),
          Number(zone.radius_metres),
        );
      } else if (zone.shape === 'polygon') {
        const coords = zone.coordinates as [number, number][] | null;
        if (!coords?.length) continue;
        isNowInside = isInsidePolygon(lat, lng, coords);
      } else {
        continue; // unknown shape
      }

      // ── Load current state ──────────────────────────────────────────────────
      const { data: stateRow } = await db
        .from('geofence_vehicle_state')
        .select('is_inside, entered_at, last_event_at')
        .eq('geofence_id', zone.id)
        .eq('vehicle_id', vehicleId)
        .maybeSingle();

      // First time we've seen this vehicle+zone pair — seed state, no alert
      if (!stateRow) {
        await db.from('geofence_vehicle_state').upsert({
          geofence_id:     zone.id,
          vehicle_id:      vehicleId,
          is_inside:       isNowInside,
          entered_at:      isNowInside ? now.toISOString() : null,
          last_checked_at: now.toISOString(),
          last_event_at:   null,
        }, { onConflict: 'geofence_id,vehicle_id' });
        continue;
      }

      const wasInside = stateRow.is_inside as boolean;

      // No state change — just update last_checked_at
      if (wasInside === isNowInside) {
        await db
          .from('geofence_vehicle_state')
          .update({ last_checked_at: now.toISOString() })
          .eq('geofence_id', zone.id)
          .eq('vehicle_id',  vehicleId);

        // Check dwell alert: vehicle inside longer than dwell_minutes
        if (
          isNowInside &&
          assignment.alert_on_dwell &&
          stateRow.entered_at
        ) {
          const dwellMs = now.getTime() - new Date(stateRow.entered_at).getTime();
          const dwellMin = dwellMs / 60_000;

          // Only fire dwell once per cooldown window
          const cooldownOk = !stateRow.last_event_at ||
            (now.getTime() - new Date(stateRow.last_event_at).getTime()) >
            assignment.cooldown_minutes * 60_000;

          if (dwellMin >= assignment.dwell_minutes && cooldownOk) {
            await fireEvent(db, {
              vehicleId, fleetId, vehicleName, zone,
              eventType:       'geofence_dwell',
              severity:        'warning',
              title:           `Long Stop in ${zone.name}`,
              description:     `Vehicle has been inside zone "${zone.name}" for ${Math.round(dwellMin)} minutes.`,
              lat, lng, speedKmh: speedKmh ?? 0,
              driverAccountId: driverAccountId ?? null,
              alertChannels:   assignment.alert_channels,
            });
            await db
              .from('geofence_vehicle_state')
              .update({ last_event_at: now.toISOString() })
              .eq('geofence_id', zone.id)
              .eq('vehicle_id',  vehicleId);
          }
        }
        continue;
      }

      // ── State changed — a crossing occurred ──────────────────────────────────

      // Cooldown check
      if (stateRow.last_event_at) {
        const msSinceLast = now.getTime() - new Date(stateRow.last_event_at).getTime();
        if (msSinceLast < assignment.cooldown_minutes * 60_000) {
          // Within cooldown window — update state but skip alert
          await db
            .from('geofence_vehicle_state')
            .update({ is_inside: isNowInside, last_checked_at: now.toISOString() })
            .eq('geofence_id', zone.id)
            .eq('vehicle_id',  vehicleId);
          continue;
        }
      }

      // Determine event type
      const withinTimeRestriction = isWithinTimeRestriction(
        now,
        zone.time_restriction_start,
        zone.time_restriction_end,
      );

      let eventType: string;
      let severity:  'warning' | 'critical';
      let title:     string;
      let description: string;

      if (!wasInside && isNowInside) {
        // Entry
        if (withinTimeRestriction) {
          eventType   = 'night_movement';
          severity    = 'critical';
          title       = `Night Movement — Entered ${zone.name}`;
          description = `Vehicle entered zone "${zone.name}" during restricted hours.`;
        } else if (zone.zone_type === 'restricted') {
          eventType   = 'geofence_entry_restricted';
          severity    = 'critical';
          title       = `Entered Restricted Zone: ${zone.name}`;
          description = `Vehicle entered restricted zone "${zone.name}".`;
        } else {
          eventType   = 'geofence_entry';
          severity    = 'warning';
          title       = `Entered Zone: ${zone.name}`;
          description = `Vehicle entered zone "${zone.name}".`;
        }

        if (!assignment.alert_on_entry) {
          // Update state silently
          await db
            .from('geofence_vehicle_state')
            .update({ is_inside: true, entered_at: now.toISOString(), last_checked_at: now.toISOString() })
            .eq('geofence_id', zone.id)
            .eq('vehicle_id',  vehicleId);
          continue;
        }
      } else {
        // Exit
        if (withinTimeRestriction) {
          eventType   = 'night_movement';
          severity    = 'critical';
          title       = `Night Movement — Left ${zone.name}`;
          description = `Vehicle left zone "${zone.name}" during restricted hours.`;
        } else {
          eventType   = 'geofence_exit';
          severity    = 'warning';
          title       = `Left Zone: ${zone.name}`;
          description = `Vehicle left zone "${zone.name}".`;
        }

        if (!assignment.alert_on_exit) {
          await db
            .from('geofence_vehicle_state')
            .update({ is_inside: false, last_checked_at: now.toISOString() })
            .eq('geofence_id', zone.id)
            .eq('vehicle_id',  vehicleId);
          continue;
        }
      }

      // Fire the event
      await fireEvent(db, {
        vehicleId, fleetId, vehicleName, zone,
        eventType, severity, title, description,
        lat, lng, speedKmh: speedKmh ?? 0,
        driverAccountId: driverAccountId ?? null,
        alertChannels:   assignment.alert_channels,
      });

      // Update state
      await db
        .from('geofence_vehicle_state')
        .update({
          is_inside:       isNowInside,
          entered_at:      isNowInside ? now.toISOString() : stateRow.entered_at,
          last_checked_at: now.toISOString(),
          last_event_at:   now.toISOString(),
        })
        .eq('geofence_id', zone.id)
        .eq('vehicle_id',  vehicleId);

      crossings++;
    }

    return new Response(JSON.stringify({ processed: assignments.length, crossings }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('geofence-monitor error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Event writer ──────────────────────────────────────────────────────────────

interface FireEventParams {
  vehicleId:       string;
  fleetId:         string;
  vehicleName:     string;
  zone:            any;
  eventType:       string;
  severity:        'warning' | 'critical';
  title:           string;
  description:     string;
  lat:             number;
  lng:             number;
  speedKmh:        number;
  driverAccountId: string | null;
  alertChannels:   { in_app?: boolean; whatsapp?: boolean } | null;
}

async function fireEvent(
  db: ReturnType<typeof createClient>,
  p: FireEventParams,
): Promise<void> {
  // Write to vehicle_events — surfaces immediately in AlertsPage
  await db.from('vehicle_events').insert({
    vehicle_id:  p.vehicleId,
    fleet_id:    p.fleetId,
    event_type:  p.eventType,
    severity:    p.severity,
    title:       p.title,
    description: p.description,
    metadata: {
      zone_id:           p.zone.id,
      zone_name:         p.zone.name,
      zone_type:         p.zone.zone_type,
      latitude:          p.lat,
      longitude:         p.lng,
      speed_kmh:         p.speedKmh,
      driver_account_id: p.driverAccountId,
    },
  });

  // WhatsApp alert (if enabled for this assignment)
  if (p.alertChannels?.whatsapp) {
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      await fetch(`${supabaseUrl}/functions/v1/whatsapp-alerts`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
        body: JSON.stringify({
          vehicle_id:  p.vehicleId,
          fleet_id:    p.fleetId,
          event_type:  p.eventType,
          title:       p.title,
          description: p.description,
          severity:    p.severity,
        }),
      });
    } catch (e) {
      console.error('geofence-monitor: whatsapp-alerts call failed:', e);
      // Non-fatal — the vehicle_events row is already written
    }
  }
}
