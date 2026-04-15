import 'package:flutter/foundation.dart';
import 'supabase_service.dart';

/// Detects real driving-behaviour events from live OBD sensor readings and
/// writes one `driver_behavior` row per completed trip.
///
/// Feed every OBD reading through the matching `on*` method.
/// Call [finalizeTripBehavior] when the [TripRecorder] signals a trip has
/// been saved (it passes the new trip ID so the row can be linked).
///
/// Detection thresholds (all evidence-based, adjustable via constants):
///   Harsh braking       – deceleration  > 20 km/h/s
///   Harsh acceleration  – acceleration  > 15 km/h/s
///   Excessive RPM       – RPM           > 4 500
///   Excessive speed     – speed         > 120 km/h
///   Overspeed           – speed         > 130 km/h
///   Idle                – RPM > 600 AND speed < 2 km/h
class DriverBehaviourRecorder {
  DriverBehaviourRecorder({
    required this.vehicleId,
    required this.supabaseService,
    this.driverAccountId,
  });

  final String vehicleId;
  final String? driverAccountId;
  final SupabaseService supabaseService;

  // ── Thresholds ────────────────────────────────────────────────────────────
  static const double _harshBrakeThreshold   = 20.0;  // km/h/s deceleration
  static const double _harshAccelThreshold   = 15.0;  // km/h/s acceleration
  static const double _excessiveRpmThreshold = 4500.0;
  static const double _excessiveSpeedKmh     = 120.0;
  static const double _overspeedKmh          = 130.0;
  static const double _idleSpeedKmh          = 2.0;   // speed <= this + engine on = idle
  static const double _idleRpmMin            = 600.0;  // RPM floor for "engine on"
  static const int    _harshCooldownSec      = 5;      // min gap between same event type

  // ── Per-trip state ────────────────────────────────────────────────────────
  double?   _prevSpeedKmh;
  DateTime? _prevSpeedTime;

  double _lastSpeed = 0;
  double _lastRpm   = 0;
  DateTime? _idleStartTime;
  double _idleTimeSeconds = 0;

  double _engineLoadSum   = 0;
  int    _engineLoadCount = 0;

  int _harshBrakingCount       = 0;
  int _harshAccelCount         = 0;
  int _excessiveRpmCount       = 0;
  int _excessiveSpeedCount     = 0;
  int _overspeedCount          = 0;

  DateTime? _lastHarshBrakeTime;
  DateTime? _lastHarshAccelTime;
  DateTime? _lastExcessiveRpmTime;
  DateTime? _lastExcessiveSpeedTime;
  DateTime? _lastOverspeedTime;

  // ── Speed feed ────────────────────────────────────────────────────────────

  /// Call for every OBD speed reading (km/h).
  void onSpeedReading(double speedKmh, DateTime timestamp) {
    _lastSpeed = speedKmh;

    if (_prevSpeedKmh != null && _prevSpeedTime != null) {
      final deltaSec = timestamp.difference(_prevSpeedTime!).inMilliseconds / 1000.0;
      if (deltaSec > 0 && deltaSec <= 10) {
        // Only compute within a 10-second window; wider gaps are noise.
        final deltaKmh = speedKmh - _prevSpeedKmh!;
        final rate = deltaKmh / deltaSec; // km/h/s

        if (rate < -_harshBrakeThreshold &&
            !_isOnCooldown(_lastHarshBrakeTime, timestamp, _harshCooldownSec)) {
          _harshBrakingCount++;
          _lastHarshBrakeTime = timestamp;
          debugPrint(
            'DriverBehaviourRecorder: harsh braking '
            '${rate.toStringAsFixed(1)} km/h/s',
          );
        }

        if (rate > _harshAccelThreshold &&
            !_isOnCooldown(_lastHarshAccelTime, timestamp, _harshCooldownSec)) {
          _harshAccelCount++;
          _lastHarshAccelTime = timestamp;
          debugPrint(
            'DriverBehaviourRecorder: harsh acceleration '
            '${rate.toStringAsFixed(1)} km/h/s',
          );
        }
      }
    }

    _prevSpeedKmh  = speedKmh;
    _prevSpeedTime = timestamp;

    // Overspeed / excessive speed
    if (speedKmh > _overspeedKmh &&
        !_isOnCooldown(_lastOverspeedTime, timestamp, _harshCooldownSec)) {
      _overspeedCount++;
      _lastOverspeedTime = timestamp;
      debugPrint('DriverBehaviourRecorder: overspeed ${speedKmh.toStringAsFixed(0)} km/h');
    } else if (speedKmh > _excessiveSpeedKmh &&
        !_isOnCooldown(_lastExcessiveSpeedTime, timestamp, _harshCooldownSec)) {
      _excessiveSpeedCount++;
      _lastExcessiveSpeedTime = timestamp;
    }

    _updateIdleState(timestamp);
  }

  // ── RPM feed ──────────────────────────────────────────────────────────────

