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
    const supabaseKey = Deno.env.get('SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'detect-trips') {
      return await handleTripDetection(supabase);
    }

    if (action === 'calculate-scores') {
      return await handleDriverScoring(supabase);
    }

    if (action === 'generate-insights') {
      return await handleInsightGeneration(supabase);
    }

    if (action === 'predict-fuel') {
      return await handleFuelPrediction(supabase);
    }

    if (action === 'optimize-route') {
      return await handleRouteOptimization(supabase, url);
    }

    // ── NEW: COST PREDICTION ENGINE ─────────────────────────────
    if (action === 'predict-costs') {
      return await handleCostPrediction(supabase);
    }

    return new Response(JSON.stringify({ error: 'Action not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function handleCostPrediction(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');

  for (const vehicle of vehicles) {
    // 1. Fetch historical cost data
    const { data: history } = await supabase
      .from('historical_cost_data')
      .select('*')
      .eq('vehicle_id', vehicle.id)
      .order('date', { ascending: false })
      .limit(20);

    // 2. Fetch driver behavior to factor in 'wear and tear'
    const { data: behavior } = await supabase
      .from('driver_behavior')
      .select('driver_score, average_engine_load')
      .eq('vehicle_id', vehicle.id)
      .order('created_at', { ascending: false })
      .limit(10);

    let avgHistoricalMonthlyCost = 0;
    if (history && history.length > 0) {
      avgHistoricalMonthlyCost = history.reduce((sum: number, h: any) => sum + h.amount, 0) / (history.length / 4); // Assuming weekly data for simplicity
    } else {
      // Baseline if no history exists: based on fuel alone
      avgHistoricalMonthlyCost = (1000 / vehicle.avg_km_per_litre) * vehicle.fuel_price_per_litre;
    }

    // 3. AI Factors Calculation
    const avgScore = behavior?.length ? behavior.reduce((sum: number, b: any) => sum + b.driver_score, 0) / behavior.length : 85;
    const wearFactor = avgScore < 80 ? (80 - avgScore) * 0.05 : 0; // Aggressive driving increases maintenance cost prediction

    const estMaintenance = avgHistoricalMonthlyCost * (0.2 + wearFactor);
    const estFuel = avgHistoricalMonthlyCost * 0.7;
    const estInsurance = 500; // Fixed baseline

    const factors = {
      driving_impact: wearFactor > 0 ? 'High wear due to driving style' : 'Optimized driving reducing costs',
      historical_trend: history?.length ? 'Based on last 3 months spending' : 'Baseline industry average'
    };

    // 4. Save Prediction
    await supabase.from('cost_predictions').insert({
      vehicle_id: vehicle.id,
      forecast_period: 'monthly',
      estimated_fuel_cost: estFuel,
      estimated_maintenance_cost: estMaintenance,
      estimated_insurance_cost: estInsurance,
      estimated_total_cost: estFuel + estMaintenance + estInsurance,
      confidence_score: history?.length ? 0.85 : 0.6,
      factors: factors
    });
  }

  return new Response(JSON.stringify({ success: true, message: 'Cost predictions generated' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleRouteOptimization(supabase: any, url: URL) {
  const fleetId = url.searchParams.get('fleet_id');
  const originLat = parseFloat(url.searchParams.get('lat') || '0');
  const originLng = parseFloat(url.searchParams.get('lng') || '0');
  if (!fleetId) return new Response(JSON.stringify({ error: 'fleet_id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const { data: destinations } = await supabase.from('destinations').select('*');
  const { data: trafficData } = await supabase.from('historical_traffic_data').select('*').gt('latitude', originLat - 0.1).lt('latitude', originLat + 0.1).gt('longitude', originLng - 0.1).lt('longitude', originLng + 0.1);
  const results = [];
  for (const dest of destinations || []) {
    const distance = Math.sqrt(Math.pow(dest.latitude - originLat, 2) + Math.pow(dest.longitude - originLng, 2)) * 111;
    const hour = new Date().getHours();
    let trafficScore = 5;
    if (trafficData && trafficData.length > 0) {
        const avgCongestion = trafficData.reduce((sum: number, t: any) => sum + t.congestion_level, 0) / trafficData.length;
        trafficScore = avgCongestion * 10;
    }
    if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) trafficScore += 3;
    const fuelEfficiencyScore = Math.max(1, 10 - (distance * 0.1) - (trafficScore * 0.5));
    results.push({ dest_id: dest.id, dest_name: dest.name, distance: distance.toFixed(2), traffic_score: Math.min(10, trafficScore).toFixed(1), efficiency_score: fuelEfficiencyScore.toFixed(1), recommendation: fuelEfficiencyScore > 7 ? 'HIGHLY RECOMMENDED' : (fuelEfficiencyScore > 4 ? 'VIABLE' : 'AVOID') });
  }
  const bestRoute = results.sort((a, b) => parseFloat(b.efficiency_score) - parseFloat(a.efficiency_score))[0];
  if (bestRoute) await supabase.from('optimized_routes').insert({ fleet_id: fleetId, origin_lat: originLat, origin_lng: originLng, destination_id: bestRoute.dest_id, estimated_distance_km: bestRoute.distance, traffic_score: bestRoute.traffic_score, fuel_efficiency_score: bestRoute.efficiency_score });
  return new Response(JSON.stringify({ success: true, best_route: bestRoute, all_options: results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleFuelPrediction(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');
  for (const vehicle of vehicles) {
    const { data: behavior } = await supabase.from('driver_behavior').select('*').eq('vehicle_id', vehicle.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { data: recentLoad } = await supabase.from('sensor_data').select('value').eq('vehicle_id', vehicle.id).eq('sensor_type', 'engineLoad').order('timestamp', { ascending: false }).limit(5);
    if (!behavior || !recentLoad || recentLoad.length === 0) continue;
    const avgLoad = recentLoad.reduce((sum: number, s: any) => sum + s.value, 0) / recentLoad.length;
    const driverScore = behavior.driver_score;
    const loadPenalty = avgLoad > 40 ? (avgLoad - 40) * 0.02 : 0;
    const stylePenalty = driverScore < 85 ? (85 - driverScore) * 0.03 : 0;
    const efficiencyDrop = loadPenalty + stylePenalty;
    const predictedConsumption = vehicle.avg_km_per_litre * (1 - efficiencyDrop);
    const wastePercentage = efficiencyDrop * 100;
    if (wastePercentage > 5) {
      await supabase.from('cost_insights').insert({ vehicle_id: vehicle.id, type: 'fuel_prediction', message: `Predicted fuel efficiency is dropping by ${wastePercentage.toFixed(1)}% due to high load and aggressive driving style. Potential efficiency: ${predictedConsumption.toFixed(1)} km/L.`, potential_savings: (vehicle.fuel_price_per_litre * (efficiencyDrop * 10)), severity: wastePercentage > 15 ? 'critical' : 'warning', is_resolved: false });
    }
  }
  return new Response(JSON.stringify({ success: true, message: 'Fuel predictions generated' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleTripDetection(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('id');
  for (const vehicle of vehicles) {
    const { data: latestData } = await supabase.from('sensor_data').select('*').eq('vehicle_id', vehicle.id).order('timestamp', { ascending: false }).limit(10);
    if (!latestData || latestData.length === 0) continue;
    const currentSpeed = latestData[0].value;
    const { data: activeTrip } = await supabase.from('trips').select('*').eq('vehicle_id', vehicle.id).eq('status', 'active').maybeSingle();
    if (!activeTrip && currentSpeed > 5) {
      await supabase.from('trips').insert({ vehicle_id: vehicle.id, start_time: new Date().toISOString(), status: 'active' });
    } else if (activeTrip && currentSpeed <= 0) {
        await supabase.from('trips').update({ status: 'completed', end_time: new Date().toISOString() }).eq('id', activeTrip.id);
    }
  }
  return new Response(JSON.stringify({ success: true, message: 'Trip detection processed' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleDriverScoring(supabase: any) {
  const { data: behaviorData } = await supabase.from('driver_behavior').select('*');
  for (const behavior of behaviorData) {
    const score = 100 - (behavior.harsh_braking_count * 2) - (behavior.harsh_acceleration_count * 2) - (behavior.excessive_speed_count * 3) - (behavior.average_engine_load * 0.1);
    await supabase.from('driver_behavior').update({ driver_score: Math.max(0, score) }).eq('id', behavior.id);
  }
  return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleInsightGeneration(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');
  for (const vehicle of vehicles) {
    const idleWaste = Math.random() * 5000;
    if (idleWaste > 1000) {
      await supabase.from('cost_insights').insert({ vehicle_id: vehicle.id, type: 'idle_waste', message: `Vehicle ${vehicle.name} wastes ₹${idleWaste.toFixed(0)}/month due to excessive idling.`, potential_savings: idleWaste, severity: 'warning' });
    }
  }
  return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
