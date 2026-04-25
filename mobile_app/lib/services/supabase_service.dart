import 'package:flutter/foundation.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'offline_queue_service.dart';

class SupabaseService {
  static final SupabaseService _instance = SupabaseService._internal();
  factory SupabaseService() => _instance;
  SupabaseService._internal();

  final _client = SupabaseConfig.client;
  final _queue  = OfflineQueueService();

  // ── Offline-resilient RPC helper ──────────────────────────────────────────
  //
  // Call any event-reporting RPC through this wrapper.  On success it returns
  // normally.  On failure (no internet, server error) the call is enqueued in
  // OfflineQueueService and retried automatically when connectivity resumes.
  //
  // Do NOT use this for high-frequency calls (heartbeats, location fixes) —
  // those are intentionally fire-and-forget.
  Future<void> _rpcWithFallback(
    String rpc,
    Map<String, dynamic> params,
  ) async {
    try {
      await _client.rpc(rpc, params: params);
    } catch (e) {
      debugPrint('SupabaseService: $rpc failed ($e) — queuing for retry');
      await _queue.enqueue(rpc: rpc, params: params);
    }
  }

  // ── Vehicle CRUD ─────────────────────────────────────────────────────────

  Future<List<Vehicle>> getVehicles() async {
    final userId = _client.auth.currentUser?.id;
    if (userId == null) {
      debugPrint('getVehicles: no authenticated user');
      return [];
    }

    try {
      // ── Resolve driver_accounts row ──────────────────────────────────────
      // The mobile app is invite-only. Every valid user has a driver_accounts
      // row written by the fleet manager. We use it to scope the vehicle list.
      String? assignedVehicleId;
      String? fleetId;

      try {
        final driverRow = await _client
            .from('driver_accounts')
            .select('fleet_id, vehicle_id')
            .eq('user_id', userId)
            .maybeSingle();
        if (driverRow != null) {
          fleetId           = driverRow['fleet_id']   as String?;
          assignedVehicleId = driverRow['vehicle_id'] as String?;
        }
      } catch (e) {
        debugPrint('getVehicles: driver_accounts lookup failed — $e');
      }

      // ── Driver vehicle scope ─────────────────────────────────────────────
      // Drivers see ONLY:
      //   1. Vehicles they personally connected via OBD (owner_id = userId)
      //   2. The vehicle pre-assigned to them in driver_accounts.vehicle_id
      //
      // They do NOT see the full fleet to protect privacy between drivers.
      final idsToFetch = <String>{};

      // Their OBD-connected vehicles
      try {
        final owned = await _client
            .from('vehicles')
            .select('id')
            .eq('owner_id', userId);
        for (final row in owned) {
          idsToFetch.add(row['id'] as String);
        }
      } catch (_) {}

      // Their pre-assigned vehicle (may differ from owner_id if manager added it)
      if (assignedVehicleId != null) {
        idsToFetch.add(assignedVehicleId);
      }

      if (idsToFetch.isNotEmpty) {
        final rows = await _client
            .from('vehicles')
            .select()
            .inFilter('id', idsToFetch.toList())
            .order('created_at', ascending: false);
        final vehicles = rows.map<Vehicle>((j) => Vehicle.fromJson(j)).toList();
        debugPrint('getVehicles: ${vehicles.length} vehicle(s) for driver $userId');
        return vehicles;
      }

      // No vehicles yet — driver hasn't connected via OBD yet and no
      // pre-assignment. Return empty so the home screen waits for OBD.
      debugPrint('getVehicles: no vehicles found for driver $userId (fleet: $fleetId)');
      return [];
    } catch (e) {
      debugPrint('getVehicles error: $e');
      return [];
    }
  }

  Future<Vehicle?> createVehicle(Vehicle vehicle) async {
    try {
      final data = vehicle.toJson();

      // vehicles.vin is NOT NULL UNIQUE — generate a timestamped placeholder
      // when the user leaves the VIN field blank in the manual-add form.
      if (data['vin'] == null || (data['vin'] as String?)?.isEmpty == true) {
        data['vin'] = 'VIN-${DateTime.now().millisecondsSinceEpoch}';
      }

      // Provide sensible defaults for columns the Dart model doesn't carry
      // but that may lack server-side defaults on older DB instances.
      data.putIfAbsent('is_active',    () => true);
      data.putIfAbsent('health_score', () => 100);
      data.putIfAbsent('fuel_type',    () => 'petrol');

      final response = await _client
          .from('vehicles')
          .insert(data)
          .select()
          .single();
      return Vehicle.fromJson(response);
    } catch (e) {
      debugPrint('Error creating vehicle: $e');
      return null;
    }
  }

