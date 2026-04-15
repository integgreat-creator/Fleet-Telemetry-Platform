import 'dart:math';
import 'package:flutter/foundation.dart';
import 'supabase_service.dart';

/// Detects trip boundaries from real OBD speed readings and GPS waypoints,
/// then writes a row to the `trips` table when a trip ends.
///
/// Trip lifecycle:
///   START  – first reading with speed ≥ [_minSpeedKmh] after being stopped
///   ACTIVE – accumulates distance (Haversine from GPS waypoints) and speed stats
///   END    – speed stays < [_minSpeedKmh] for ≥ [_stopThreshold] seconds,
///             OR [finish()] is called explicitly when the OBD disconnects
///
/// Only trips with duration ≥ 60 s AND distance ≥ 0.1 km are persisted.
class TripRecorder {
  TripRecorder({
    required this.vehicleId,
    required this.supabaseService,
    this.driverAccountId,
    this.onTripSaved,
  });

  final String vehicleId;
  final String? driverAccountId;
  final SupabaseService supabaseService;

  /// Called after a trip is successfully persisted.
  /// Receives the new trip UUID (null if the DB insert failed), the trip start
  /// time, and the trip end time — so the caller can link a
  /// [DriverBehaviourRecorder] record to this trip.
  final void Function(String? tripId, DateTime tripStart, DateTime tripEnd)?
      onTripSaved;

  // ── Tuning constants ──────────────────────────────────────────────────────
  static const double _minSpeedKmh  = 5.0;          // speed threshold to start/stop
  static const int    _stopSeconds  = 60;            // seconds at <5 km/h to end trip
  static const double _minDistanceKm = 0.1;          // minimum trip distance to save
  static const int    _minDurationSec = 60;          // minimum trip duration to save

  // ── Trip state ────────────────────────────────────────────────────────────
  bool      _tripActive     = false;
  DateTime? _tripStartTime;
  DateTime? _lastMovingTime;

  // GPS waypoints
  double? _startLat, _startLng;
  double? _lastLat,  _lastLng;
  double  _distanceKm = 0;

  // Speed stats (from OBD)
  double _speedSum   = 0;
  int    _speedCount = 0;
  double _maxSpeed   = 0;

  bool get isTripActive => _tripActive;

  // ── Speed feed (from OBD sensor stream) ───────────────────────────────────

  /// Call for every OBD speed reading (km/h).
  Future<void> onSpeedReading(double speedKmh, DateTime timestamp) async {
    if (speedKmh >= _minSpeedKmh) {
      _lastMovingTime = timestamp;
      if (!_tripActive) _startTrip(timestamp);

      _speedSum   += speedKmh;
      _speedCount++;
      if (speedKmh > _maxSpeed) _maxSpeed = speedKmh;
    } else {
      // Check if stopped long enough to end trip
      if (_tripActive && _lastMovingTime != null) {
        final stoppedSec = timestamp.difference(_lastMovingTime!).inSeconds;
        if (stoppedSec >= _stopSeconds) {
          await _endTrip(timestamp);
        }
      }
    }
  }

  // ── GPS feed (from LocationService) ──────────────────────────────────────

  /// Call for every GPS fix. Updates distance accumulator.
  void onLocationReading(double lat, double lng) {
    if (!_tripActive) return;

    _startLat ??= lat;
    _startLng ??= lng;

    if (_lastLat != null && _lastLng != null) {
      _distanceKm += _haversineKm(_lastLat!, _lastLng!, lat, lng);
    }
    _lastLat = lat;
    _lastLng = lng;
  }

  // ── Explicit finish (OBD disconnect / app going to background) ────────────

  /// Call when OBD disconnects or monitoring stops to close any open trip.
  Future<void> finish() async {
    if (_tripActive) await _endTrip(DateTime.now());
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  void _startTrip(DateTime startTime) {
    _tripActive    = true;
    _tripStartTime = startTime;
    _distanceKm    = 0;
    _speedSum      = 0;
    _speedCount    = 0;
    _maxSpeed      = 0;
    _startLat = _startLng = null;
    _lastLat  = _lastLng  = null;
    debugPrint('TripRecorder: trip started at $startTime');
  }

  Future<void> _endTrip(DateTime endTime) async {
    if (!_tripActive || _tripStartTime == null) return;
    _tripActive = false;

    final durationSec = endTime.difference(_tripStartTime!).inSeconds;
    final avgSpeed    = _speedCount > 0 ? _speedSum / _speedCount : 0.0;

    debugPrint(
      'TripRecorder: trip ended — '
      '${durationSec}s, ${_distanceKm.toStringAsFixed(2)} km',
    );

    // Discard noise (very short stops / accidental presses)
    if (durationSec < _minDurationSec || _distanceKm < _minDistanceKm) {
      debugPrint('TripRecorder: trip too short, discarding');
      _tripStartTime = null;
      return;
    }

    String? tripId;
    try {
      tripId = await supabaseService.saveTrip(
        vehicleId:        vehicleId,
        driverAccountId:  driverAccountId,
        startTime:        _tripStartTime!,
        endTime:          endTime,
        distanceKm:       _distanceKm,
        durationSeconds:  durationSec,
        avgSpeedKmh:      avgSpeed,
        maxSpeedKmh:      _maxSpeed,
        startLat:         _startLat,
        startLng:         _startLng,
        endLat:           _lastLat,
        endLng:           _lastLng,
      );
      debugPrint('TripRecorder: trip saved to DB (id=$tripId)');
    } catch (e) {
      debugPrint('TripRecorder: failed to save trip — $e');
    }

    onTripSaved?.call(tripId, _tripStartTime!, endTime);
    _tripStartTime = null;
  }

  // ── Haversine formula ─────────────────────────────────────────────────────

  static double _haversineKm(
    double lat1, double lng1,
    double lat2, double lng2,
  ) {
    const r = 6371.0; // Earth radius in km
    final dLat = _toRad(lat2 - lat1);
    final dLng = _toRad(lng2 - lng1);
    final a = sin(dLat / 2) * sin(dLat / 2) +
              cos(_toRad(lat1)) * cos(_toRad(lat2)) *
              sin(dLng / 2) * sin(dLng / 2);
    final c = 2 * atan2(sqrt(a), sqrt(1 - a));
    return r * c;
  }

  static double _toRad(double deg) => deg * pi / 180;
}
