import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, X-API-Key',
};

interface SensorReading {
  vehicle_id: string;
  sensor_type: string;
  value: number;
  unit: string;
  timestamp?: string;
}

// ── API key helpers ──────────────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function unauthorized(msg = 'Unauthorized') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl      = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey  = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authHeader       = req.headers.get('Authorization') || '';
    const rawKey           = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : '';

    let supabase: ReturnType<typeof createClient>;
    let apiKeyFleetId: string | null = null;

    if (rawKey.startsWith('vs_')) {
      // ── API-key path ─────────────────────────────────────────────────────
      const keyHash = await sha256Hex(rawKey);

      const serviceClient = createClient(supabaseUrl, serviceRoleKey);
      const { data: apiKey } = await serviceClient
        .from('api_keys')
        .select('fleet_id, is_active, expires_at')
        .eq('key_hash', keyHash)
        .maybeSingle();

      if (!apiKey || !apiKey.is_active) {
        return unauthorized('Invalid or inactive API key');
      }
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        return unauthorized('API key has expired');
      }

      apiKeyFleetId = apiKey.fleet_id as string;
      // Use service-role client; access is scoped to the fleet below.
      supabase = serviceClient;
    } else {
      // ── Session-JWT path ─────────────────────────────────────────────────
      supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        return unauthorized();
      }
    }

    const url = new URL(req.url);

    // ── POST /sensor-api — ingest one reading ─────────────────────────────
    if (req.method === 'POST') {
      const reading: SensorReading = await req.json();

      // Validate required fields and types
      if (
        !reading.vehicle_id || typeof reading.vehicle_id !== 'string' ||
        !reading.sensor_type || typeof reading.sensor_type !== 'string' ||
        typeof reading.value !== 'number' || !isFinite(reading.value) ||
        !reading.unit || typeof reading.unit !== 'string'
      ) {
        return new Response(
          JSON.stringify({ error: 'Invalid reading: vehicle_id, sensor_type (string), value (finite number), and unit are required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // When authenticated via API key, verify the vehicle belongs to the key's fleet
      if (apiKeyFleetId) {
        const { data: vehicle } = await supabase
          .from('vehicles')
          .select('id')
          .eq('id', reading.vehicle_id)
          .eq('fleet_id', apiKeyFleetId)
          .maybeSingle();

        if (!vehicle) {
          return new Response(
            JSON.stringify({ error: 'vehicle_id does not belong to this API key\'s fleet' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
      }

      // ── REAL-TIME ANOMALY DETECTION ENGINE ──────────────────────────────
      const { data: recentHistory } = await supabase
        .from('sensor_data')
        .select('value')
        .eq('vehicle_id', reading.vehicle_id)
        .eq('sensor_type', reading.sensor_type)
        .order('timestamp', { ascending: false })
        .limit(10);

      let isAnomaly = false;
      let anomalyMessage = '';

      if (recentHistory && recentHistory.length >= 5) {
        const values = recentHistory.map((h: any) => h.value as number);
        const mean   = values.reduce((a: number, b: number) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(
          values.map((x: number) => Math.pow(x - mean, 2)).reduce((a: number, b: number) => a + b, 0) / values.length,
        );

        if (stdDev > mean * 0.05 && Math.abs(reading.value - mean) > 3 * stdDev) {
          isAnomaly = true;
          anomalyMessage =
            `AI detected abnormal jump in ${reading.sensor_type}: ` +
            `${reading.value}${reading.unit} (Expected: ~${mean.toFixed(1)}${reading.unit})`;
        }
      }

      const { data, error } = await supabase
        .from('sensor_data')
        .insert(reading)
        .select()
        .single();

      if (error) throw error;

      if (isAnomaly) {
        await supabase.from('alerts').insert({
          vehicle_id:  reading.vehicle_id,
          sensor_type: reading.sensor_type,
          value:       reading.value,
          severity:    'warning',
          message:     anomalyMessage,
        });
      }

      // ── Standard Threshold Check ────────────────────────────────────────
      // Look up vehicle's fleet so fleet-level thresholds are also matched.
      const { data: vehicleRow } = await supabase
        .from('vehicles')
        .select('fleet_id')
        .eq('id', reading.vehicle_id)
        .maybeSingle();

      const fleetId = (vehicleRow as { fleet_id?: string } | null)?.fleet_id ?? null;

      // Single query: vehicle-specific threshold OR fleet-wide fallback.
      // Vehicle-specific is preferred and resolved in JS below.
      let thresholdQuery = supabase
        .from('thresholds')
        .select('*')
        .eq('sensor_type', reading.sensor_type)
        .eq('alert_enabled', true);

      if (fleetId) {
        thresholdQuery = thresholdQuery.or(
          `vehicle_id.eq.${reading.vehicle_id},and(fleet_id.eq.${fleetId},vehicle_id.is.null)`,
        );
      } else {
        thresholdQuery = thresholdQuery.eq('vehicle_id', reading.vehicle_id);
      }

      const { data: thresholdRows } = await thresholdQuery;

      // Vehicle-specific threshold wins over fleet-wide default.
      const thresholds = thresholdRows?.find(
        (t: { vehicle_id: string | null }) => t.vehicle_id === reading.vehicle_id,
      ) ?? thresholdRows?.[0] ?? null;

      if (thresholds) {
        const { min_value, max_value, id: threshold_id } = thresholds;
        let alertTriggered = false;
        let severity = 'info';
        let message  = '';

        if (max_value !== null && reading.value > max_value) {
          alertTriggered = true;
          severity = reading.value > max_value * 1.2 ? 'critical' : 'warning';
          message  = `${reading.sensor_type} exceeded maximum: ${reading.value}${reading.unit} (max: ${max_value}${reading.unit})`;
        } else if (min_value !== null && reading.value < min_value) {
          alertTriggered = true;
          severity = reading.value < min_value * 0.8 ? 'critical' : 'warning';
          message  = `${reading.sensor_type} below minimum: ${reading.value}${reading.unit} (min: ${min_value}${reading.unit})`;
        }

        if (alertTriggered) {
          await supabase.from('alerts').insert({
            vehicle_id:   reading.vehicle_id,
            sensor_type:  reading.sensor_type,
            threshold_id,
            value:        reading.value,
            severity,
            message,
          });
        }
      }

      return new Response(JSON.stringify(data), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── GET /sensor-api — query historical readings ───────────────────────
    if (req.method === 'GET') {
      const vehicleId  = url.searchParams.get('vehicle_id');
      const sensorType = url.searchParams.get('sensor_type');
      const startDate  = url.searchParams.get('start_date');
      const endDate    = url.searchParams.get('end_date');
      const limit      = parseInt(url.searchParams.get('limit') || '1000');

      // API-key callers may only query their own fleet's vehicles
      if (apiKeyFleetId && vehicleId) {
        const { data: vehicle } = await supabase
          .from('vehicles')
          .select('id')
          .eq('id', vehicleId)
          .eq('fleet_id', apiKeyFleetId)
          .maybeSingle();

        if (!vehicle) {
          return new Response(
            JSON.stringify({ error: 'vehicle_id does not belong to this API key\'s fleet' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
      }

      let query = supabase
        .from('sensor_data')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (vehicleId)  query = query.eq('vehicle_id', vehicleId);
      if (sensorType) query = query.eq('sensor_type', sensorType);
      if (startDate)  query = query.gte('timestamp', startDate);
      if (endDate)    query = query.lte('timestamp', endDate);

      const { data, error } = await query;
      if (error) throw error;

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
