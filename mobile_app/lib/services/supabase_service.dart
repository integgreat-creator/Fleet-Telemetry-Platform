import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

class SupabaseService {
  static final SupabaseService _instance = SupabaseService._internal();
  factory SupabaseService() => _instance;
  SupabaseService._internal();

  final _client = SupabaseConfig.client;

  // ── OFFLINE QUEUE ─────────────────────────────────────────────────────────
  static const _offlineQueueKey = 'sensor_offline_queue';

  Future<void> _enqueueOffline(Map<String, dynamic> payload) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_offlineQueueKey) ?? [];
    raw.add(jsonEncode(payload));
    // Cap queue at 500 entries to avoid unbounded growth
    if (raw.length > 500) raw.removeAt(0);
    await prefs.setStringList(_offlineQueueKey, raw);
  }

  /// Call this when connectivity is restored to flush the offline queue.
  Future<void> flushOfflineQueue() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_offlineQueueKey) ?? [];
    if (raw.isEmpty) return;

    final failed = <String>[];
    for (final item in raw) {
      try {
        final payload = jsonDecode(item) as Map<String, dynamic>;
        await _client.functions.invoke('sensor-api', body: payload);
      } catch (_) {
        failed.add(item); // keep failed items for next attempt
      }
    }
    await prefs.setStringList(_offlineQueueKey, failed);
  }

  int get offlineQueueLength {
    // Synchronous peek — actual count read asynchronously if needed
    return 0; // Placeholder: call getOfflineQueueLength() for actual count
  }

  Future<int> getOfflineQueueLength() async {
    final prefs = await SharedPreferences.getInstance();
    return (prefs.getStringList(_offlineQueueKey) ?? []).length;
  }

  // ── VEHICLES ──────────────────────────────────────────────────────────────

  /// Loads all vehicles the current user can access (RLS-filtered).
  /// Returns vehicles without thresholds — use [getVehiclesWithThresholds]
  /// for the joined version.
  Future<List<Vehicle>> getVehicles() async {
    try {
      final response = await _client
          .from('vehicles')
          .select()
          .order('created_at', ascending: false);
      return (response as List)
          .map((json) => Vehicle.fromJson(json as Map<String, dynamic>))
          .toList();
    } catch (e) {
      print('Error fetching vehicles: $e');
      return [];
    }
  }

  /// N+1 FIX: Fetches vehicles AND their thresholds in a single Supabase
  /// query using a relational select join.
  /// Returns a map: { vehicle → [thresholds] }
  Future<Map<Vehicle, List<Threshold>>> getVehiclesWithThresholds() async {
    try {
      final response = await _client
          .from('vehicles')
          .select('*, thresholds(*)')
          .order('created_at', ascending: false);

      final result = <Vehicle, List<Threshold>>{};
      for (final json in response as List) {
        final vehicle = Vehicle.fromJson(json as Map<String, dynamic>);
        final thresholdsList = (json['thresholds'] as List? ?? [])
            .map((t) => Threshold.fromJson(t as Map<String, dynamic>))
            .toList();
        result[vehicle] = thresholdsList;
      }
      return result;
    } catch (e) {
      print('Error fetching vehicles with thresholds: $e');
      return {};
    }
  }

  /// Upserts a vehicle by VIN for a given user. If a vehicle with the same VIN
  /// already exists for this user, the existing record is returned. Otherwise a
  /// new one is created. Useful for the post-OBD-connection auto-registration flow.
  Future<Vehicle> getOrCreateVehicleByVin({
    required String userId,
    required String vin,
    required String name,
    String? make,
    String? model,
    int? year,
    String? fleetId,
  }) async {
    // Check if a vehicle with this VIN already belongs to this user
    try {
      final existing = await _client
          .from('vehicles')
          .select()
          .eq('vin', vin)
          .eq('owner_id', userId)
          .maybeSingle();

      if (existing != null) {
        return Vehicle.fromJson(existing as Map<String, dynamic>);
      }
    } catch (_) {
      // No existing record — continue to create
    }

    final now = DateTime.now();
    final vehicle = Vehicle(
      id:                '',
      name:              name,
      vin:               vin,
      make:              make ?? '',
      model:             model ?? '',
      year:              year ?? now.year,
      ownerId:           userId,
      fleetId:           fleetId,
      isActive:          true,
      healthScore:       100.0,
      fuelPricePerLitre: 100.0,
      avgKmPerLitre:     15.0,
      fuelType:          'petrol',
      createdAt:         now,
      updatedAt:         now,
    );

    final created = await createVehicle(vehicle);
    if (created == null) {
      throw Exception('Failed to create vehicle record');
    }
    return created;
  }

  Future<Vehicle?> createVehicle(Vehicle vehicle) async {
    try {
      final response = await _client
          .from('vehicles')
          // FIX: use toInsertJson() to avoid sending id/timestamps
          .insert(vehicle.toInsertJson())
          .select()
          .single();
      return Vehicle.fromJson(response as Map<String, dynamic>);
    } catch (e) {
      print('Error creating vehicle: $e');
      return null;
    }
  }

  Future<Vehicle?> updateVehicle(Vehicle vehicle) async {
    try {
      final response = await _client
          .from('vehicles')
          // FIX: use toUpdateJson() to only send mutable fields
          .update(vehicle.toUpdateJson())
          .eq('id', vehicle.id)
          .select()
          .single();
      return Vehicle.fromJson(response as Map<String, dynamic>);
    } catch (e) {
      print('Error updating vehicle: $e');
      return null;
    }
  }

  Future<bool> deleteVehicle(String vehicleId) async {
    try {
      await _client.from('vehicles').delete().eq('id', vehicleId);
      return true;
    } catch (e) {
      print('Error deleting vehicle: $e');
      return false;
    }
  }

  // ── THRESHOLDS ────────────────────────────────────────────────────────────

  Future<List<Threshold>> getThresholds(String vehicleId) async {
    try {
      final response = await _client
          .from('thresholds')
          .select()
          .eq('vehicle_id', vehicleId);
      return (response as List)
          .map((json) => Threshold.fromJson(json as Map<String, dynamic>))
          .toList();
    } catch (e) {
      print('Error fetching thresholds: $e');
      return [];
    }
  }

  Future<Threshold?> createThreshold(Threshold threshold) async {
    try {
      final response = await _client
          .from('thresholds')
          .upsert(threshold.toUpsertJson(), onConflict: 'vehicle_id,sensor_type')
          .select()
          .single();
      return Threshold.fromJson(response as Map<String, dynamic>);
    } catch (e) {
      print('Error upserting threshold: $e');
      return null;
    }
  }

  Future<Threshold?> updateThreshold(Threshold threshold) async {
    try {
      final response = await _client
          .from('thresholds')
          .update(threshold.toUpsertJson())
          .eq('id', threshold.id)
          .select()
          .single();
      return Threshold.fromJson(response as Map<String, dynamic>);
    } catch (e) {
      print('Error updating threshold: $e');
      return null;
    }
  }

  // ── SENSOR DATA ───────────────────────────────────────────────────────────

  Future<bool> saveSensorData(
    String vehicleId,
    SensorData sensorData, {
    String? driverAccountId,   // MOB-2: optional driver attribution
  }) async {
    final payload = <String, dynamic>{
      'vehicle_id':   vehicleId,
      'sensor_type':  sensorData.type.name,
      'value':        sensorData.value,
      'unit':         sensorData.unit,
      'timestamp':    sensorData.timestamp.toIso8601String(),
      if (driverAccountId != null) 'driver_account_id': driverAccountId,
    };

    // Primary path: edge function (handles anomaly detection + threshold checks)
    try {
      await _client.functions.invoke('sensor-api', body: payload);
      return true;
    } catch (e) {
      print('sensor-api edge function failed: $e');
    }

    // Fallback: direct insert
    try {
      await _client.from('sensor_data').insert(payload);
      return true;
    } catch (e) {
      print('Direct sensor insert also failed — queuing offline: $e');
      await _enqueueOffline(payload);
      return false;
    }
  }

  // ── ALERTS ────────────────────────────────────────────────────────────────

  Future<void> createAlert(
    String vehicleId,
    SensorData sensorData,
    String message, {
    String severity = 'warning',
  }) async {
    try {
      await _client.from('alerts').insert({
        'vehicle_id':   vehicleId,
        'sensor_type':  sensorData.type.name,
        'message':      message,
        // FIX: was sending 'threshold_exceeded: true' — not a DB column
        'severity':     severity,
        'value':        sensorData.value,
      });
    } catch (e) {
      print('Error creating alert: $e');
    }
  }

  // ── SENSOR REGISTRY ───────────────────────────────────────────────────────

  /// Returns all sensors seen for a vehicle (auto-populated by DB trigger).
  Future<List<Map<String, dynamic>>> getSensorRegistry(String vehicleId) async {
    try {
      final response = await _client
          .from('sensor_registry')
          .select()
          .eq('vehicle_id', vehicleId)
          .order('reading_count', ascending: false);
      return List<Map<String, dynamic>>.from(response as List);
    } catch (e) {
      print('Error fetching sensor registry: $e');
      return [];
    }
  }

  // ── DEVICE HEALTH ─────────────────────────────────────────────────────────

  Future<void> updateDeviceHealth({
    required String vehicleId,
    String deviceType = 'obd2',
    String? deviceId,
    int? signalStrength,
    double? batteryLevel,
    bool isOnline = true,
    String? errorCode,
    String? errorMessage,
  }) async {
    try {
      await _client.from('device_health').upsert({
        'vehicle_id':     vehicleId,
        'device_type':    deviceType,
        'device_id':      deviceId,
        'signal_strength': signalStrength,
        'battery_level':  batteryLevel,
        'last_ping_at':   DateTime.now().toIso8601String(),
        'is_online':      isOnline,
        'error_code':     errorCode,
        'error_message':  errorMessage,
        'updated_at':     DateTime.now().toIso8601String(),
      }, onConflict: 'vehicle_id,device_type');
    } catch (e) {
      print('Error updating device health: $e');
    }
  }

  // ── VEHICLE LOGS (GPS heartbeat) ──────────────────────────────────────────

  /// Saves a GPS + ignition heartbeat to vehicle_logs.
  /// Called every 15 seconds from SensorProvider when monitoring is active.
  Future<void> saveVehicleLog({
    required String vehicleId,
    required double latitude,
    required double longitude,
    double accuracy = 0,
    double altitude = 0,
    double speed = 0,
    bool ignitionStatus = false,
    bool isMockGps = false,
    String? driverAccountId,   // MOB-2: optional driver attribution
  }) async {
    final payload = <String, dynamic>{
      'vehicle_id':      vehicleId,
      'speed':           speed,
      'ignition_status': ignitionStatus,
      'latitude':        latitude,
      'longitude':       longitude,
      'accuracy_metres': accuracy,
      'altitude':        altitude,
      'is_mock_gps':     isMockGps,
      'timestamp':       DateTime.now().toIso8601String(),
      if (driverAccountId != null) 'driver_account_id': driverAccountId,
    };

    try {
      await _client.from('vehicle_logs').insert(payload);
    } catch (e) {
      print('saveVehicleLog error: $e');
      // Queue offline — separate low-priority queue
      await _enqueueOfflineLog(payload);
    }
  }

  static const _offlineLogQueueKey = 'vehicle_log_offline_queue';

  Future<void> _enqueueOfflineLog(Map<String, dynamic> payload) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_offlineLogQueueKey) ?? [];
    raw.add(jsonEncode(payload));
    if (raw.length > 200) raw.removeAt(0); // lower cap than sensor queue
    await prefs.setStringList(_offlineLogQueueKey, raw);
  }

  Future<void> flushOfflineLogQueue() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_offlineLogQueueKey) ?? [];
    if (raw.isEmpty) return;
    final failed = <String>[];
    for (final item in raw) {
      try {
        await _client.from('vehicle_logs').insert(jsonDecode(item));
      } catch (_) {
        failed.add(item);
      }
    }
    await prefs.setStringList(_offlineLogQueueKey, failed);
  }

  // ── VEHICLE EVENTS (system events) ───────────────────────────────────────

  /// Creates a system event record (device offline, tamper, unauthorized movement, etc.)
  Future<void> createVehicleEvent({
    required String vehicleId,
    required String fleetId,
    required String eventType,
    required String title,
    required String description,
    String severity = 'warning',
    Map<String, dynamic> metadata = const {},
  }) async {
    try {
      await _client.from('vehicle_events').insert({
        'vehicle_id':  vehicleId,
        'fleet_id':    fleetId,
        'event_type':  eventType,
        'severity':    severity,
        'title':       title,
        'description': description,
        'metadata':    metadata,
      });
    } catch (e) {
      print('createVehicleEvent error: $e');
    }
  }
}
