import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/models/threshold.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/services/notification_service.dart';

class SensorProvider extends ChangeNotifier {
  final OBDService _obdService = OBDService();
  final SupabaseService _supabaseService = SupabaseService();
  final NotificationService _notificationService = NotificationService();

  final Map<SensorType, SensorData> _latestSensorData = {};
  StreamSubscription? _sensorSubscription;
  String? _currentVehicleId;
  String? _currentVehicleName;
  List<Threshold> _thresholds = [];

  Map<SensorType, SensorData> get latestSensorData => _latestSensorData;
  bool get isMonitoring => _sensorSubscription != null;

  void startMonitoring(String vehicleId, String vehicleName, List<Threshold> thresholds) {
    if (_sensorSubscription != null) {
      return;
    }

    _currentVehicleId = vehicleId;
    _currentVehicleName = vehicleName;
    _thresholds = thresholds;

    _sensorSubscription = _obdService.sensorDataStream.listen((sensorData) {
      _latestSensorData[sensorData.type] = sensorData;
      _checkThresholds(sensorData);
      notifyListeners();

      _supabaseService.saveSensorData(vehicleId, sensorData);
    });

    _obdService.startPolling();
  }

  void stopMonitoring() {
    _sensorSubscription?.cancel();
    _sensorSubscription = null;
    _obdService.stopPolling();
    _latestSensorData.clear();
    notifyListeners();
  }

  void _checkThresholds(SensorData sensorData) {
    final threshold = _thresholds.firstWhere(
      (t) => t.sensorType == sensorData.type,
      orElse: () => Threshold(
        id: '',
        vehicleId: '',
        sensorType: sensorData.type,
        enabled: false,
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      ),
    );

    if (threshold.enabled && threshold.isViolated(sensorData.value)) {
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

  SensorData? getSensorData(SensorType type) {
    return _latestSensorData[type];
  }

  @override
  void dispose() {
    stopMonitoring();
    super.dispose();
  }
}
