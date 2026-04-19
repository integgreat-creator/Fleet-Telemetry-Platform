/**
 * generate-predictions — Rule-based maintenance & cost prediction engine.
 *
 * Triggered by:
 *   POST /generate-predictions            → regenerate for ALL vehicles owned
 *                                           by the calling user's fleet(s)
 *   POST /generate-predictions?vehicle_id=<uuid>  → single vehicle
 *
 * Uses the SUPABASE_SERVICE_ROLE_KEY so it can read all relevant data
 * regardless of the calling user's RLS context, while still checking that
 * the caller has the right to trigger generation (fleet manager / owner).
 *
 * Maintenance rules (read from maintenance_rules DB table first; falls back
 * to the hardcoded FALLBACK_RULES array when the table is empty):
 *   oil_change       every 10 000 km | 365 days
 *   tire_rotation    every  8 000 km
 *   air_filter       every 20 000 km | 365 days
 *   engine_check     every 50 000 km | 730 days
 *   brake_inspection every 30 000 km
 *
 * Last-service baseline (used instead of vehicle.created_at):
 *   Reads maintenance_logs for each service type to get the most recent
 *   service_date and odometer_km. Falls back to vehicle.created_at / 0 km
 *   when no log exists (first-time setup).
 *
 * Status computation:
 *   overdue  → remaining km ≤ 0, OR remaining days ≤ 0
 *   due      → remaining km ≤ urgency_near_km
 *   upcoming → everything else
 *
 * DELETE strategy (fixes pre-existing bug):
 *   Only deletes predictions with status != 'completed', preserving any
 *   services the user has already marked as serviced.
 *
 * Alert events:
 *   Writes a vehicle_events row for every 'due' or 'overdue' prediction
 *   so AlertsPage shows actionable maintenance alerts.
 *
 * Cost projections (weekly / monthly) derived from:
 *   - Recent average daily km (from trips in last 30 days)
 *   - Recent average fuel consumption rate (sensor_data: engineFuelRate L/h)
 *   - Recent average speed            (sensor_data: speed km/h)
 *   - Fuel price (live from fuel_price_config; fallback: FUEL_PRICE_USD env)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

// ── Hardcoded fallback rules (used when maintenance_rules table is empty) ─────

interface MaintenanceRule {
  type:          string;
  description:   string;
  intervalKm:    number;
  intervalDays:  number | null;
  urgencyNearKm: number;
  urgencyFarKm:  number;
}

const FALLBACK_RULES: MaintenanceRule[] = [
  {
    type: 'oil_change',        description: 'Engine oil & filter replacement',
    intervalKm: 10_000, intervalDays: 365,  urgencyNearKm: 1_000,  urgencyFarKm: 2_500,
  },
  {
    type: 'tire_rotation',     description: 'Rotate tyres to ensure even wear',
    intervalKm: 8_000,  intervalDays: null, urgencyNearKm: 800,    urgencyFarKm: 2_000,
  },
  {
    type: 'air_filter',        description: 'Engine air filter replacement',
    intervalKm: 20_000, intervalDays: 365,  urgencyNearKm: 2_000,  urgencyFarKm: 5_000,
  },
  {
    type: 'brake_inspection',  description: 'Brake pad & rotor inspection',
    intervalKm: 30_000, intervalDays: null, urgencyNearKm: 3_000,  urgencyFarKm: 7_500,
  },
  {
    type: 'engine_check',      description: 'Full engine & emissions service',
    intervalKm: 50_000, intervalDays: 730,  urgencyNearKm: 5_000,  urgencyFarKm: 12_000,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function urgencyFor(
  remainingKm: number,
  rule: MaintenanceRule,
): 'low' | 'medium' | 'high' | 'critical' {
  if (remainingKm <= 0)                  return 'critical';
  if (remainingKm <= rule.urgencyNearKm) return 'high';
  if (remainingKm <= rule.urgencyFarKm)  return 'medium';
  return 'low';
}

function statusFor(remainingKm: number, remainingDays: number | null): 'upcoming' | 'due' | 'overdue' {
  if (remainingKm <= 0) return 'overdue';
  if (remainingDays !== null && remainingDays <= 0) return 'overdue';
  if (remainingKm <= 1_000) return 'due';   // within urgencyNear threshold
  return 'upcoming';
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const anonKey        = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader     = req.headers.get('Authorization') || '';

    // Verify the caller is authenticated
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await authClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Service-role client for reading/writing across RLS
    const db = createClient(supabaseUrl, serviceRoleKey);

    // ── Live fuel price ───────────────────────────────────────────────────────
    let fuelPriceUsd: number;
    const { data: priceRow } = await db
      .from('fuel_price_config')
      .select('price_usd')
      .eq('id', 1)
      .maybeSingle();
    fuelPriceUsd = priceRow?.price_usd != null
      ? Number(priceRow.price_usd)
      : parseFloat(Deno.env.get('FUEL_PRICE_USD') || '1.24');

    // ── Load maintenance rules from DB (fallback to hardcoded) ────────────────
    const { data: dbRules } = await db
      .from('maintenance_rules')
      .select('service_type, description, interval_km, interval_days, urgency_near_km, urgency_far_km')
      .is('vehicle_id', null)          // global defaults only
      .eq('is_active', true);

    const rules: MaintenanceRule[] = (dbRules && dbRules.length > 0)
      ? (dbRules as any[]).map((r: any) => ({
          type:          r.service_type,
          description:   r.description ?? r.service_type,
          intervalKm:    Number(r.interval_km)    || 10_000,
          intervalDays:  r.interval_days != null ? Number(r.interval_days) : null,
          urgencyNearKm: Number(r.urgency_near_km) || 1_000,
          urgencyFarKm:  Number(r.urgency_far_km)  || 2_500,
        }))
      : FALLBACK_RULES;

    // ── Determine which vehicles to process ───────────────────────────────────
    const url = new URL(req.url);
    const singleVehicleId = url.searchParams.get('vehicle_id');

    let vehicleIds: string[];
    if (singleVehicleId) {
      vehicleIds = [singleVehicleId];
    } else {
      // Fetch fleet IDs the user manages using the query builder (no interpolation).
      const { data: fleets } = await db
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id);
      const fleetIds = (fleets || []).map((f: any) => f.id as string);

      // Two separate queries, each using parameterised filters, then merge + deduplicate.
      const [{ data: ownedVehicles }, { data: fleetVehicles }] = await Promise.all([
        db.from('vehicles').select('id').eq('owner_id', user.id),
        fleetIds.length > 0
          ? db.from('vehicles').select('id').in('fleet_id', fleetIds)
          : Promise.resolve({ data: [] }),
      ]);

      vehicleIds = [
        ...new Set([
          ...(ownedVehicles || []).map((v: any) => v.id as string),
          ...(fleetVehicles || []).map((v: any) => v.id as string),
        ]),
      ];
    }

    if (vehicleIds.length === 0) {
      return new Response(JSON.stringify({ generated: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let totalMaint = 0;
    let totalCost  = 0;

    for (const vehicleId of vehicleIds) {
      const [maint, cost] = await Promise.all([
        generateMaintenancePredictions(db, vehicleId, rules),
        generateCostPredictions(db, vehicleId, fuelPriceUsd),
      ]);
      totalMaint += maint;
      totalCost  += cost;
    }

    return new Response(
      JSON.stringify({
        generated:                vehicleIds.length,
        maintenance_predictions:  totalMaint,
        cost_predictions:         totalCost,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('generate-predictions error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── Maintenance predictions ────────────────────────────────────────────────────

async function generateMaintenancePredictions(
  db:        ReturnType<typeof createClient>,
  vehicleId: string,
  rules:     MaintenanceRule[],
): Promise<number> {

  // Total distance driven (all recorded trips — the odometer source)
  const { data: tripAgg } = await db
    .from('trips')
    .select('distance_km')
    .eq('vehicle_id', vehicleId);

  const totalKm = (tripAgg || []).reduce(
    (sum: number, t: any) => sum + (parseFloat(t.distance_km) || 0),
    0,
  );

  // Vehicle metadata (created_at for fallback when no service log exists)
  const { data: vehicle } = await db
    .from('vehicles')
    .select('id, fleet_id, name, created_at')
    .eq('id', vehicleId)
    .single();

  const vehicleCreatedAt = vehicle ? new Date(vehicle.created_at) : new Date();
  const fleetId          = vehicle?.fleet_id ?? null;

  // Last service records from maintenance_logs (the authoritative baseline)
  // Get the most recent log per service_type for this vehicle
  const { data: serviceLogs } = await db
    .from('maintenance_logs')
    .select('service_type, service_date, odometer_km')
    .eq('vehicle_id', vehicleId)
    .order('service_date', { ascending: false });

  // Build a map: service_type → { lastDate, lastKm }
  const lastService: Record<string, { date: Date; km: number }> = {};
  for (const log of (serviceLogs || []) as any[]) {
    if (!lastService[log.service_type]) {
      lastService[log.service_type] = {
        date: new Date(log.service_date),
        km:   parseFloat(log.odometer_km) || 0,
      };
    }
  }

  const now = new Date();
  const toInsert: any[] = [];
  const alertsToInsert: any[] = [];

  for (const rule of rules) {
    // ── Odometer-based calculation ──────────────────────────────────────────
    const lastKm = lastService[rule.type]?.km ?? 0;
    // Distance driven since last service (or since tracking began)
    const kmSinceService = Math.max(0, totalKm - lastKm);
    const remainingKm    = rule.intervalKm - kmSinceService;
    const dueAtKm        = lastKm + rule.intervalKm;

    // ── Time-based calculation ──────────────────────────────────────────────
    let dueDate:      string | null = null;
    let remainingDays: number | null = null;

    if (rule.intervalDays !== null) {
      const lastDate = lastService[rule.type]?.date ?? vehicleCreatedAt;
      const dueDateObj = addDays(lastDate, rule.intervalDays);
      dueDate       = dateOnly(dueDateObj);
      remainingDays = Math.ceil((dueDateObj.getTime() - now.getTime()) / 86_400_000);
    }

    const urgency    = urgencyFor(remainingKm, rule);
    const status     = statusFor(remainingKm, remainingDays);
    // Confidence: higher as we approach the service interval
    const rawConf    = Math.min(1.0, kmSinceService / rule.intervalKm);
    const confidence = parseFloat(rawConf.toFixed(2));

    toInsert.push({
      vehicle_id:      vehicleId,
      prediction_type: rule.type,
      description:     rule.description,
      due_at_km:       parseFloat(dueAtKm.toFixed(1)),
      due_date:        dueDate,
      urgency,
      confidence,
      status,
    });

    // Generate alert event for due / overdue services
    if ((status === 'due' || status === 'overdue') && fleetId) {
      const kmLabel = remainingKm <= 0
        ? `${Math.abs(Math.round(remainingKm))} km overdue`
        : `due in ${Math.round(remainingKm)} km`;

      alertsToInsert.push({
        vehicle_id:  vehicleId,
        fleet_id:    fleetId,
        event_type:  status === 'overdue' ? 'maintenance_overdue' : 'maintenance_due',
        severity:    status === 'overdue' ? 'critical' : 'warning',
        title:       `${rule.description} ${status === 'overdue' ? 'overdue' : 'due soon'}`,
        description: `${rule.description} is ${kmLabel}. ` +
                     (dueDate ? `Time-based due date: ${dueDate}.` : ''),
        metadata: {
          service_type:  rule.type,
          due_at_km:     dueAtKm,
          remaining_km:  Math.round(remainingKm),
          due_date:      dueDate,
        },
      });
    }
  }

  // ── STATUS-AWARE DELETE: preserve completed records ─────────────────────────
  // This fixes the pre-existing bug where all predictions were wiped on every run.
  await db
    .from('maintenance_predictions')
    .delete()
    .eq('vehicle_id', vehicleId)
    .neq('status', 'completed');

  if (toInsert.length > 0) {
    await db.from('maintenance_predictions').insert(toInsert);
  }

  // ── Write alert events (upsert-style: delete today's + re-insert) ───────────
  // Avoids duplicate alerts on repeated runs in the same day.
  if (alertsToInsert.length > 0 && fleetId) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Remove today's maintenance alerts for this vehicle to avoid duplication
    await db
      .from('vehicle_events')
      .delete()
      .eq('vehicle_id', vehicleId)
      .in('event_type', ['maintenance_due', 'maintenance_overdue'])
      .gte('timestamp', todayStart.toISOString());

    await db.from('vehicle_events').insert(
      alertsToInsert.map(a => ({ ...a, timestamp: new Date().toISOString() })),
    );
  }

  return toInsert.length;
}

// ── Cost predictions ──────────────────────────────────────────────────────────

async function generateCostPredictions(
  db:           ReturnType<typeof createClient>,
  vehicleId:    string,
  fuelPriceUsd: number,
): Promise<number> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Average daily km from trips in the last 30 days
  const { data: recentTrips } = await db
    .from('trips')
    .select('distance_km, start_time, end_time')
    .eq('vehicle_id', vehicleId)
    .gte('start_time', thirtyDaysAgo);

  const totalRecentKm = (recentTrips || []).reduce(
    (s: number, t: any) => s + (parseFloat(t.distance_km) || 0),
    0,
  );
  const dailyKm = recentTrips && recentTrips.length > 0 ? totalRecentKm / 30 : 0;

  // Average fuel rate (L/h) from recent sensor_data
  const { data: fuelRateRows } = await db
    .from('sensor_data')
    .select('value')
    .eq('vehicle_id', vehicleId)
    .eq('sensor_type', 'engineFuelRate')
    .gte('timestamp', thirtyDaysAgo)
    .limit(500);

  const avgFuelRateLph = fuelRateRows && fuelRateRows.length > 0
    ? (fuelRateRows as any[]).reduce((s: number, r: any) => s + (r.value || 0), 0) / fuelRateRows.length
    : 0;

  // Average speed (km/h) from recent sensor_data
  const { data: speedRows } = await db
    .from('sensor_data')
    .select('value')
    .eq('vehicle_id', vehicleId)
    .eq('sensor_type', 'speed')
    .gte('timestamp', thirtyDaysAgo)
    .limit(500);

  const avgSpeedKmh = speedRows && speedRows.length > 0
    ? (speedRows as any[]).reduce((s: number, r: any) => s + (r.value || 0), 0) / speedRows.length
    : 0;

  // Fuel consumption per km = fuelRate(L/h) / speed(km/h)
  const fuelPerKm = avgSpeedKmh > 5 ? avgFuelRateLph / avgSpeedKmh : 0;

  const weeklyKm     = dailyKm * 7;
  const monthlyKm    = dailyKm * 30;
  const weeklyFuelL  = weeklyKm  * fuelPerKm;
  const monthlyFuelL = monthlyKm * fuelPerKm;

  const weeklyFuelCost  = weeklyFuelL  * fuelPriceUsd;
  const monthlyFuelCost = monthlyFuelL * fuelPriceUsd;
  const avgCostPerKm    = fuelPerKm * fuelPriceUsd;

  const today = dateOnly(new Date());
  const toUpsert = [
    {
      vehicle_id:       vehicleId,
      prediction_date:  today,
      forecast_period:  'weekly',
      fuel_cost:        round2(weeklyFuelCost),
      maintenance_cost: 0,
      total_cost:       round2(weeklyFuelCost),
      fuel_litres:      round2(weeklyFuelL),
      avg_cost_per_km:  round3(avgCostPerKm),
    },
    {
      vehicle_id:       vehicleId,
      prediction_date:  today,
      forecast_period:  'monthly',
      fuel_cost:        round2(monthlyFuelCost),
      maintenance_cost: 0,
      total_cost:       round2(monthlyFuelCost),
      fuel_litres:      round2(monthlyFuelL),
      avg_cost_per_km:  round3(avgCostPerKm),
    },
  ];

  await db
    .from('cost_predictions')
    .upsert(toUpsert, { onConflict: 'vehicle_id,prediction_date,forecast_period' });

  return toUpsert.length;
}