  /// Find an existing vehicle by VIN or create a new one automatically.
  ///
  /// Called by HomeScreen when the OBD adapter returns a VIN via Mode 09
  /// PID 02 and NHTSA successfully decodes the make/model/year.
  ///
  /// If a vehicle with [vin] already exists in the fleet the existing record
  /// is returned unchanged — no duplicate is created.
  Future<Vehicle?> getOrCreateVehicleByVin({
    required String vin,
    required String make,
    required String model,
    required int    year,
    String? fleetId,
  }) async {
    try {
      final userId = _client.auth.currentUser?.id;
      if (userId == null) {
        debugPrint('getOrCreateVehicleByVin: no authenticated user');
        return null;
      }

      // ── Resolve fleet_id if not provided ─────────────────────────────────
      // Drivers created via "Create Driver" have a driver_accounts row with
      // fleet_id.  If the caller didn't pass one, look it up now.
      String? resolvedFleetId = fleetId;
      if (resolvedFleetId == null) {
        try {
          final row = await _client
              .from('driver_accounts')
              .select('fleet_id')
              .eq('user_id', userId)
              .maybeSingle();
          if (row != null) resolvedFleetId = row['fleet_id'] as String?;
          if (resolvedFleetId == null) {
            debugPrint('getOrCreateVehicleByVin: no driver_accounts row found for $userId — vehicle will be created without fleet_id');
          }
        } catch (e) {
          // Non-fatal: driver may not be in driver_accounts (e.g. signed up directly).
          // The vehicle will be created with fleet_id=null and can be backfilled later.
          debugPrint('getOrCreateVehicleByVin: driver_accounts lookup failed: $e');
        }
      }

      // ── Check for an existing vehicle ─────────────────────────────────────
      // For driver-keyed VINs (Mode 09 not supported) search by owner_id so
      // we never create duplicate "My Vehicle" records across reconnects.
      List<dynamic> existingRows;
      if (vin.startsWith('DRIVER-')) {
        existingRows = await _client
            .from('vehicles')
            .select()
            .eq('owner_id', userId)
            .limit(1);
      } else {
        existingRows = await _client
            .from('vehicles')
            .select()
            .eq('vin', vin)
            .limit(1);
      }

      if (existingRows.isNotEmpty) {
        debugPrint('Vehicle already registered — using existing record');
        final existing = Vehicle.fromJson(existingRows.first as Map<String, dynamic>);
        // If fleet_id was missing, backfill it now.
        if (existing.fleetId == null && resolvedFleetId != null) {
          await _client
              .from('vehicles')
              .update({'fleet_id': resolvedFleetId})
              .eq('id', existing.id);
          debugPrint('Backfilled fleet_id on vehicle ${existing.id}');
        }
        return existing;
      }

      // ── Create new vehicle record ─────────────────────────────────────────
      final displayName = vin.startsWith('DRIVER-')
          ? 'My Vehicle'
          : '$year $make $model';

      final insertData = <String, dynamic>{
        'name':         displayName,
        'vin':          vin,
        'make':         make,
        'model':        model,
        'year':         year,
        'owner_id':     userId,
        'fleet_id':     resolvedFleetId,
        'is_active':    true,
        'health_score': 100,
        'fuel_type':    'petrol',
      };

      final response = await _client
          .from('vehicles')
          .insert(insertData)
          .select()
          .single();

      debugPrint('Auto-registered vehicle: $displayName ($vin)');
      return Vehicle.fromJson(response);
    } catch (e) {
      // PostgreSQL unique-violation code 23505: the VIN already exists but our
      // earlier SELECT missed it (possible RLS timing or race condition).
      // Recover by fetching the existing row instead of failing entirely.
      final msg = e.toString();
      if (msg.contains('23505') || msg.contains('unique') || msg.contains('duplicate')) {
        debugPrint('getOrCreateVehicleByVin: VIN already exists — fetching existing record for $vin');
        try {
          final lookupField = vin.startsWith('DRIVER-') ? 'owner_id' : 'vin';
          final lookupValue = vin.startsWith('DRIVER-')
              ? (_client.auth.currentUser?.id ?? '')
              : vin;
          final existing = await _client
              .from('vehicles')
              .select()
              .eq(lookupField, lookupValue)
              .limit(1)
              .single();
          return Vehicle.fromJson(existing);
        } catch (fetchErr) {
          debugPrint('getOrCreateVehicleByVin: recovery fetch also failed: $fetchErr');
        }
      }
      debugPrint('getOrCreateVehicleByVin error: $e');
      return null;
    }
  }

