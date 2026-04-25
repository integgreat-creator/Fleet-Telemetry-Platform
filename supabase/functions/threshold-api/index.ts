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

    // ── GET ────────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const vehicleId = url.searchParams.get('vehicle_id');
      const fleetId   = url.searchParams.get('fleet_id');

      let query = supabase.from('thresholds').select('*');
      if (vehicleId) query = query.eq('vehicle_id', vehicleId);
      else if (fleetId) query = query.eq('fleet_id', fleetId).is('vehicle_id', null);

      const { data, error } = await query;
      if (error) throw error;
      return json(data);
    }

    // ── POST ───────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const { sensor_type, min_value, max_value, alert_enabled, vehicle_id, fleet_id } = body;

      if (!sensor_type) return err('sensor_type is required');
      if (!vehicle_id && !fleet_id) return err('vehicle_id or fleet_id is required');

      const payload = {
        sensor_type,
        min_value:     min_value     ?? null,
        max_value:     max_value     ?? null,
        alert_enabled: alert_enabled ?? true,
        updated_at:    new Date().toISOString(),
      };

      let data, error;

      if (vehicle_id) {
        // Vehicle-level: upsert on (vehicle_id, sensor_type) unique index
        ({ data, error } = await supabase
          .from('thresholds')
          .upsert(
            { ...payload, vehicle_id, fleet_id: null },
            { onConflict: 'vehicle_id,sensor_type' },
          )
          .select()
          .single());
      } else {
        // Fleet-level: delete existing row + insert fresh (partial index upsert
        // isn't directly supported by PostgREST without a named constraint)
        await supabase
          .from('thresholds')
          .delete()
          .eq('fleet_id', fleet_id)
          .eq('sensor_type', sensor_type)
          .is('vehicle_id', null);

        ({ data, error } = await supabase
          .from('thresholds')
          .insert({ ...payload, fleet_id, vehicle_id: null })
          .select()
          .single());
      }

      if (error) return err(error.message);
      return json(data, 201);
    }

    return err('Method not allowed', 405);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