  /// Call for every OBD RPM reading.
  void onRpmReading(double rpm, DateTime timestamp) {
    _lastRpm = rpm;

    if (rpm > _excessiveRpmThreshold &&
        !_isOnCooldown(_lastExcessiveRpmTime, timestamp, _harshCooldownSec)) {
      _excessiveRpmCount++;
      _lastExcessiveRpmTime = timestamp;
      debugPrint('DriverBehaviourRecorder: excessive RPM ${rpm.toStringAsFixed(0)}');
    }

    _updateIdleState(timestamp);
  }

  // ── Engine load feed ──────────────────────────────────────────────────────

  /// Call for every engine-load reading (%).
  void onEngineLoadReading(double loadPercent) {
    _engineLoadSum += loadPercent;
    _engineLoadCount++;
  }

  // ── Trip finalisation ──────────────────────────────────────────────────────

  /// Called by [SensorProvider] after [TripRecorder] successfully saves a trip.
  /// Computes the driver score and writes one row to `driver_behavior`.
  Future<void> finalizeTripBehavior({
    String? tripId,
    required DateTime tripStart,
    required DateTime tripEnd,
  }) async {
    // Flush any ongoing idle interval
    if (_idleStartTime != null) {
      final now = tripEnd;
      _idleTimeSeconds += now.difference(_idleStartTime!).inSeconds;
      _idleStartTime = null;
    }

    final avgLoad = _engineLoadCount > 0 ? _engineLoadSum / _engineLoadCount : 0.0;
    final score   = _computeScore();
    final durationSec = tripEnd.difference(tripStart).inSeconds;

    debugPrint(
      'DriverBehaviourRecorder: trip summary — '
      'braking=$_harshBrakingCount, accel=$_harshAccelCount, '
      'exRpm=$_excessiveRpmCount, exSpeed=$_excessiveSpeedCount, '
      'overspeed=$_overspeedCount, idle=${_idleTimeSeconds.toInt()}s, '
      'score=${score.toStringAsFixed(1)}',
    );

    if (durationSec < 30) {
      // Too short to be meaningful
      _reset();
      return;
    }

    try {
      await supabaseService.saveDriverBehaviour(
        vehicleId:               vehicleId,
        driverAccountId:         driverAccountId,
        tripId:                  tripId,
        harshBrakingCount:       _harshBrakingCount,
        harshAccelerationCount:  _harshAccelCount,
        excessiveRpmCount:       _excessiveRpmCount,
        excessiveSpeedCount:     _excessiveSpeedCount,
        overspeedCount:          _overspeedCount,
        idleTimeSeconds:         _idleTimeSeconds.toInt(),
        averageEngineLoad:       avgLoad,
        driverScore:             score,
        tripStart:               tripStart,
        tripEnd:                 tripEnd,
      );
      debugPrint('DriverBehaviourRecorder: saved to DB');
    } catch (e) {
      debugPrint('DriverBehaviourRecorder: save failed — $e');
    }

    _reset();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  void _updateIdleState(DateTime now) {
    final shouldBeIdle = _lastRpm > _idleRpmMin && _lastSpeed < _idleSpeedKmh;
    if (shouldBeIdle && _idleStartTime == null) {
      _idleStartTime = now;
    } else if (!shouldBeIdle && _idleStartTime != null) {
      _idleTimeSeconds += now.difference(_idleStartTime!).inSeconds;
      _idleStartTime = null;
    }
  }

  double _computeScore() {
    const maxIdleMinPenalty = 20.0; // cap idle penalty
    final idleMinutes = (_idleTimeSeconds / 60).clamp(0, maxIdleMinPenalty);

    final raw = 100.0
        - (_harshBrakingCount      * 3.0)
        - (_harshAccelCount        * 2.0)
        - (_excessiveRpmCount      * 1.0)
        - (_excessiveSpeedCount    * 5.0)
        - (_overspeedCount         * 8.0)
        - (idleMinutes             * 0.5);

    return raw.clamp(0.0, 100.0);
  }

  bool _isOnCooldown(DateTime? last, DateTime now, int cooldownSec) {
    if (last == null) return false;
    return now.difference(last).inSeconds < cooldownSec;
  }

  void _reset() {
    _prevSpeedKmh          = null;
    _prevSpeedTime         = null;
    _lastSpeed             = 0;
    _lastRpm               = 0;
    _idleStartTime         = null;
    _idleTimeSeconds       = 0;
    _engineLoadSum         = 0;
    _engineLoadCount       = 0;
    _harshBrakingCount     = 0;
    _harshAccelCount       = 0;
    _excessiveRpmCount     = 0;
    _excessiveSpeedCount   = 0;
    _overspeedCount        = 0;
    _lastHarshBrakeTime    = null;
    _lastHarshAccelTime    = null;
    _lastExcessiveRpmTime  = null;
    _lastExcessiveSpeedTime = null;
    _lastOverspeedTime     = null;
  }
}
