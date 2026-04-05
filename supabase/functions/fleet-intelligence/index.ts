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
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;  // FIXED: was SERVICE_ROLE_KEY

    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'detect-trips') {
      return await handleTripDetection(supabase);
    }
    if (action === 'populate-behavior') {
      return await handlePopulateBehavior(supabase);
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

// ── NEW: Derive driver behavior events from raw sensor readings ──────────────
async function handlePopulateBehavior(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('id');
  if (!vehicles) return ok('No vehicles found');

  for (const vehicle of vehicles) {
    // Process active trips
    const { data: activeTrip } = await supabase
      .from('trips')
      .select('*')
      .eq('vehicle_id', vehicle.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!activeTrip) continue;

    const since = activeTrip.start_time;

    const [{ data: speedReadings }, { data: rpmReadings }, { data: loadReadings }, { data: throttleReadings }] =
      await Promise.all([
        supabase.from('sensor_data').select('value, timestamp').eq('vehicle_id', vehicle.id).eq('sensor_type', 'speed').gte('timestamp', since).order('timestamp', { ascending: true }).limit(500),
        supabase.from('sensor_data').select('value').eq('vehicle_id', vehicle.id).eq('sensor_type', 'rpm').gte('timestamp', since).limit(500),
        supabase.from('sensor_data').select('value').eq('vehicle_id', vehicle.id).eq('sensor_type', 'engineLoad').gte('timestamp', since).limit(500),
        supabase.from('sensor_data').select('value, timestamp').eq('vehicle_id', vehicle.id).eq('sensor_type', 'throttlePosition').gte('timestamp', since).order('timestamp', { ascending: true }).limit(500),
      ]);

    if (!speedReadings || speedReadings.length < 2) continue;

    let harshBraking = 0;
    let harshAcceleration = 0;

    for (let i = 1; i < speedReadings.length; i++) {
      const speedDiff = speedReadings[i].value - speedReadings[i - 1].value;
      const timeDiff = (new Date(speedReadings[i].timestamp).getTime() - new Date(speedReadings[i - 1].timestamp).getTime()) / 1000;
      if (timeDiff > 0 && timeDiff < 5) {
        const rate = speedDiff / timeDiff; // km/h per second
        if (rate < -10) harshBraking++;
        if (rate > 10) harshAcceleration++;
      }
    }

    const excessiveRpm = rpmReadings ? rpmReadings.filter((r: any) => r.value > 4000).length : 0;
    const excessiveSpeed = speedReadings.filter((r: any) => r.value > 120).length;
    const avgLoad = loadReadings && loadReadings.length > 0
      ? loadReadings.reduce((s: number, r: any) => s + r.value, 0) / loadReadings.length
      : 0;

    const score = Math.max(0, Math.min(100,
      100 - (harshBraking * 2) - (harshAcceleration * 2) - (excessiveSpeed * 3) - (avgLoad * 0.1)
    ));

    const { data: existing } = await supabase
      .from('driver_behavior')
      .select('id')
      .eq('vehicle_id', vehicle.id)
      .eq('trip_id', activeTrip.id)
      .maybeSingle();

    if (existing) {
      await supabase.from('driver_behavior').update({
        harsh_braking_count: harshBraking,
        harsh_acceleration_count: harshAcceleration,
        excessive_rpm_count: excessiveRpm,
        excessive_speed_count: excessiveSpeed,
        average_engine_load: Math.round(avgLoad * 10) / 10,
        driver_score: Math.round(score),
      }).eq('id', existing.id);
    } else {
      await supabase.from('driver_behavior').insert({
        vehicle_id: vehicle.id,
        trip_id: activeTrip.id,
        harsh_braking_count: harshBraking,
        harsh_acceleration_count: harshAcceleration,
        excessive_rpm_count: excessiveRpm,
        excessive_speed_count: excessiveSpeed,
        average_engine_load: Math.round(avgLoad * 10) / 10,
        driver_score: Math.round(score),
        trip_start: activeTrip.start_time,
      });
    }
  }

  return ok('Driver behavior populated from sensor data');
}

async function handleTripDetection(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('id');
  if (!vehicles) return ok('No vehicles');

  for (const vehicle of vehicles) {
    // Get latest speed reading
    const { data: latestSpeed } = await supabase
      .from('sensor_data')
      .select('value, timestamp')
      .eq('vehicle_id', vehicle.id)
      .eq('sensor_type', 'speed')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latestSpeed) continue;

    // Only act on recent readings (within last 2 minutes)
    const age = Date.now() - new Date(latestSpeed.timestamp).getTime();
    if (age > 2 * 60 * 1000) continue;

    const currentSpeed = latestSpeed.value;

    const { data: activeTrip } = await supabase
      .from('trips')
      .select('*')
      .eq('vehicle_id', vehicle.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!activeTrip && currentSpeed > 5) {
      // Start new trip
      await supabase.from('trips').insert({
        vehicle_id: vehicle.id,
        start_time: new Date().toISOString(),
        status: 'active',
        distance_km: 0,
        duration_minutes: 0,
        avg_speed_kmh: 0,
        fuel_consumed_litres: 0,
        idle_time_minutes: 0,
      });
    } else if (activeTrip && currentSpeed <= 2) {
      // Compute trip stats
      const startTime = new Date(activeTrip.start_time);
      const endTime = new Date();
      const durationMinutes = Math.round((endTime.getTime() - startTime.getTime()) / 60000);

      const { data: speedData } = await supabase
        .from('sensor_data')
        .select('value')
        .eq('vehicle_id', vehicle.id)
        .eq('sensor_type', 'speed')
        .gte('timestamp', activeTrip.start_time)
        .limit(1000);

      const { data: fuelData } = await supabase
        .from('sensor_data')
        .select('value')
        .eq('vehicle_id', vehicle.id)
        .eq('sensor_type', 'engineFuelRate')
        .gte('timestamp', activeTrip.start_time)
        .limit(1000);

      const avgSpeed = speedData && speedData.length > 0
        ? speedData.reduce((s: number, r: any) => s + r.value, 0) / speedData.length : 0;
      const idleCount = speedData ? speedData.filter((r: any) => r.value < 1).length : 0;
      const idleMinutes = Math.round((idleCount / Math.max(speedData?.length ?? 1, 1)) * durationMinutes);
      const distanceKm = Math.round((avgSpeed * durationMinutes) / 60 * 10) / 10;

      const avgFuelRate = fuelData && fuelData.length > 0
        ? fuelData.reduce((s: number, r: any) => s + r.value, 0) / fuelData.length : 0;
      const fuelConsumed = Math.round((avgFuelRate * durationMinutes / 60) * 100) / 100;

      await supabase.from('trips').update({
        status: 'completed',
        end_time: endTime.toISOString(),
        duration_minutes: durationMinutes,
        distance_km: distanceKm,
        avg_speed_kmh: Math.round(avgSpeed),
        fuel_consumed_litres: fuelConsumed,
        idle_time_minutes: idleMinutes,
      }).eq('id', activeTrip.id);
    }
  }

  return ok('Trip detection processed');
}

