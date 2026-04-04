import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

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
    const pathParts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && pathParts.length === 0) {
      const vehicleId = url.searchParams.get('vehicle_id');
      const acknowledged = url.searchParams.get('acknowledged');
      const severity = url.searchParams.get('severity');
      const limit = parseInt(url.searchParams.get('limit') || '100');

      let query = supabase
        .from('alerts')
        .select('*, vehicles(name, vin)')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (vehicleId) query = query.eq('vehicle_id', vehicleId);
      if (acknowledged !== null) query = query.eq('acknowledged', acknowledged === 'true');
      if (severity) query = query.eq('severity', severity);

      const { data, error } = await query;

      if (error) throw error;

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (req.method === 'PUT' && pathParts.length === 1) {
      const alertId = pathParts[0];
      const { acknowledged } = await req.json();

      const { data, error } = await supabase
        .from('alerts')
        .update({
          acknowledged,
          acknowledged_at: acknowledged ? new Date().toISOString() : null,
          acknowledged_by: acknowledged ? user.id : null,
        })
        .eq('id', alertId)
        .select()
        .single();

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
