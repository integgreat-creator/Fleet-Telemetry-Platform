import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

class SupabaseService {
  static final SupabaseService _instance = SupabaseService._internal();
  factory SupabaseService() => _instance;
  SupabaseService._internal();

  final _client = SupabaseConfig.client;

  Future<List<Vehicle>> getVehicles() async {
    try {
      final response = await _client
          .from('vehicles')
          .select()
          .order('created_at', ascending: false);

      return (response as List).map((json) => Vehicle.fromJson(json)).toList();
    } catch (e) {
      print('Error fetching vehicles: $e');
      return [];
    }
  }

  Future<Vehicle?> createVehicle(Vehicle vehicle) async {
    try {
      final response = await _client
          .from('vehicles')
          .insert(vehicle.toJson())
          .select()
          .single();

      return Vehicle.fromJson(response);
    } catch (e) {
      print('Error creating vehicle: $e');
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

  Future<List<Threshold>> getThresholds(String vehicleId) async {
    try {
      final response = await _client
          .from('thresholds')
          .select()
          .eq('vehicle_id', vehicleId);

      return (response as List).map((json) => Threshold.fromJson(json)).toList();
    } catch (e) {
      print('Error fetching thresholds: $e');
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
      print('Error creating threshold: $e');
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
      print('Error updating threshold: $e');
      return null;
    }
  }

  Future<bool> saveSensorData(String vehicleId, SensorData sensorData) async {
    try {
      // ── TRIGGER AI ANALYTICS VIA EDGE FUNCTION ─────────────────────
      // Instead of direct table insert, we call the sensor-api 
      // which performs Real-time Anomaly Detection and Threshold Checks.
      
      final payload = {
        'vehicle_id': vehicleId,
        'sensor_type': sensorData.type.name,
        'value': sensorData.value,
        'unit': sensorData.unit,
        'timestamp': sensorData.timestamp.toIso8601String(),
      };

      await _client.functions.invoke(
        'sensor-api',
        body: payload,
      );
      
      return true;
    } catch (e) {
      print('Error saving sensor data via Edge Function: $e');
      
      // Fallback to direct insert if Edge Function fails (to ensure data persistence)
      try {
        await _client.from('sensor_data').insert({
          'vehicle_id': vehicleId,
          'sensor_type': sensorData.type.name,
          'value': sensorData.value,
          'unit': sensorData.unit,
          'timestamp': sensorData.timestamp.toIso8601String(),
        });
        return true;
      } catch (innerError) {
        print('Direct insert fallback also failed: $innerError');
        return false;
      }
    }
  }

  Future<void> createAlert(String vehicleId, SensorData sensorData, String message) async {
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
      print('Error creating alert: $e');
    }
  }
}
