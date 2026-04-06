import 'package:vehicle_telemetry/config/supabase_config.dart';

abstract class SensorRepository {
  Future<List<Map<String, dynamic>>> getSensorRegistry(String vehicleId);
  Future<List<Map<String, dynamic>>> getRecentReadings({
    required String vehicleId,
    required String sensorType,
    int limit = 100,
  });
  Future<void> updateDeviceHealth({
    required String vehicleId,
    String deviceType,
    int? signalStrength,
    double? batteryLevel,
    bool isOnline,
  });
}

class SupabaseSensorRepository implements SensorRepository {
  final _client = SupabaseConfig.client;

  @override
  Future<List<Map<String, dynamic>>> getSensorRegistry(
      String vehicleId) async {
    try {
      final res = await _client
          .from('sensor_registry')
          .select()
          .eq('vehicle_id', vehicleId)
          .order('reading_count', ascending: false);
      return List<Map<String, dynamic>>.from(res as List);
    } catch (e) {
      print('SensorRepository.getSensorRegistry error: $e');
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getRecentReadings({
    required String vehicleId,
    required String sensorType,
    int limit = 100,
  }) async {
    try {
      final res = await _client
          .from('sensor_data')
          .select('value, unit, timestamp')
          .eq('vehicle_id', vehicleId)
          .eq('sensor_type', sensorType)
          .order('timestamp', ascending: false)
          .limit(limit);
      return List<Map<String, dynamic>>.from(res as List);
    } catch (e) {
      print('SensorRepository.getRecentReadings error: $e');
      return [];
    }
  }

  @override
  Future<void> updateDeviceHealth({
    required String vehicleId,
    String deviceType = 'obd2',
    int? signalStrength,
    double? batteryLevel,
    bool isOnline = true,
  }) async {
    try {
      await _client.from('device_health').upsert({
        'vehicle_id':      vehicleId,
        'device_type':     deviceType,
        'signal_strength': signalStrength,
        'battery_level':   batteryLevel,
        'last_ping_at':    DateTime.now().toIso8601String(),
        'is_online':       isOnline,
        'updated_at':      DateTime.now().toIso8601String(),
      }, onConflict: 'vehicle_id,device_type');
    } catch (e) {
      print('SensorRepository.updateDeviceHealth error: $e');
    }
  }
}

class MockSensorRepository implements SensorRepository {
  @override
  Future<List<Map<String, dynamic>>> getSensorRegistry(
          String vehicleId) async =>
      [];

  @override
  Future<List<Map<String, dynamic>>> getRecentReadings({
    required String vehicleId,
    required String sensorType,
    int limit = 100,
  }) async =>
      [];

  @override
  Future<void> updateDeviceHealth({
    required String vehicleId,
    String deviceType = 'obd2',
    int? signalStrength,
    double? batteryLevel,
    bool isOnline = true,
  }) async {}
}