  Future<Vehicle?> updateVehicle(Vehicle vehicle) async {
    try {
      final response = await _client
          .from('vehicles')
          .update(vehicle.toJson())
          .eq('id', vehicle.id)
          .select()
          .single();
      return Vehicle.fromJson(response);
    } catch (e) {
      debugPrint('Error updating vehicle: $e');
      return null;
    }
  }

  Future<bool> deleteVehicle(String vehicleId) async {
    try {
      await _client.from('vehicles').delete().eq('id', vehicleId);
      return true;
    } catch (e) {
      debugPrint('Error deleting vehicle: $e');
      return false;
    }
  }

  // ── Thresholds ────────────────────────────────────────────────────────────

  Future<List<Threshold>> getThresholds(String vehicleId) async {
    try {
      final response = await _client
          .from('thresholds')
          .select()
          .eq('vehicle_id', vehicleId);
      return (response as List).map((j) => Threshold.fromJson(j)).toList();
    } catch (e) {
      debugPrint('Error fetching thresholds: $e');
      return [];
    }
  }

  Future<Threshold?> createThreshold(Threshold threshold) async {
    try {
      final response = await _client
          .from('thresholds')
          .insert(threshold.toJson())
          .select()
          .single();
      return Threshold.fromJson(response);
    } catch (e) {
      debugPrint('Error creating threshold: $e');
      return null;
    }
  }

  Future<Threshold?> updateThreshold(Threshold threshold) async {
    try {
      final response = await _client
          .from('thresholds')
          .update(threshold.toJson())
          .eq('id', threshold.id)
          .select()
          .single();
      return Threshold.fromJson(response);
    } catch (e) {
      debugPrint('Error updating threshold: $e');
      return null;
    }
  }

  // ── Sensor data – BATCH write (1 Edge Function call per OBD poll cycle) ──
  //
  // Sending all readings from one poll cycle in a single HTTP request reduces
  // Edge Function invocations from N (one per sensor) to 1.  On Supabase Free
  // this extends the monthly invocation budget ~70×.

  Future<bool> saveSensorBatch(
    String vehicleId,
    Map<SensorType, SensorData> batch,
  ) async {
    if (batch.isEmpty) return true;

    final readings = batch.values.map((sd) => {
      'vehicle_id': vehicleId,
      'sensor_type': sd.type.name,
      'value': sd.value,
      'unit': sd.unit,
      'timestamp': sd.timestamp.toIso8601String(),
    }).toList();

    try {
      // Single invocation for the entire poll cycle.
      await _client.functions.invoke(
        'sensor-api',
        body: {'readings': readings},
      );
      // Update last_active_at so the dashboard shows live vs stale status.
      await _updateLastActiveAt(vehicleId);
      return true;
    } catch (e) {
      debugPrint('Batch Edge Function call failed ($e) – falling back to direct insert');
      try {
        await _client.from('sensor_data').insert(readings);
        await _updateLastActiveAt(vehicleId);
        return true;
      } catch (innerError) {
        debugPrint('Direct batch insert also failed ($innerError) – queuing for retry');
        await _queue.enqueue(
          rpc: 'sensor_batch',
          params: {'vehicle_id': vehicleId, 'readings': readings},
        );
        return false;
      }
    }
  }

  /// Stamp the vehicle's last_connected column with the current UTC time.
  /// Called on every successful sensor batch upload.
  Future<void> _updateLastActiveAt(String vehicleId) async {
    try {
      await _client
          .from('vehicles')
          .update({'last_connected': DateTime.now().toUtc().toIso8601String()})
          .eq('id', vehicleId);
    } catch (e) {
      debugPrint('last_connected update error: $e');
    }
  }