async function handleDriverScoring(supabase: any) {
  const { data: behaviorData } = await supabase.from('driver_behavior').select('*');
  if (!behaviorData) return ok('No behavior data');

  for (const behavior of behaviorData) {
    const score = Math.max(0, Math.min(100,
      100
      - (behavior.harsh_braking_count * 2)
      - (behavior.harsh_acceleration_count * 2)
      - (behavior.excessive_speed_count * 3)
      - (behavior.average_engine_load * 0.1)
    ));
    await supabase.from('driver_behavior').update({ driver_score: Math.round(score) }).eq('id', behavior.id);
  }

  return ok('Scores recalculated');
}

async function handleFuelPrediction(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');
  if (!vehicles) return ok('No vehicles');

  for (const vehicle of vehicles) {
    const { data: behavior } = await supabase
      .from('driver_behavior')
      .select('*')
      .eq('vehicle_id', vehicle.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: recentLoad } = await supabase
      .from('sensor_data')
      .select('value')
      .eq('vehicle_id', vehicle.id)
      .eq('sensor_type', 'engineLoad')
      .order('timestamp', { ascending: false })
      .limit(20);

    if (!recentLoad || recentLoad.length === 0) continue;

    const avgLoad = recentLoad.reduce((s: number, r: any) => s + r.value, 0) / recentLoad.length;
    const driverScore = behavior?.driver_score ?? 85;
    const loadPenalty = avgLoad > 40 ? (avgLoad - 40) * 0.02 : 0;
    const stylePenalty = driverScore < 85 ? (85 - driverScore) * 0.03 : 0;
    const efficiencyDrop = loadPenalty + stylePenalty;
    const wastePercentage = efficiencyDrop * 100;

    if (wastePercentage > 5) {
      const fuelPrice = vehicle.fuel_price_per_litre ?? 100;
      await supabase.from('cost_insights').insert({
        vehicle_id: vehicle.id,
        type: 'fuel_prediction',
        message: `Fuel efficiency dropping by ${wastePercentage.toFixed(1)}% due to ${avgLoad > 60 ? 'high engine load' : 'driving style'}. Predicted: ${((vehicle.avg_km_per_litre ?? 12) * (1 - efficiencyDrop)).toFixed(1)} km/L.`,
        potential_savings: Math.round(fuelPrice * efficiencyDrop * 10),
        severity: wastePercentage > 15 ? 'critical' : 'warning',
        is_resolved: false,
      });
    }
  }

  return ok('Fuel predictions generated');
}

