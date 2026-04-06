import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';

/// Abstract repository — makes Flutter code testable and decoupled from Supabase
abstract class VehicleRepository {
  Future<List<Vehicle>> getVehicles();
  Future<Map<Vehicle, List<Threshold>>> getVehiclesWithThresholds();
  Future<Vehicle?> createVehicle(Vehicle vehicle);
  Future<Vehicle?> updateVehicle(Vehicle vehicle);
  Future<bool> deleteVehicle(String vehicleId);
  Future<List<Threshold>> getThresholds(String vehicleId);
  Future<bool> saveSensorData(String vehicleId, dynamic sensorData);
  Future<void> flushOfflineQueue();
  Future<int> getOfflineQueueLength();
}

/// Production implementation backed by Supabase
class SupabaseVehicleRepository implements VehicleRepository {
  final SupabaseService _service;
  SupabaseVehicleRepository({SupabaseService? service})
      : _service = service ?? SupabaseService();

  @override
  Future<List<Vehicle>> getVehicles() => _service.getVehicles();

  @override
  Future<Map<Vehicle, List<Threshold>>> getVehiclesWithThresholds() =>
      _service.getVehiclesWithThresholds();

  @override
  Future<Vehicle?> createVehicle(Vehicle vehicle) =>
      _service.createVehicle(vehicle);

  @override
  Future<Vehicle?> updateVehicle(Vehicle vehicle) =>
      _service.updateVehicle(vehicle);

  @override
  Future<bool> deleteVehicle(String vehicleId) =>
      _service.deleteVehicle(vehicleId);

  @override
  Future<List<Threshold>> getThresholds(String vehicleId) =>
      _service.getThresholds(vehicleId);

  @override
  Future<bool> saveSensorData(String vehicleId, dynamic sensorData) =>
      _service.saveSensorData(vehicleId, sensorData);

  @override
  Future<void> flushOfflineQueue() => _service.flushOfflineQueue();

  @override
  Future<int> getOfflineQueueLength() => _service.getOfflineQueueLength();
}

/// In-memory mock — use in unit tests and widget tests
class MockVehicleRepository implements VehicleRepository {
  List<Vehicle> mockVehicles;
  MockVehicleRepository({List<Vehicle>? vehicles})
      : mockVehicles = vehicles ?? [];

  @override
  Future<List<Vehicle>> getVehicles() async => List.from(mockVehicles);

  @override
  Future<Map<Vehicle, List<Threshold>>> getVehiclesWithThresholds() async =>
      {for (final v in mockVehicles) v: []};

  @override
  Future<Vehicle?> createVehicle(Vehicle vehicle) async {
    mockVehicles.add(vehicle);
    return vehicle;
  }

  @override
  Future<Vehicle?> updateVehicle(Vehicle vehicle) async {
    final idx = mockVehicles.indexWhere((v) => v.id == vehicle.id);
    if (idx != -1) mockVehicles[idx] = vehicle;
    return vehicle;
  }

  @override
  Future<bool> deleteVehicle(String vehicleId) async {
    mockVehicles.removeWhere((v) => v.id == vehicleId);
    return true;
  }

  @override
  Future<List<Threshold>> getThresholds(String vehicleId) async => [];

  @override
  Future<bool> saveSensorData(String vehicleId, dynamic sensorData) async =>
      true;

  @override
  Future<void> flushOfflineQueue() async {}

  @override
  Future<int> getOfflineQueueLength() async => 0;
}
