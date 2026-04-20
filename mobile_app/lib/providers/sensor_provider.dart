import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/services/notification_service.dart';
import 'package:vehicle_telemetry/services/location_service.dart';
import 'package:vehicle_telemetry/services/heartbeat_service.dart';
import 'package:vehicle_telemetry/services/fuel_monitor_service.dart';
import 'package:vehicle_telemetry/services/movement_anomaly_service.dart';

// Driver-behaviour thresholds — update here if calibration changes.
const double _kHarshBrakingDeltaKmh    = 15.0;
const double _kHarshAccelDeltaKmh      = 20.0;
const double _kExcessiveRpmThreshold   = 4000.0;
const double _kExcessiveSpeedKmh       = 120.0;

class SensorProvider extends ChangeNotifier {
  final OBDService               _obdService              = OBDService();
  final SupabaseService          _supabaseService         = SupabaseService();
  final NotificationService      _notificationService     = NotificationService();
  final LocationService          _locationService         = LocationService();
  final HeartbeatService         _heartbeatService        = HeartbeatService();
  final MovementAnomalyService   _movementAnomalyService  = MovementAnomalyService();
  final FuelMonitorService       _fuelMonitorService      = FuelMonitorService();

  // ── Sensor state ────────────────────────────────────────────────────────
  final Map<SensorType, SensorData> _latestSensorData = {};
  StreamSubscription? _batchSubscription;
  String? _currentVehicleId;
  String? _currentVehicleName;
  List<Threshold> _thresholds = [];

  // ── Realtime threshold sync ─────────────────────────────────────────────
  RealtimeChannel? _thresholdChannel;

  // ── Driver behavior tracking ────────────────────────────────────────────
  // Per-session event counters and rolling engine-load average.
  double?  _prevSpeed;
  int      _harshBrakingCount     = 0;
  int      _harshAccelCount       = 0;
  int      _excessiveRpmCount     = 0;
  int      _excessiveSpeedCount   = 0;
  double   _engineLoadSum         = 0;
  int      _engineLoadReadings    = 0;
  String?  _behaviorSessionId;
  Timer?   _behaviorSyncTimer;
  DateTime? _tripStart;

  // ── Public getters ──────────────────────────────────────────────────────
  Map<SensorType, SensorData> get latestSensorData => _latestSensorData;
  bool get isMonitoring => _batchSubscription != null;

  // ══════════════════════════════════════════════════════════════════════════
  // startMonitoring
  // ══════════════════════════════════════════════════════════════════════════

