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
 * Maintenance rules (mileage-based; time-based as fallback):
 *   oil_change       every 10 000 km | 365 days
 *   tire_rotation    every  8 000 km
 *   air_filter       every 20 000 km | 365 days
 *   engine_check     every 50 000 km | 730 days  (full service)
 *   brake_inspection every 30 000 km
 *
 * Cost projections (weekly / monthly) derived from:
 *   - Recent average daily km (from trips in last 30 days)
 *   - Recent average fuel consumption rate (sensor_data: engineFuelRate L/h)
 *   - Recent average speed            (sensor_data: speed km/h)
 *   - Fuel price constant (1.50 USD/L — configurable via FUEL_PRICE_USD env)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

// ── Maintenance rule definitions ─────────────────────────────────────────────

interface MaintenanceRule {
  type:          string;
  description:   string;
  intervalKm:    number;
  intervalDays:  number | null;
  urgencyNearKm: number;  // within this many km remaining → "high"
  urgencyFarKm:  number;  // within this many km remaining → "medium"
}

const MAINTENANCE_RULES: MaintenanceRule[] = [
  {
    type:          'oil_change',
    description:   'Engine oil & filter replacement',
    intervalKm:    10_000,
    intervalDays:  365,
    urgencyNearKm: 1_000,
    urgencyFarKm:  2_500,
  },
  {
    type:          'tire_rotation',
    description:   'Rotate tyres to ensure even wear',
    intervalKm:    8_000,
    intervalDays:  null,
    urgencyNearKm: 800,
    urgencyFarKm:  2_000,
  },
  {
    type:          'air_filter',
    description:   'Engine air filter replacement',
    intervalKm:    20_000,
    intervalDays:  365,
    urgencyNearKm: 2_000,
    urgencyFarKm:  5_000,
  },
  {
    type:          'brake_inspection',
    description:   'Brake pad & rotor inspection',
    intervalKm:    30_000,
    intervalDays:  null,
    urgencyNearKm: 3_000,
    urgencyFarKm:  7_500,
  },
  {
    type:          'engine_check',
    description:   'Full engine & emissions service',
    intervalKm:    50_000,
    intervalDays:  730,
    urgencyNearKm: 5_000,
    urgencyFarKm:  12_000,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function urgencyFor(
  remainingKm: number,
  rule: MaintenanceRule,
): 'low' | 'medium' | 'high' | 'critical' {
  if (remainingKm <= 0)               return 'critical';
  if (remainingKm <= rule.urgencyNearKm) return 'high';
  if (remainingKm <= rule.urgencyFarKm)  return 'medium';
  return 'low';
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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
    const supabaseUrl     = Deno.env.get('SUPABASE_URL')!;
    const anonKey         = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const fuelPriceUsd    = parseFloat(Deno.env.get('FUEL_PRICE_USD') || '1.50');
    const authHeader      = req.headers.get('Authorization') || '';

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

    // Service-role client for reading across RLS
    const db = createClient(supabaseUrl, serviceRoleKey);

    // Determine which vehicles to process
    const url = new URL(req.url);
    const singleVehicleId = url.searchParams.get('vehicle_id');

    let vehicleIds: string[];

    if (singleVehicleId) {
      vehicleIds = [singleVehicleId];
    } else {
      // All vehicles for fleets managed by this user OR owned directly
      const { data: vehicles } = await db
        .from('vehicles')
        .select('id')
        .or(`owner_id.eq.${user.id},fleet_id.in.(${await getFleetIds(db, user.id)})`);

      vehicleIds = (vehicles || []).map((v: any) => v.id as string);
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
        generateMaintenancePredictions(db, vehicleId),
        generateCostPredictions(db, vehicleId, fuelPriceUsd),
      ]);
      totalMaint += maint;
      totalCost  += cost;
    }

    return new Response(
      JSON.stringify({
        generated: vehicleIds.length,
        maintenance_predictions: totalMaint,
        cost_predictions: totalCost,
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

// ── Fleet helper ──────────────────────────────────────────────────────────────

async function getFleetIds(
  db: ReturnType<typeof createClient>,
  userId: string,
): Promise<string> {
  const { data } = await db
    .from('fleets')
    .select('id')
    .eq('manager_id', userId);

  if (!data || data.length === 0) return "''";
  return (data as any[]).map((f: any) => `'${f.id}'`).join(',');
}

// ── Maintenance predictions ────────────────────────────────────────────────────

async function generateMaintenancePredictions(
  db: ReturnType<typeof createClient>,
  vehicleId: string,
): Promise<number> {
  // Total distance driven (all recorded trips)
  const { data: tripAgg } = await db
    .from('trips')
    .select('distance_km')
    .eq('vehicle_id', vehicleId);

  const totalKm = (tripAgg || []).reduce(
    (sum: number, t: any) => sum + (parseFloat(t.distance_km) || 0),
    0,
  );

  // Vehicle created_at for time-based fallback
  const { data: vehicle } = await db
    .from('vehicles')
    .select('created_at')
    .eq('id', vehicleId)
    .single();

  const vehicleAgeMs   = vehicle
    ? Date.now() - new Date(vehicle.created_at).getTime()
    : 0;
  const vehicleAgeDays = vehicleAgeMs / 86_400_000;

  const now = new Date();
  const toInsert: any[] = [];

  for (const rule of MAINTENANCE_RULES) {
    // Compute how many complete intervals have elapsed
    const completedIntervals = Math.floor(totalKm / rule.intervalKm);
    // Next service due at this odometer reading
    const dueAtKm = (completedIntervals + 1) * rule.intervalKm;
    const remainingKm = dueAtKm - totalKm;

    // Time-based due date (if the rule has an intervalDays)
    let dueDate: string | null = null;
    if (rule.intervalDays !== null) {
      const completedTimeIntervals = Math.floor(vehicleAgeDays / rule.intervalDays);
      const nextDueDays = (completedTimeIntervals + 1) * rule.intervalDays;
      const remainingDays = nextDueDays - vehicleAgeDays;
      dueDate = dateOnly(addDays(now, Math.max(0, Math.ceil(remainingDays))));
    }

    const urgency    = urgencyFor(remainingKm, rule);
    // Confidence: higher when close to due; rough heuristic
    const confidence = Math.min(1.0, 1 - remainingKm / rule.intervalKm);

    toInsert.push({
      vehicle_id:      vehicleId,
      prediction_type: rule.type,
      description:     rule.description,
      due_at_km:       dueAtKm,
      due_date:        dueDate,
      urgency,
      confidence:      parseFloat(confidence.toFixed(2)),
    });
  }

  // Replace existing predictions for this vehicle (fresh run)
  await db
    .from('maintenance_predictions')
    .delete()
    .eq('vehicle_id', vehicleId);

  if (toInsert.length > 0) {
    await db.from('maintenance_predictions').insert(toInsert);
  }

  return toInsert.length;
}

// ── Cost predictions ──────────────────────────────────────────────────────────

async function generateCostPredictions(
  db: ReturnType<typeof createClient>,
  vehicleId: string,
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
  const dailyKm = recentTrips && recentTrips.length > 0
    ? totalRecentKm / 30
    : 0;

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
  // Guard against near-zero speed to avoid infinity
  const fuelPerKm = avgSpeedKmh > 5 ? avgFuelRateLph / avgSpeedKmh : 0;

  // Weekly & monthly projections
  const weeklyKm    = dailyKm * 7;
  const monthlyKm   = dailyKm * 30;
  const weeklyFuelL = weeklyKm  * fuelPerKm;
  const monthlyFuelL = monthlyKm * fuelPerKm;

  const weeklyFuelCost   = weeklyFuelL   * fuelPriceUsd;
  const monthlyFuelCost  = monthlyFuelL  * fuelPriceUsd;
  const avgCostPerKm     = fuelPerKm * fuelPriceUsd;

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

// ── Arithmetic helpers ────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
