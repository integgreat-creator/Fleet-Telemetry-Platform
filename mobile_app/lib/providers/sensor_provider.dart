import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/location_service.dart';
import 'package:vehicle_telemetry/services/mock_gps_detector.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/services/notification_service.dart';

class SensorProvider extends ChangeNotifier {
  final OBDService _obdService = OBDService();
  final SupabaseService _supabaseService = SupabaseService();
  final NotificationService _notificationService = NotificationService();
  final LocationService _locationService = LocationService();

  final Map<SensorType, SensorData> _latestSensorData = {};
  StreamSubscription? _sensorSubscription;
  StreamSubscription? _locationSubscription;
  String? _currentVehicleId;
  String? _currentVehicleName;
  String? _currentDriverAccountId;   // MOB-2: for data attribution
  List<Threshold> _thresholds = [];

  // ── Watchdog ──────────────────────────────────────────────────────────────
  Timer? _watchdogTimer;
  DateTime? _lastDataReceivedAt;
  static const Duration _offlineThreshold = Duration(minutes: 2);
  static const Duration _excessiveIdleThreshold = Duration(minutes: 15);
  bool _offlineEventFired = false;

  Map<SensorType, SensorData> get latestSensorData => _latestSensorData;
  bool get isMonitoring => _sensorSubscription != null;

