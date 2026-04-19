import 'package:vehicle_telemetry/services/supabase_service.dart';

/// Monitors fuel level changes each OBD poll cycle and reports significant
/// events to Supabase:
///   refuel     — fuel level rose ≥ 10 % (driver filled up)
///   fuel_theft — fuel level dropped ≥ 10 % while the vehicle was stationary
class FuelMonitorService {
  static final FuelMonitorService _instance = FuelMonitorService._internal();
  factory FuelMonitorService() => _instance;
  FuelMonitorService._internal();

  final _supabase = SupabaseService();

  static const _refuelThresholdPct = 10.0;
  static const _theftThresholdPct  = 10.0;
  static const _stationaryKmh     = 5.0;

  double? _lastFuelPct;

  void start(String vehicleId) {
    _lastFuelPct = null;
  }

  void update({
    required String vehicleId,
    double? fuelPct,
    double? obdSpeedKmh,
  }) {
    if (fuelPct == null) return;

    final prev = _lastFuelPct;
    _lastFuelPct = fuelPct;
    if (prev == null) return;

    final delta = fuelPct - prev;
    final speed = obdSpeedKmh ?? 0.0;

    if (delta >= _refuelThresholdPct) {
      _supabase.reportFuelEvent(
        vehicleId: vehicleId,
        type:      'refuel',
        value:     delta,
        message:   'Fuel increased by ${delta.toStringAsFixed(1)} %',
      );
    } else if (delta <= -_theftThresholdPct && speed < _stationaryKmh) {
      _supabase.reportFuelEvent(
        vehicleId: vehicleId,
        type:      'fuel_theft',
        value:     delta.abs(),
        message:   'Fuel dropped by ${delta.abs().toStringAsFixed(1)} % while stationary',
      );
    }
  }

  void stop() {
    _lastFuelPct = null;
  }
}
