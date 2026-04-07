import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

class VehicleProvider extends ChangeNotifier {
  final SupabaseService _supabaseService = SupabaseService();

  List<Vehicle> _vehicles = [];
  Vehicle? _selectedVehicle;
  Map<String, List<Threshold>> _thresholds = {};
  bool _isLoading = false;

  /// Supabase Realtime channel for live threshold updates on the selected vehicle.
  RealtimeChannel? _thresholdChannel;

  List<Vehicle> get vehicles => _vehicles;
  Vehicle? get selectedVehicle => _selectedVehicle;
  List<Threshold> get selectedVehicleThresholds =>
      _thresholds[_selectedVehicle?.id] ?? [];
  bool get isLoading => _isLoading;

  Future<void> loadVehicles() async {
    _isLoading = true;
    notifyListeners();

    // N+1 FIX: single joined query fetches vehicles + all their thresholds
    final vehiclesWithThresholds =
        await _supabaseService.getVehiclesWithThresholds();

    _vehicles = vehiclesWithThresholds.keys.toList();
    // Cache thresholds for every vehicle in one shot
    for (final entry in vehiclesWithThresholds.entries) {
      _thresholds[entry.key.id] = entry.value;
    }

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

    // Thresholds already loaded by loadVehicles() — no extra query needed
  }

  /// Selects a vehicle by its ID. Used after invite acceptance and driver login.
  Future<void> selectVehicleById(String vehicleId) async {
    final idx = _vehicles.indexWhere((v) => v.id == vehicleId);
    if (idx != -1) {
      await selectVehicle(_vehicles[idx]);
    }
  }

  Future<void> selectVehicle(Vehicle vehicle) async {
    _selectedVehicle = vehicle;

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('selected_vehicle_id', vehicle.id);

    await loadThresholds(vehicle.id);

    // Start Realtime subscription so threshold changes on the web dashboard
    // are pushed to the mobile app automatically (within ~1 second).
    _subscribeToThresholdUpdates(vehicle.id);

    notifyListeners();
  }

  // ── Realtime threshold subscription ──────────────────────────────────────

  /// Subscribes to INSERT/UPDATE/DELETE events on the thresholds table
  /// for the given vehicle. Re-fetches thresholds on any change.
  void _subscribeToThresholdUpdates(String vehicleId) {
    _unsubscribeThresholds(); // cancel any previous subscription first

    _thresholdChannel = Supabase.instance.client
        .channel('thresholds:vehicle:$vehicleId')
        .onPostgresChanges(
          event: PostgresChangeEvent.all,
          schema: 'public',
          table: 'thresholds',
          filter: PostgresChangeFilter(
            type: PostgresChangeFilterType.eq,
            column: 'vehicle_id',
            value: vehicleId,
          ),
          callback: (_) async {
            // Re-load thresholds whenever the fleet manager changes them
            await loadThresholds(vehicleId);
          },
        )
        .subscribe();
  }

  void _unsubscribeThresholds() {
    _thresholdChannel?.unsubscribe();
    _thresholdChannel = null;
  }

  @override
  void dispose() {
    _unsubscribeThresholds();
    super.dispose();
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
}
