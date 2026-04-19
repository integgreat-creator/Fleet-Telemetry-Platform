import 'package:vehicle_telemetry/services/location_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';

/// Detects two types of movement anomaly every OBD poll cycle:
///   gps_speed_mismatch — OBD reports movement but GPS is stationary (or vice versa)
///   excessive_idle     — engine running with no movement for > 15 minutes
class MovementAnomalyService {
  static final MovementAnomalyService _instance = MovementAnomalyService._internal();
  factory MovementAnomalyService() => _instance;
  MovementAnomalyService._internal();

  final _supabase = SupabaseService();

  static const _idleThresholdMins  = 15;
  static const _obdMovingKmh       = 10.0;
  static const _gpsMovingKmh       = 5.0;
  static const _engineIdleRpm      = 400.0;
  static const _movingKmh          = 2.0;

  String?   _vehicleId;
  DateTime? _idleStart;
  bool      _excessiveIdleReported = false;

  void start(String vehicleId) {
    _vehicleId             = vehicleId;
    _idleStart             = null;
    _excessiveIdleReported = false;
  }

  void update({
    required String         vehicleId,
    double?                 obdRpm,
    double?                 obdSpeedKmh,
    LocationReading?        gpsPosition,
  }) {
    if (_vehicleId == null) return;

    final gpsSpeedKmh = gpsPosition?.speedKmh;
    final now = DateTime.now();

    // ── GPS / OBD speed mismatch ─────────────────────────────────────────────
    if (obdSpeedKmh != null && gpsSpeedKmh != null) {
      final obdMoving = obdSpeedKmh > _obdMovingKmh;
      final gpsMoving = gpsSpeedKmh > _gpsMovingKmh;
      if (obdMoving && !gpsMoving) {
        _supabase.reportMovementAnomaly(
          vehicleId:   vehicleId,
          eventType:   'gps_speed_mismatch',
          speedObdKmh: obdSpeedKmh,
          speedGpsKmh: gpsSpeedKmh,
        );
      }
    }

    // ── Excessive idle detection ─────────────────────────────────────────────
    final engineOn = (obdRpm ?? 0) > _engineIdleRpm;
    final isMoving = (obdSpeedKmh ?? 0) > _movingKmh ||
                     (gpsSpeedKmh ?? 0) > _movingKmh;

    if (engineOn && !isMoving) {
      _idleStart ??= now;
      final idleMins = now.difference(_idleStart!).inMinutes;
      if (idleMins >= _idleThresholdMins && !_excessiveIdleReported) {
        _excessiveIdleReported = true;
        _supabase.reportMovementAnomaly(
          vehicleId:       vehicleId,
          eventType:       'excessive_idle',
          idleDurationMins: idleMins,
          lastRpm:         obdRpm,
        );
      }
    } else {
      if (_excessiveIdleReported) {
        _supabase.resolveMovementEvent(vehicleId, 'excessive_idle');
      }
      _idleStart             = null;
      _excessiveIdleReported = false;
    }
  }

  void stop() {
    if (_vehicleId != null && _excessiveIdleReported) {
      _supabase.resolveMovementEvent(_vehicleId!, 'excessive_idle');
    }
    _vehicleId             = null;
    _idleStart             = null;
    _excessiveIdleReported = false;
  }
}