  /// Start listening to OBD sensor data.
  ///
  /// [vehicleId] / [vehicleName] / [thresholds] are optional.  Sensor readings
  /// are always displayed on the dashboard; Supabase upload, threshold alerts,
  /// driver-behavior detection, and Realtime threshold sync are only active
  /// when a vehicle is provided.
  void startMonitoring([
    String?         vehicleId,
    String?         vehicleName,
    List<Threshold> thresholds = const [],
  ]) {
    if (_batchSubscription != null) return;

    _currentVehicleId   = vehicleId;
    _currentVehicleName = vehicleName;
    _thresholds         = List.of(thresholds);

    // ── Subscribe to Realtime threshold changes ───────────────────────────
    if (vehicleId != null) {
      _subscribeToThresholds(vehicleId);
    }

    // ── Subscribe to OBD sensor batch stream ─────────────────────────────
    _batchSubscription = _obdService.sensorBatchStream.listen((batch) {
      batch.forEach((type, sensorData) {
        _latestSensorData[type] = sensorData;
        _checkThresholds(sensorData);
      });

      _detectDriverEvents(batch);   // driver behavior analysis
      notifyListeners();

      if (_currentVehicleId != null) {
        _supabaseService.saveSensorBatch(_currentVehicleId!, batch);

        // Keep LocationService informed of ignition state for vehicle_locations.
        _locationService.updateIgnitionStatus(batch[SensorType.rpm]?.value);

        // Real-time movement anomaly detection (GPS mismatch + excessive idle).
        _movementAnomalyService.update(
          vehicleId:   _currentVehicleId!,
          obdRpm:      batch[SensorType.rpm]?.value,
          obdSpeedKmh: batch[SensorType.speed]?.value,
          gpsPosition: _locationService.lastPosition,
        );

        // Real-time fuel monitoring (refuel + theft detection).
        _fuelMonitorService.update(
          vehicleId:   _currentVehicleId!,
          fuelPct:     batch[SensorType.fuelLevel]?.value,
          obdSpeedKmh: batch[SensorType.speed]?.value,
        );
      }
    });

    _obdService.startPolling();

    // ── Start driver behavior session ─────────────────────────────────────
    if (vehicleId != null) {
      _tripStart = DateTime.now();
      _resetBehaviorCounters();
      _behaviorSessionId = await _supabaseService
          .createDriverBehaviorSession(vehicleId, _tripStart!);

      // Periodic DB sync every 60 s so data is never stale by more than 1 min.
      _behaviorSyncTimer = Timer.periodic(
        const Duration(seconds: 60),
        (_) => _syncDriverBehavior(),
      );

      // Start GPS trip tracking in parallel — failure is non-fatal.
      _locationService.startTrip(vehicleId);

      // Start 10-second heartbeat so backend can detect unexpected silence.
      _heartbeatService.start(vehicleId);

      // Start real-time movement anomaly detection.
      _movementAnomalyService.start(vehicleId);

      // Start real-time fuel monitoring.
      _fuelMonitorService.start(vehicleId);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // setVehicle — switch vehicle without stopping OBD polling
  // ══════════════════════════════════════════════════════════════════════════

  void setVehicle(
    String         vehicleId,
    String         vehicleName,
    List<Threshold> thresholds,
  ) {
    final wasMonitoring = _batchSubscription != null;
    if (wasMonitoring) {
      _batchSubscription?.cancel();
      _batchSubscription = null;
    }
    startMonitoring(vehicleId, vehicleName, thresholds);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // stopMonitoring
  // ══════════════════════════════════════════════════════════════════════════

  void stopMonitoring() {
    // Final driver-behavior sync and trip close before clearing state.
    _syncDriverBehavior();
    if (_behaviorSessionId != null) {
      _supabaseService.closeDriverBehaviorSession(_behaviorSessionId!);
    }

    // Report normal disconnect for anti-tamper tracking.
    if (_currentVehicleId != null) {
      final lastRpm = _latestSensorData[SensorType.rpm]?.value;
      _supabaseService.reportNormalDisconnect(_currentVehicleId!, lastRpm: lastRpm);
    }

    // End GPS trip tracking.
    _locationService.endTrip();

    // Stop heartbeat loop.
    _heartbeatService.stop();

    // Stop movement anomaly detection (resolves any open excessive_idle event).
    _movementAnomalyService.stop();

    // Stop fuel monitoring.
    _fuelMonitorService.stop();

    _behaviorSyncTimer?.cancel();
    _behaviorSyncTimer   = null;
    _behaviorSessionId   = null;
    _resetBehaviorCounters();
    _prevSpeed = null;

    // Cancel Realtime subscription.
    _thresholdChannel?.unsubscribe();
    _thresholdChannel = null;

    _batchSubscription?.cancel();
    _batchSubscription = null;
    _obdService.stopPolling();
    _latestSensorData.clear();
    notifyListeners();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Realtime threshold sync
  // ══════════════════════════════════════════════════════════════════════════

  void _subscribeToThresholds(String vehicleId) {
    _thresholdChannel = SupabaseConfig.client
        .channel('thresholds-$vehicleId')
        .onPostgresChanges(
          event:  PostgresChangeEvent.all,
          schema: 'public',
          table:  'thresholds',
          filter: PostgresChangeFilter(
            type:   PostgresChangeFilterType.eq,
            column: 'vehicle_id',
            value:  vehicleId,
          ),
          callback: (PostgresChangePayload payload) {
            // Reload from DB on any INSERT / UPDATE / DELETE so the mobile app
            // picks up threshold changes made by the fleet manager on the web
            // dashboard without requiring the driver to reconnect.
            _supabaseService.getThresholds(vehicleId).then((updated) {
              _thresholds = updated;
              debugPrint(
                'SensorProvider: thresholds reloaded via Realtime — '
                '${_thresholds.length} rules active',
              );
            }).catchError((e) {
              debugPrint('SensorProvider: threshold reload failed — $e (retaining previous thresholds)');
            });
          },
        )
        .subscribe();
    debugPrint('SensorProvider: subscribed to Realtime thresholds for $vehicleId');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Threshold checking
  // ══════════════════════════════════════════════════════════════════════════

  void _checkThresholds(SensorData sensorData) {
    final threshold = _thresholds.firstWhere(
      (t) => t.sensorType == sensorData.type,
      orElse: () => Threshold(
        id:         '',
        vehicleId:  '',
        sensorType: sensorData.type,
        enabled:    false,
        createdAt:  DateTime.now(),
        updatedAt:  DateTime.now(),
      ),
    );

    if (threshold.enabled && threshold.isViolated(sensorData.value)) {
      final warned = sensorData.copyWith(isWarning: true);
      _latestSensorData[sensorData.type] = warned;

      _notificationService.showThresholdAlert(
        warned,
        _currentVehicleName ?? 'Vehicle',
      );

      if (_currentVehicleId != null) {
        _supabaseService.createAlert(
          _currentVehicleId!,
          warned,
          '${sensorData.name} exceeded threshold: '
          '${sensorData.value.toStringAsFixed(1)} ${sensorData.unit}',
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Driver behavior detection
  // ══════════════════════════════════════════════════════════════════════════

  /// Analyse each sensor batch for driving events and update running counters.
  ///
  /// Thresholds used for event detection (tuned for typical OBD poll rates):
  ///   • Harsh braking:      speed drops  > 15 km/h per cycle
  ///   • Harsh acceleration: speed gains  > 20 km/h per cycle
  ///   • Excessive RPM:      rpm          > 4 000
  ///   • Excessive speed:    speed        > 120 km/h
  void _detectDriverEvents(Map<SensorType, SensorData> batch) {
    final speed       = batch[SensorType.speed]?.value;
    final rpm         = batch[SensorType.rpm]?.value;
    final engineLoad  = batch[SensorType.engineLoad]?.value;
    bool  eventFired  = false;

    if (speed != null && _prevSpeed != null) {
      final delta = speed - _prevSpeed!;
      if (_prevSpeed! - speed > _kHarshBrakingDeltaKmh) {   // harsh braking
        _harshBrakingCount++;
        eventFired = true;
        debugPrint('Driver event: harsh braking (Δ${(speed - _prevSpeed!).abs().toStringAsFixed(1)} km/h)');
      }
      if (delta > _kHarshAccelDeltaKmh) {                 // harsh acceleration
        _harshAccelCount++;
        eventFired = true;
        debugPrint('Driver event: harsh acceleration (Δ${delta.toStringAsFixed(1)} km/h)');
      }
    }

    if (rpm != null && rpm > _kExcessiveRpmThreshold) {    // excessive RPM
      _excessiveRpmCount++;
      eventFired = true;
    }

    if (speed != null && speed > _kExcessiveSpeedKmh) { // excessive speed
      _excessiveSpeedCount++;
      eventFired = true;
    }

    if (engineLoad != null) {
      _engineLoadSum += engineLoad;
      _engineLoadReadings++;
    }

    _prevSpeed = speed;

    // Flush to DB immediately on event; periodic timer handles the rest.
    if (eventFired && _behaviorSessionId != null) {
      _syncDriverBehavior();
    }
  }

  /// Push the latest counters to the driver_behavior row in Supabase.
  Future<void> _syncDriverBehavior() async {
    if (_behaviorSessionId == null || _currentVehicleId == null) return;
    final avgLoad = _engineLoadReadings > 0
        ? _engineLoadSum / _engineLoadReadings
        : 0.0;
    await _supabaseService.updateDriverBehavior(
      sessionId:          _behaviorSessionId!,
      harshBrakingCount:  _harshBrakingCount,
      harshAccelCount:    _harshAccelCount,
      excessiveRpmCount:  _excessiveRpmCount,
      excessiveSpeedCount: _excessiveSpeedCount,
      avgEngineLoad:      avgLoad,
    );
  }

  void _resetBehaviorCounters() {
    _harshBrakingCount   = 0;
    _harshAccelCount     = 0;
    _excessiveRpmCount   = 0;
    _excessiveSpeedCount = 0;
    _engineLoadSum       = 0;
    _engineLoadReadings  = 0;
    _tripStart           = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════════════════════

  SensorData? getSensorData(SensorType type) => _latestSensorData[type];

  @override
  void dispose() {
    stopMonitoring();
    super.dispose();
  }
}