  /// Update the driver_accounts row to point at a new vehicle.
  /// Called from HomeScreen after OBD auto-detects and registers a vehicle.
  Future<void> updateDriverVehicle(String vehicleId) async {
    try {
      final userId = _client.auth.currentUser?.id;
      if (userId == null) return;
      await _client
          .from('driver_accounts')
          .update({'vehicle_id': vehicleId})
          .eq('user_id', userId);
      debugPrint('driver_accounts.vehicle_id updated to $vehicleId');
    } catch (e) {
      debugPrint('updateDriverVehicle error: $e');
    }
  }

  /// Legacy single-reading save kept for compatibility (threshold alert path).
  Future<bool> saveSensorData(String vehicleId, SensorData sensorData) async {
    return saveSensorBatch(vehicleId, {sensorData.type: sensorData});
  }

  // ── Driver behavior ───────────────────────────────────────────────────────

  /// Create a new driver_behavior session row when OBD connects.
  /// Returns the row id so [SensorProvider] can update it incrementally.
  Future<String?> createDriverBehaviorSession(
    String vehicleId,
    DateTime tripStart,
  ) async {
    try {
      final response = await _client
          .from('driver_behavior')
          .insert({
            'vehicle_id':              vehicleId,
            'trip_start':              tripStart.toUtc().toIso8601String(),
            'harsh_braking_count':     0,
            'harsh_acceleration_count': 0,
            'excessive_rpm_count':     0,
            'excessive_speed_count':   0,
            'average_engine_load':     0.0,
            'driver_score':            100.0,
          })
          .select()
          .single();
      debugPrint('driver_behavior session created: ${response['id']}');
      return response['id'] as String?;
    } catch (e) {
      debugPrint('createDriverBehaviorSession error: $e');
      return null;
    }
  }

  /// Update the running driver_behavior session with latest event counts.
  /// Score formula mirrors the fleet-intelligence Edge Function:
  ///   score = 100 - (braking*2) - (accel*2) - (rpm*1) - (speed*3)  clamped [0, 100]
  Future<void> updateDriverBehavior({
    required String sessionId,
    required int    harshBrakingCount,
    required int    harshAccelCount,
    required int    excessiveRpmCount,
    required int    excessiveSpeedCount,
    required double avgEngineLoad,
  }) async {
    try {
      final score = (100
              - harshBrakingCount   * 2
              - harshAccelCount     * 2
              - excessiveRpmCount   * 1
              - excessiveSpeedCount * 3)
          .clamp(0, 100)
          .toDouble();
      await _client.from('driver_behavior').update({
        'harsh_braking_count':     harshBrakingCount,
        'harsh_acceleration_count': harshAccelCount,
        'excessive_rpm_count':     excessiveRpmCount,
        'excessive_speed_count':   excessiveSpeedCount,
        'average_engine_load':     avgEngineLoad,
        'driver_score':            score,
      }).eq('id', sessionId);
      debugPrint('driver_behavior updated — score: $score');
    } catch (e) {
      debugPrint('updateDriverBehavior error: $e');
    }
  }

