import 'package:flutter/foundation.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

class VehicleProvider extends ChangeNotifier {
  final SupabaseService _supabaseService = SupabaseService();

  List<Vehicle> _vehicles = [];
  Vehicle? _selectedVehicle;
  final Map<String, List<Threshold>> _thresholds = {};
  bool _isLoading = false;

  List<Vehicle> get vehicles => _vehicles;
  Vehicle? get selectedVehicle => _selectedVehicle;
  List<Threshold> get selectedVehicleThresholds =>
      _thresholds[_selectedVehicle?.id] ?? [];
  bool get isLoading => _isLoading;

  Future<void> loadVehicles() async {
    _isLoading = true;
    notifyListeners();

    _vehicles = await _supabaseService.getVehicles();

    if (_vehicles.isNotEmpty && _selectedVehicle == null) {
      await _loadSelectedVehicle();
    }

    _isLoading = false;
    notifyListeners();
  }

  Future<void> _loadSelectedVehicle() async {
    final prefs = await SharedPreferences.getInstance();
    final selectedId = prefs.getString('selected_vehicle_id');

    if (selectedId != null) {
      _selectedVehicle = _vehicles.firstWhere(
        (v) => v.id == selectedId,
        orElse: () => _vehicles.first,
      );
    } else {
      _selectedVehicle = _vehicles.first;
    }

    if (_selectedVehicle != null) {
      await loadThresholds(_selectedVehicle!.id);
    }
  }

  Future<void> selectVehicle(Vehicle vehicle) async {
    _selectedVehicle = vehicle;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('selected_vehicle_id', vehicle.id);

    await loadThresholds(vehicle.id);
    notifyListeners();
  }

  /// Convenience method used after an invite accept — selects the vehicle
  /// with [vehicleId] if it exists in the already-loaded list.
  Future<void> selectVehicleById(String vehicleId) async {
    final match = _vehicles.where((v) => v.id == vehicleId).toList();
    if (match.isNotEmpty) {
      await selectVehicle(match.first);
    }
  }

  Future<bool> createVehicle(Vehicle vehicle) async {
    final created = await _supabaseService.createVehicle(vehicle);
    if (created != null) {
      _vehicles.add(created);

      if (_selectedVehicle == null) {
        await selectVehicle(created);
      }

      notifyListeners();
      return true;
    }
    return false;
  }

  Future<bool> updateVehicle(Vehicle vehicle) async {
    final updated = await _supabaseService.updateVehicle(vehicle);
    if (updated != null) {
      final index = _vehicles.indexWhere((v) => v.id == vehicle.id);
      if (index != -1) {
        _vehicles[index] = updated;
      }

      if (_selectedVehicle?.id == vehicle.id) {
        _selectedVehicle = updated;
      }

      notifyListeners();
      return true;
    }
    return false;
  }

  Future<bool> deleteVehicle(String vehicleId) async {
    final success = await _supabaseService.deleteVehicle(vehicleId);
    if (success) {
      _vehicles.removeWhere((v) => v.id == vehicleId);

      if (_selectedVehicle?.id == vehicleId) {
        _selectedVehicle = _vehicles.isNotEmpty ? _vehicles.first : null;
        if (_selectedVehicle != null) {
          await selectVehicle(_selectedVehicle!);
        }
      }

      notifyListeners();
      return true;
    }
    return false;
  }

  Future<void> loadThresholds(String vehicleId) async {
    final thresholds = await _supabaseService.getThresholds(vehicleId);
    _thresholds[vehicleId] = thresholds;
    notifyListeners();
  }

  Future<bool> createThreshold(Threshold threshold) async {
    final created = await _supabaseService.createThreshold(threshold);
    if (created != null) {
      final vehicleThresholds = _thresholds[threshold.vehicleId] ?? [];
      vehicleThresholds.add(created);
      _thresholds[threshold.vehicleId] = vehicleThresholds;
      notifyListeners();
      return true;
    }
    return false;
  }

  Future<bool> updateThreshold(Threshold threshold) async {
    final updated = await _supabaseService.updateThreshold(threshold);
    if (updated != null) {
      final vehicleThresholds = _thresholds[threshold.vehicleId] ?? [];
      final index = vehicleThresholds.indexWhere((t) => t.id == threshold.id);
      if (index != -1) {
        vehicleThresholds[index] = updated;
        _thresholds[threshold.vehicleId] = vehicleThresholds;
      }
      notifyListeners();
      return true;
    }
    return false;
  }

  Threshold? getThresholdForSensor(String vehicleId, String sensorType) {
    final vehicleThresholds = _thresholds[vehicleId] ?? [];
    try {
      return vehicleThresholds.firstWhere((t) => t.sensorType.name == sensorType);
    } catch (e) {
      return null;
    }
  }

  void clear() {
    _vehicles = [];
    _selectedVehicle = null;
    _thresholds.clear();
    _isLoading = false;
    notifyListeners();
  }

  @override
  void dispose() {
    clear();
    super.dispose();
  }
}
