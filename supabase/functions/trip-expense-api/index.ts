/**
 * trip-expense-api edge function
 *
 * Manages per-trip revenue and expense data for profit tracking.
 *
 * GET  ?trip_id=<uuid>
 *   → returns { trip, expenses, revenue } for one trip
 *
 * GET  ?action=summary[&days=30]
 *   → returns { daily: [...], vehicles: [...] } profit summaries
 *
 * POST { action: 'upsert-expenses', trip_id, toll_cost?, driver_allowance?, other_cost?, notes? }
 *   → auto-calculates fuel_cost + maintenance_cost from trip distance + vehicle config
 *   → upserts trip_expenses row; profit synced by DB trigger
 *   → returns saved expense row
 *
 * POST { action: 'upsert-revenue', trip_id, amount, description? }
 *   → upserts trip_revenue row; profit synced by DB trigger
 *   → returns saved revenue row
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const _ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map(s => s.trim());
function makeCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow  = _ALLOWED.includes('*') || _ALLOWED.includes(origin) ? (origin || '*') : '';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = makeCors(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  const err = (msg: string, status = 400) => json({ error: msg }, status);

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return err('Unauthorized', 401);

    const url = new URL(req.url);

    // ── GET ───────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const action = url.searchParams.get('action');
      const tripId = url.searchParams.get('trip_id');

      // ── GET ?action=summary — fleet-level daily + vehicle profit rollup ────
      if (action === 'summary') {
        const days = parseInt(url.searchParams.get('days') || '30');

        const { data: fleet } = await supabase
          .from('fleets')
          .select('id')
          .eq('manager_id', user.id)
          .maybeSingle();

        if (!fleet) return json({ daily: [], vehicles: [] });

        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

        const [dailyRes, vehicleRes] = await Promise.all([
          supabase
            .from('daily_profit_summary')
            .select('*')
            .eq('fleet_id', fleet.id)
            .gte('date', cutoff.split('T')[0])
            .order('date', { ascending: false }),
          supabase
            .from('vehicle_profit_ranking')
            .select('*')
            .eq('fleet_id', fleet.id)
            .order('net_profit', { ascending: false }),
        ]);

        return json({
          daily:    dailyRes.data    ?? [],
          vehicles: vehicleRes.data  ?? [],
          fleet_id: fleet.id,
        });
      }

      // ── GET ?trip_id=<uuid> — single trip detail ──────────────────────────
      if (!tripId) return err('trip_id or action=summary is required');

      const [tripRes, expensesRes, revenueRes] = await Promise.all([
        supabase
          .from('trips')
          .select(`
            *,
            vehicles (
              id, name,
              fuel_price_per_litre, avg_km_per_litre,
              maintenance_cost_per_km, fuel_type
            )
          `)
          .eq('id', tripId)
          .single(),
        supabase.from('trip_expenses').select('*').eq('trip_id', tripId).maybeSingle(),
        supabase.from('trip_revenue').select('*').eq('trip_id', tripId).maybeSingle(),
      ]);

      if (tripRes.error) return err(tripRes.error.message, 404);

      // Build default expense estimate if no record saved yet
      const trip    = tripRes.data;
      const vehicle = (trip as any).vehicles;
      const distKm  = Number(trip.distance_km)           || 0;
      const fuelL   = Number(trip.fuel_consumed_litres)   || 0;
      const price   = Number(vehicle?.fuel_price_per_litre) || 100;
      const kmpl    = Number(vehicle?.avg_km_per_litre)    || 15;
      const cpm     = Number(vehicle?.maintenance_cost_per_km) || 2;

      const estimatedFuelCost  = fuelL > 0 ? fuelL * price : (distKm / kmpl) * price;
      const estimatedMaintCost = distKm * cpm;

      return json({
        trip,
        expenses: expensesRes.data ?? {
          fuel_cost:        Math.round(estimatedFuelCost  * 100) / 100,
          toll_cost:        0,
          driver_allowance: 0,
          maintenance_cost: Math.round(estimatedMaintCost * 100) / 100,
          other_cost:       0,
          notes:            '',
          _estimated:       true,   // flag so UI can show "auto-calculated"
        },
        revenue: revenueRes.data ?? { amount: 0, description: '', _estimated: true },
      });
    }

    // ── POST ──────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body   = await req.json();
      const { action, trip_id } = body;

      if (!trip_id)  return err('trip_id is required');
      if (!action)   return err('action is required');

      // Resolve trip + vehicle config (RLS enforces fleet ownership)
      const { data: trip, error: tripErr } = await supabase
        .from('trips')
        .select(`
          id, vehicle_id, distance_km, fuel_consumed_litres,
          vehicles ( fuel_price_per_litre, avg_km_per_litre, maintenance_cost_per_km )
        `)
        .eq('id', trip_id)
        .single();

      if (tripErr || !trip) return err('Trip not found or access denied', 404);

      const v       = (trip as any).vehicles;
      const distKm  = Number(trip.distance_km)         || 0;
      const fuelL   = Number(trip.fuel_consumed_litres) || 0;
      const price   = Number(v?.fuel_price_per_litre)   || 100;
      const kmpl    = Number(v?.avg_km_per_litre)       || 15;
      const cpm     = Number(v?.maintenance_cost_per_km) || 2;

      // ── action: upsert-expenses ───────────────────────────────────────────
      if (action === 'upsert-expenses') {
        const tollCost       = Math.max(0, Number(body.toll_cost        ?? 0));
        const driverAllowance = Math.max(0, Number(body.driver_allowance ?? 0));
        const otherCost      = Math.max(0, Number(body.other_cost       ?? 0));
        const notes          = String(body.notes ?? '').slice(0, 500);

        // Auto-calculate fuel + maintenance from trip telemetry
        const fuelCost  = Math.round((fuelL > 0 ? fuelL * price : (distKm / kmpl) * price) * 100) / 100;
        const maintCost = Math.round(distKm * cpm * 100) / 100;

        const { data, error } = await supabase
          .from('trip_expenses')
          .upsert(
            {
              trip_id,
              vehicle_id:       trip.vehicle_id,
              fuel_cost:        fuelCost,
              toll_cost:        tollCost,
              driver_allowance: driverAllowance,
              maintenance_cost: maintCost,
              other_cost:       otherCost,
              notes,
              updated_at:       new Date().toISOString(),
            },
            { onConflict: 'trip_id' },
          )
          .select()
          .single();

        if (error) return err(error.message);
        return json(data, 201);
      }

      // ── action: upsert-revenue ────────────────────────────────────────────
      if (action === 'upsert-revenue') {
        const amount = Number(body.amount ?? 0);
        if (isNaN(amount) || amount < 0) return err('amount must be a non-negative number');
        const description = String(body.description ?? '').slice(0, 500);

        const { data, error } = await supabase
          .from('trip_revenue')
          .upsert(
            {
              trip_id,
              vehicle_id:  trip.vehicle_id,
              amount:      Math.round(amount * 100) / 100,
              description,
              updated_at:  new Date().toISOString(),
            },
            { onConflict: 'trip_id' },
          )
          .select()
          .single();

        if (error) return err(error.message);
        return json(data, 201);
      }

      return err('Unknown action');
    }

    return err('Method not allowed', 405);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