  /// Stamp trip_end on the session row when OBD disconnects.
  Future<void> closeDriverBehaviorSession(String sessionId) async {
    try {
      await _client.from('driver_behavior').update({
        'trip_end': DateTime.now().toUtc().toIso8601String(),
      }).eq('id', sessionId);
      debugPrint('driver_behavior session closed: $sessionId');
    } catch (e) {
      debugPrint('closeDriverBehaviorSession error: $e');
    }
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  Future<void> createAlert(
    String vehicleId,
    SensorData sensorData,
    String message,
  ) async {
    try {
      await _client.from('alerts').insert({
        'vehicle_id': vehicleId,
        'sensor_type': sensorData.type.name,
        'message': message,
        'severity': 'warning',
        'value': sensorData.value,
        'threshold_exceeded': true,
      });
    } catch (e) {
      debugPrint('Error creating alert: $e');
    }
  }

  // ── Anti-tamper / device-event reporting ──────────────────────────────────

  /// Report a device lifecycle event to Supabase.
  ///
  /// [eventType] must be one of: 'normal_disconnect', 'device_offline',
  /// 'possible_tampering', 'device_reconnected'.
  ///
  /// Call with 'normal_disconnect' in [SensorProvider.stopMonitoring] so the
  /// backend knows this was a graceful OBD disconnect and can distinguish it
  /// from an unexpected data loss.
  Future<void> reportNormalDisconnect(
    String vehicleId, {
    double? lastRpm,
    String? offlineReason,
  }) async {
    await _rpcWithFallback('report_device_event', {
      'p_vehicle_id':     vehicleId,
      'p_event_type':     'normal_disconnect',
      'p_last_rpm':       lastRpm,
      'p_offline_reason': offlineReason,
    });
    debugPrint('reportNormalDisconnect: sent for $vehicleId (rpm: $lastRpm)');
  }

  /// Report a connectivity-loss event so the backend immediately knows
  /// the reason before heartbeats stop arriving.
  /// This intentionally does NOT use _rpcWithFallback — if we have no
  /// connectivity the call will fail and we accept that; queueing a
  /// connectivity_lost event to send later would be misleading.
  Future<void> reportConnectivityLost(String vehicleId) async {
    try {
      await _client.rpc('report_device_event', params: {
        'p_vehicle_id':     vehicleId,
        'p_event_type':     'device_offline',
        'p_offline_reason': 'connectivity_lost',
      });
      debugPrint('reportConnectivityLost: sent for $vehicleId');
    } catch (e) {
      debugPrint('reportConnectivityLost failed (expected if no internet): $e');
    }
  }

  /// Send a heartbeat to Supabase — called every 10 seconds by HeartbeatService.
  Future<void> sendHeartbeat({
    required String  vehicleId,
    double?          lat,
    double?          lng,
    bool             gpsAvailable = true,
    String           networkType  = 'unknown',
    int?             batteryLevel,
  }) async {
    try {
      await _client.rpc('send_heartbeat', params: {
        'p_vehicle_id':    vehicleId,
        'p_lat':           lat,
        'p_lng':           lng,
        'p_gps_available': gpsAvailable,
        'p_network_type':  networkType,
        'p_battery_level': batteryLevel,
      });
    } catch (e) {
      debugPrint('sendHeartbeat error: $e');
    }
  }

  // ── Trip gap reporting ────────────────────────────────────────────────────

  /// Report a trip gap — called by LocationService when no GPS fix is
  /// received for > 5 minutes during an active trip.
  Future<void> reportTripGap({
    required String tripId,
    required String vehicleId,
    double? lastLat,
    double? lastLng,
  }) async {
    await _rpcWithFallback('report_trip_gap', {
      'p_trip_id':    tripId,
      'p_vehicle_id': vehicleId,
      'p_gap_start':  DateTime.now().toUtc().toIso8601String(),
      'p_last_lat':   lastLat,
      'p_last_lng':   lastLng,
    });
    debugPrint('reportTripGap: gap opened for trip $tripId');
  }

  /// Close a trip gap when GPS fixes resume — called by LocationService.
  Future<void> closeTripGap({required String tripId}) async {
    await _rpcWithFallback('close_trip_gap', {
      'p_trip_id': tripId,
      'p_gap_end': DateTime.now().toUtc().toIso8601String(),
    });
    debugPrint('closeTripGap: gap closed for trip $tripId');
  }

  // ── Tampering / mock GPS reporting ───────────────────────────────────────

  /// Report a `possible_tampering` event with an optional reason and metadata.
  /// Used by LocationService when it detects mock/fake GPS coordinates.
  Future<void> reportPossibleTampering({
    required String vehicleId,
    required String reason,
    Map<String, dynamic> metadata = const {},
  }) async {
    await _rpcWithFallback('report_device_event', {
      'p_vehicle_id': vehicleId,
      'p_event_type': 'possible_tampering',
      'p_metadata':   {'reason': reason, ...metadata},
    });
    debugPrint('reportPossibleTampering: $reason for $vehicleId');
  }

  // ── Movement anomaly reporting ────────────────────────────────────────────

  /// Report a movement anomaly detected on-device:
  ///   gps_speed_mismatch  — GPS speed ≈ 0 but position changed
  ///   excessive_idle      — engine on, no movement for > 15 min
  Future<void> reportMovementAnomaly({
    required String vehicleId,
    required String eventType,
    double? speedObdKmh,
    double? speedGpsKmh,
    double? movementDistanceM,
    int?    idleDurationMins,
    double? lastRpm,
  }) async {
    await _rpcWithFallback('report_device_event', {
      'p_vehicle_id':          vehicleId,
      'p_event_type':          eventType,
      'p_last_rpm':            lastRpm,
      'p_speed_obd_kmh':       speedObdKmh,
      'p_speed_gps_kmh':       speedGpsKmh,
      'p_movement_distance_m': movementDistanceM,
      'p_idle_duration_mins':  idleDurationMins,
    });
    debugPrint('reportMovementAnomaly: $eventType for $vehicleId');
  }

  /// Resolve an open movement anomaly event — called when the condition clears
  /// (e.g. vehicle starts moving after excessive idle).
  Future<void> resolveMovementEvent(String vehicleId, String eventType) async {
    try {
      await _client.rpc('resolve_movement_event', params: {
        'p_vehicle_id': vehicleId,
        'p_event_type': eventType,
      });
      debugPrint('resolveMovementEvent: $eventType for $vehicleId');
    } catch (e) {
      debugPrint('resolveMovementEvent error: $e');
    }
  }

  // ── Location / trip tracking ──────────────────────────────────────────────

  /// Create a trip record in Supabase when the OBD session starts.
  /// Returns the new trip id, or null on failure.
  Future<String?> startTrip({
    required String vehicleId,
    required double lat,
    required double lng,
  }) async {
    try {
      final response = await _client.rpc('start_trip', params: {
        'p_vehicle_id': vehicleId,
        'p_lat':        lat,
        'p_lng':        lng,
      });
      return response as String?;
    } catch (e) {
      debugPrint('startTrip error: $e');
      return null;
    }
  }

  /// Close the current trip when the OBD session ends.
  Future<void> endTrip({
    required String tripId,
    required double endLat,
    required double endLng,
    required double distanceKm,
  }) async {
    try {
      await _client.rpc('end_trip', params: {
        'p_trip_id':     tripId,
        'p_end_lat':     endLat,
        'p_end_lng':     endLng,
        'p_distance_km': distanceKm,
      });
      debugPrint('endTrip: trip $tripId closed (${distanceKm.toStringAsFixed(2)} km)');
    } catch (e) {
      debugPrint('endTrip error: $e');
    }
  }

  /// Record a single GPS position during an active trip.
  Future<void> recordLocation({
    required String  vehicleId,
    required String  tripId,
    required double  lat,
    required double  lng,
    double?          speed,
    double?          heading,
    double?          accuracy,
    double?          altitude,
    bool?            ignitionStatus,
  }) async {
    try {
      await _client.rpc('record_vehicle_location', params: {
        'p_vehicle_id':       vehicleId,
        'p_trip_id':          tripId,
        'p_lat':              lat,
        'p_lng':              lng,
        'p_speed':            speed,
        'p_heading':          heading,
        'p_accuracy':         accuracy,
        'p_altitude':         altitude,
        'p_ignition_status':  ignitionStatus,
      });
    } catch (e) {
      debugPrint('recordLocation error: $e');
    }
  }

  // ── Fuel event reporting ──────────────────────────────────────────────────

  /// Report a refuel or fuel theft event detected on-device.
  ///
  /// [type]  must be one of: 'refuel', 'fuel_theft', 'excessive_idle'
  /// [value] is the % change (rise for refuel, drop for theft)
  Future<void> reportFuelEvent({
    required String vehicleId,
    required String type,
    required double value,
    required String message,
    double? locationLat,
    double? locationLng,
  }) async {
    try {
      await _client.from('fuel_events').insert({
        'vehicle_id':   vehicleId,
        'type':         type,
        'timestamp':    DateTime.now().toUtc().toIso8601String(),
        'value':        value,
        'message':      message,
        if (locationLat != null) 'location_lat': locationLat,
        if (locationLng != null) 'location_lng': locationLng,
      });
      debugPrint('reportFuelEvent: $type for vehicle $vehicleId (${value.toStringAsFixed(1)} %)');
    } catch (e) {
      debugPrint('reportFuelEvent error: $e');
    }
  }

  // ── Geofence support ──────────────────────────────────────────────────────

  /// Fetch all active geofences for [fleetId].
  /// Returns a list of raw maps; [GeofenceService] converts them to typed objects.
  Future<List<dynamic>> fetchGeofences({required String fleetId}) async {
    try {
      final response = await _client.rpc(
        'get_fleet_geofences',
        params: {'p_fleet_id': fleetId},
      );
      return (response as List?) ?? [];
    } catch (e) {
      debugPrint('fetchGeofences error: $e');
      return [];
    }
  }

  /// Report a geofence boundary crossing (entry or exit) to the backend.
  ///
  /// The backend trigger on vehicle_locations also detects violations; this
  /// mobile call is a fast-path that fires immediately on each GPS fix so
  /// fleet managers see alerts within seconds rather than waiting for the
  /// next trigger evaluation.
  Future<void> reportGeofenceViolation({
    required String  vehicleId,
    required String  geofenceId,
    required String  geofenceName,
    required String  violationType, // 'exit' | 'enter'
    required double  lat,
    required double  lng,
    String?          tripId,
    double?          speedKmh,
  }) async {
    try {
      // The trigger already inserts into geofence_violations; we call
      // report_device_event so the violation also appears in the existing
      // alerts pipeline (AlertsPage, FleetOverview active alerts, etc.).
      await _client.rpc('report_device_event', params: {
        'p_vehicle_id':  vehicleId,
        'p_event_type':  'geofence_violation',
        'p_stop_lat':    lat,
        'p_stop_lng':    lng,
      });
      debugPrint(
        'reportGeofenceViolation: $violationType "$geofenceName" '
        'for vehicle $vehicleId',
      );
    } catch (e) {
      debugPrint('reportGeofenceViolation error: $e');
    }
  }

  // ── Fleet self-join ──────────────────────────────────────────────────────

  /// Looks up a fleet by its 6-character join code.
  /// Returns `{'id': String, 'name': String}` or null if not found.
  Future<Map<String, String>?> getFleetByJoinCode(String code) async {
    try {
      final rows = await _client
          .from('fleets')
          .select('id, name')
          .eq('join_code', code.trim().toUpperCase())
          .limit(1);
      if (rows.isEmpty) return null;
      return {
        'id':   rows.first['id']   as String,
        'name': rows.first['name'] as String,
      };
    } catch (e) {
      debugPrint('getFleetByJoinCode error: $e');
      return null;
    }
  }

  /// Creates a driver_accounts row for the current user in [fleetId].
  /// Called after the driver confirms the fleet via join code.
  Future<bool> selfJoinFleet({
    required String fleetId,
    required String name,
    required String email,
    String? phone,
  }) async {
    final userId = _client.auth.currentUser?.id;
    if (userId == null) return false;
    try {
      await _client.from('driver_accounts').insert({
        'user_id':  userId,
        'fleet_id': fleetId,
        'name':     name,
        'email':    email,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
      });
      debugPrint('selfJoinFleet: joined fleet $fleetId as $name');
      return true;
    } catch (e) {
      debugPrint('selfJoinFleet error: $e');
      return false;
    }
  }

  Future<int> getOfflineQueueLength() async {
    return _queue.pendingCount;
  }

  Future<void> flushOfflineQueue() async {
    try {
      await _queue.flush((rpc, params) async {
        try {
          await _client.rpc(rpc, params: params);
          return true;
        } catch (_) {
          return false;
        }
      });
    } catch (e) {
      debugPrint('flushOfflineQueue error: $e');
    }
  }

  Future<Map<Vehicle, List<Threshold>>> getVehiclesWithThresholds() async {
    final vehicles = await getVehicles();
    final result = <Vehicle, List<Threshold>>{};
    for (final vehicle in vehicles) {
      result[vehicle] = await getThresholds(vehicle.id);
    }
    return result;
  }

  Future<List<Map<String, dynamic>>> getSensorHistory({
    required String vehicleId,
    required int days,
    required int limit,
  }) async {
    try {
      final cutoff = DateTime.now().subtract(Duration(days: days));
      final response = await _client
          .from('sensor_data')
          .select()
          .eq('vehicle_id', vehicleId)
          .gte('timestamp', cutoff.toIso8601String())
          .order('timestamp', ascending: false)
          .limit(limit);
      return List<Map<String, dynamic>>.from(response as List);
    } catch (e) {
      debugPrint('getSensorHistory error: $e');
      return [];
    }
  }
}
