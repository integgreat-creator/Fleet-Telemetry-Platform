import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

interface SensorReading {
  vehicle_id: string;
  sensor_type: string;
  value: number;
  unit: string;
  timestamp?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const authHeader = req.headers.get('Authorization');

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader || '' } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);

    if (req.method === 'POST') {
      const reading: SensorReading = await req.json();

      // ── REAL-TIME ANOMALY DETECTION ENGINE ────────────────────────
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
        const values = recentHistory.map(h => h.value);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const stdDev = Math.sqrt(values.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / values.length);

        // Z-Score Anomaly Detection: Trigger if reading is > 3 standard deviations from mean
        // and ignore if stdDev is too small (avoid noise in static values)
        if (stdDev > (mean * 0.05) && Math.abs(reading.value - mean) > 3 * stdDev) {
          isAnomaly = true;
          anomalyMessage = `AI detected abnormal jump in ${reading.sensor_type}: ${reading.value}${reading.unit} (Expected: ~${mean.toFixed(1)}${reading.unit})`;
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
          vehicle_id: reading.vehicle_id,
          sensor_type: reading.sensor_type,
          value: reading.value,
          severity: 'warning',
          message: anomalyMessage,
        });
      }

      // Standard Threshold Check
      const { data: thresholds } = await supabase
        .from('thresholds')
        .select('*')
        .eq('vehicle_id', reading.vehicle_id)
        .eq('sensor_type', reading.sensor_type)
        .eq('alert_enabled', true)
        .maybeSingle();

      if (thresholds) {
        const { min_value, max_value, id: threshold_id } = thresholds;
        let alertTriggered = false;
        let severity = 'info';
        let message = '';

        if (max_value !== null && reading.value > max_value) {
          alertTriggered = true;
          severity = reading.value > max_value * 1.2 ? 'critical' : 'warning';
          message = `${reading.sensor_type} exceeded maximum: ${reading.value}${reading.unit} (max: ${max_value}${reading.unit})`;
        } else if (min_value !== null && reading.value < min_value) {
          alertTriggered = true;
          severity = reading.value < min_value * 0.8 ? 'critical' : 'warning';
          message = `${reading.sensor_type} below minimum: ${reading.value}${reading.unit} (min: ${min_value}${reading.unit})`;
        }

        if (alertTriggered) {
          await supabase.from('alerts').insert({
            vehicle_id: reading.vehicle_id,
            sensor_type: reading.sensor_type,
            threshold_id,
            value: reading.value,
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

    if (req.method === 'GET') {
      const vehicleId = url.searchParams.get('vehicle_id');
      const sensorType = url.searchParams.get('sensor_type');
      const startDate = url.searchParams.get('start_date');
      const endDate = url.searchParams.get('end_date');
      const limit = parseInt(url.searchParams.get('limit') || '1000');

      let query = supabase
        .from('sensor_data')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(limit);

      if (vehicleId) query = query.eq('vehicle_id', vehicleId);
      if (sensorType) query = query.eq('sensor_type', sensorType);
      if (startDate) query = query.gte('timestamp', startDate);
      if (endDate) query = query.lte('timestamp', endDate);

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
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