async function handleInsightGeneration(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');
  if (!vehicles) return ok('No vehicles');

  for (const vehicle of vehicles) {
    // Idle waste: count speed=0 readings in last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: idleReadings } = await supabase
      .from('sensor_data')
      .select('value')
      .eq('vehicle_id', vehicle.id)
      .eq('sensor_type', 'speed')
      .gte('timestamp', since)
      .lt('value', 1);

    const idleMinutes = (idleReadings?.length ?? 0); // 1 reading ≈ 1 second → minutes / 60
    const idleHours = idleMinutes / 3600;
    const fuelPrice = vehicle.fuel_price_per_litre ?? 100;
    const idleWasteLitres = idleHours * 0.8; // ~0.8L/h at idle
    const idleWasteCost = idleWasteLitres * fuelPrice * 30; // monthly projection

    if (idleWasteCost > 500) {
      await supabase.from('cost_insights').insert({
        vehicle_id: vehicle.id,
        type: 'idle_waste',
        message: `${vehicle.name} has excessive idle time. Projected monthly fuel waste: ₹${idleWasteCost.toFixed(0)}.`,
        potential_savings: Math.round(idleWasteCost * 0.7),
        severity: idleWasteCost > 2000 ? 'critical' : 'warning',
        is_resolved: false,
      });
    }
  }

  return ok('Insights generated');
}

async function handleCostPrediction(supabase: any) {
  const { data: vehicles } = await supabase.from('vehicles').select('*');
  if (!vehicles) return ok('No vehicles');

  for (const vehicle of vehicles) {
    const { data: history } = await supabase
      .from('historical_cost_data')
      .select('*')
      .eq('vehicle_id', vehicle.id)
      .order('date', { ascending: false })
      .limit(20);

    const { data: behavior } = await supabase
      .from('driver_behavior')
      .select('driver_score, average_engine_load')
      .eq('vehicle_id', vehicle.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const fuelPrice = vehicle.fuel_price_per_litre ?? 100;
    const kmPerLitre = vehicle.avg_km_per_litre ?? 12;

    let avgMonthly = history && history.length > 0
      ? history.reduce((s: number, h: any) => s + h.amount, 0) / (history.length / 4)
      : (1000 / kmPerLitre) * fuelPrice;

    const avgScore = behavior?.length
      ? behavior.reduce((s: number, b: any) => s + b.driver_score, 0) / behavior.length
      : 85;
    const wearFactor = avgScore < 80 ? (80 - avgScore) * 0.05 : 0;

    const estFuel = avgMonthly * 0.7;
    const estMaintenance = avgMonthly * (0.2 + wearFactor);
    const estInsurance = 500;

    await supabase.from('cost_predictions').insert({
      vehicle_id: vehicle.id,
      forecast_period: 'monthly',
      estimated_fuel_cost: Math.round(estFuel),
      estimated_maintenance_cost: Math.round(estMaintenance),
      estimated_insurance_cost: estInsurance,
      estimated_total_cost: Math.round(estFuel + estMaintenance + estInsurance),
      confidence_score: history?.length ? 0.85 : 0.60,
      factors: {
        driving_impact: wearFactor > 0 ? `Aggressive driving adds ${(wearFactor * 100).toFixed(0)}% to maintenance` : 'Optimized driving reducing costs',
        historical_trend: history?.length ? 'Based on last 3 months spending' : 'Baseline estimate',
      },
    });
  }

  return ok('Cost predictions generated');
}

async function handleRouteOptimization(supabase: any, url: URL) {
  const fleetId = url.searchParams.get('fleet_id');
  const originLat = parseFloat(url.searchParams.get('lat') || '0');
  const originLng = parseFloat(url.searchParams.get('lng') || '0');
  if (!fleetId) return new Response(JSON.stringify({ error: 'fleet_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const { data: destinations } = await supabase.from('destinations').select('*');
  const { data: trafficData } = await supabase.from('historical_traffic_data').select('*')
    .gt('latitude', originLat - 0.1).lt('latitude', originLat + 0.1)
    .gt('longitude', originLng - 0.1).lt('longitude', originLng + 0.1);

  const results = [];
  const hour = new Date().getHours();

  for (const dest of destinations || []) {
    const distance = Math.sqrt(Math.pow(dest.latitude - originLat, 2) + Math.pow(dest.longitude - originLng, 2)) * 111;
    let trafficScore = 5;
    if (trafficData && trafficData.length > 0) {
      trafficScore = trafficData.reduce((s: number, t: any) => s + t.congestion_level, 0) / trafficData.length * 10;
    }
    if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) trafficScore += 3;
    const efficiencyScore = Math.max(1, 10 - distance * 0.1 - trafficScore * 0.5);
    results.push({ dest_id: dest.id, dest_name: dest.name, distance: distance.toFixed(2), traffic_score: Math.min(10, trafficScore).toFixed(1), efficiency_score: efficiencyScore.toFixed(1), recommendation: efficiencyScore > 7 ? 'HIGHLY RECOMMENDED' : efficiencyScore > 4 ? 'VIABLE' : 'AVOID' });
  }

  const best = results.sort((a, b) => parseFloat(b.efficiency_score) - parseFloat(a.efficiency_score))[0];
  if (best) {
    await supabase.from('optimized_routes').insert({ fleet_id: fleetId, origin_lat: originLat, origin_lng: originLng, destination_id: best.dest_id, estimated_distance_km: best.distance, traffic_score: best.traffic_score, fuel_efficiency_score: best.efficiency_score });
  }

  return new Response(JSON.stringify({ success: true, best_route: best, all_options: results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function ok(message: string) {
  return new Response(JSON.stringify({ success: true, message }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