  void startMonitoring(
    String vehicleId,
    String vehicleName,
    List<Threshold> thresholds, {
    String? driverAccountId,   // MOB-2: optional driver attribution
  }) {
    if (_sensorSubscription != null) return;

    _currentVehicleId        = vehicleId;
    _currentVehicleName      = vehicleName;
    _currentDriverAccountId  = driverAccountId;
    _thresholds              = thresholds;
    _lastDataReceivedAt = DateTime.now();
    _offlineEventFired  = false;

    // OBD sensor stream
    _sensorSubscription = _obdService.sensorDataStream.listen((sensorData) {
      _lastDataReceivedAt = DateTime.now();
      _offlineEventFired  = false; // reset on data received
      _latestSensorData[sensorData.type] = sensorData;
      _checkThresholds(sensorData);
      notifyListeners();
      _supabaseService.saveSensorData(
        vehicleId,
        sensorData,
        driverAccountId: _currentDriverAccountId,  // MOB-2
      );
    });

    _obdService.startPolling();

    // GPS heartbeat every 15 seconds
    _locationService.start();
    _locationSubscription = _locationService.locationStream.listen(
      (reading) => _onLocationReading(reading, vehicleId),
    );

    // Watchdog: check every 30 seconds if data has stopped
    _watchdogTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      _checkWatchdog(vehicleId);
    });
  }

  void stopMonitoring() {
    _sensorSubscription?.cancel();
    _sensorSubscription = null;
    _locationSubscription?.cancel();
    _locationSubscription = null;
    _watchdogTimer?.cancel();
    _watchdogTimer = null;
    _obdService.stopPolling();
    _locationService.stop();
    _latestSensorData.clear();
    notifyListeners();
  }

  // ── GPS heartbeat handler ─────────────────────────────────────────────────

  Future<void> _onLocationReading(LocationReading reading, String vehicleId) async {
    // Determine ignition status from last known RPM or speed
    final rpmData   = _latestSensorData[SensorType.rpm];
    final speedData = _latestSensorData[SensorType.speed];
    final ignition  = (rpmData != null && rpmData.value > 0) ||
                      (speedData != null && speedData.value > 0);

    // Detect mock GPS
    bool isMock = reading.isMockGps;
    if (!isMock) {
      isMock = await MockGpsDetector.isMockGps();
    }

    // Save to vehicle_logs
    await _supabaseService.saveVehicleLog(
      vehicleId:        vehicleId,
      latitude:         reading.latitude,
      longitude:        reading.longitude,
      accuracy:         reading.accuracy,
      altitude:         reading.altitude,
      speed:            reading.speedKmh,
      ignitionStatus:   ignition,
      isMockGps:        isMock,
      driverAccountId:  _currentDriverAccountId,  // MOB-2
    );

    // Fire mock GPS event if detected
    if (isMock) {
      await _fireVehicleEvent(
        vehicleId: vehicleId,
        eventType: 'mock_gps_detected',
        title:     'Mock GPS Detected',
        description: 'Device is using a fake GPS provider. Location data may be unreliable.',
        severity:  'critical',
        metadata:  { 'latitude': reading.latitude, 'longitude': reading.longitude },
      );
      _notificationService.showConnectionAlert(
        'Mock GPS Detected',
        'Warning: Fake GPS provider detected on this device.',
      );
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────────

  Future<void> _checkWatchdog(String vehicleId) async {
    if (_lastDataReceivedAt == null) return;

    final elapsed = DateTime.now().difference(_lastDataReceivedAt!);

    if (elapsed >= _offlineThreshold && !_offlineEventFired) {
      _offlineEventFired = true;

      // Check ignition state from last known RPM
      final rpmData = _latestSensorData[SensorType.rpm];
      final ignitionWasOn = rpmData != null && rpmData.value > 0;

      if (ignitionWasOn) {
        // Ignition ON but no data → possible tamper
        await _fireVehicleEvent(
          vehicleId:   vehicleId,
          eventType:   'device_tamper',
          title:       'Possible Device Tampering',
          description: 'Ignition was ON but device stopped transmitting data '
              '${elapsed.inMinutes} minutes ago.',
          severity:    'warning',
          metadata:    {
            'elapsed_minutes': elapsed.inMinutes,
            'last_rpm':        rpmData?.value,
          },
        );
        _notificationService.showConnectionAlert(
          'Possible Tampering',
          'Ignition ON but no sensor data received for ${elapsed.inMinutes} minutes.',
        );
      } else {
        // No ignition data → generic offline
        await _fireVehicleEvent(
          vehicleId:   vehicleId,
          eventType:   'device_offline',
          title:       'Device Offline',
          description: 'No sensor data received for ${elapsed.inMinutes} minutes.',
          severity:    'critical',
          metadata:    { 'elapsed_minutes': elapsed.inMinutes },
        );
        _notificationService.showConnectionAlert(
          'Device Offline',
          'No OBD data received for ${elapsed.inMinutes} minutes.',
        );
      }
    }

    // Check excessive idle: ignition ON, speed = 0 for > 15 minutes
    final speedData = _latestSensorData[SensorType.speed];
    final rpmData   = _latestSensorData[SensorType.rpm];
    if (speedData != null &&
        speedData.value < 1 &&
        rpmData != null &&
        rpmData.value > 300) {
      // Engine running but not moving — check how long
      final speedTimestamp = speedData.timestamp;
      final idleDuration   = DateTime.now().difference(speedTimestamp);
      if (idleDuration >= _excessiveIdleThreshold) {
        await _fireVehicleEvent(
          vehicleId:   vehicleId,
          eventType:   'excessive_idle',
          title:       'Excessive Idle Detected',
          description: 'Engine has been idling for ${idleDuration.inMinutes} minutes '
              'without movement.',
          severity:    'warning',
          metadata:    {
            'idle_minutes': idleDuration.inMinutes,
            'rpm':          rpmData.value,
          },
        );
      }
    }
  }

  Future<void> _fireVehicleEvent({
    required String vehicleId,
    required String eventType,
    required String title,
    required String description,
    String severity = 'warning',
    Map<String, dynamic> metadata = const {},
  }) async {
    final prefs  = await SharedPreferences.getInstance();
    final fleetId = prefs.getString('fleet_id') ?? '';
    await _supabaseService.createVehicleEvent(
      vehicleId:   vehicleId,
      fleetId:     fleetId,
      eventType:   eventType,
      title:       title,
      description: description,
      severity:    severity,
      metadata:    metadata,
    );
  }

  // ── Threshold checking ────────────────────────────────────────────────────

  void _checkThresholds(SensorData sensorData) {
    final threshold = _thresholds.firstWhere(
      (t) => t.sensorType == sensorData.type,
      orElse: () => Threshold(
        id: '',
        vehicleId: '',
        sensorType: sensorData.type,
        alertEnabled: false,
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ),
    );

    if (threshold.alertEnabled && threshold.isViolated(sensorData.value)) {
      final updatedSensorData = sensorData.copyWith(isWarning: true);
      _latestSensorData[sensorData.type] = updatedSensorData;

      _notificationService.showThresholdAlert(
        updatedSensorData,
        _currentVehicleName ?? 'Vehicle',
      );

      if (_currentVehicleId != null) {
        _supabaseService.createAlert(
          _currentVehicleId!,
          updatedSensorData,
          '${sensorData.name} exceeded threshold: ${sensorData.value.toStringAsFixed(1)} ${sensorData.unit}',
        );
      }
    }
  }

  SensorData? getSensorData(SensorType type) => _latestSensorData[type];

  @override
  void dispose() {
    stopMonitoring();
    super.dispose();
  }
}
