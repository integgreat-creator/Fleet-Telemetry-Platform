// Fleet Telemetry – unit tests for the sensor data model.
//
// These tests cover the SensorData model's serialisation/deserialisation and
// the OBD sensor-name → SensorType lookup used by OBDService, so we get
// meaningful CI feedback without requiring a live Supabase connection.

import 'package:flutter_test/flutter_test.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

void main() {
  group('SensorData model', () {
    test('toJson / fromJson round-trip preserves all fields', () {
      final original = SensorData(
        type: SensorType.rpm,
        value: 2500.0,
        timestamp: DateTime.utc(2026, 3, 12, 10, 0, 0),
        isWarning: false,
      );

      final json = original.toJson();
      final restored = SensorData.fromJson(json);

      expect(restored.type, equals(SensorType.rpm));
      expect(restored.value, equals(2500.0));
      expect(restored.timestamp, equals(original.timestamp));
      expect(restored.isWarning, isFalse);
    });

    test('copyWith only changes specified field', () {
      final base = SensorData(
        type: SensorType.coolantTemp,
        value: 90.0,
        timestamp: DateTime.now(),
      );
      final warned = base.copyWith(isWarning: true);

      expect(warned.type, equals(base.type));
      expect(warned.value, equals(base.value));
      expect(warned.isWarning, isTrue);
    });

    test('every SensorType has a non-empty display name', () {
      for (final type in SensorType.values) {
        final sd = SensorData(
          type: type,
          value: 0,
          timestamp: DateTime.now(),
        );
        expect(
          sd.name,
          isNotEmpty,
          reason: 'SensorType.${type.name} has no display name',
        );
      }
    });

    test('every SensorType has a category', () {
      for (final type in SensorType.values) {
        final sd = SensorData(
          type: type,
          value: 0,
          timestamp: DateTime.now(),
        );
        expect(
          sd.category,
          isNotEmpty,
          reason: 'SensorType.${type.name} has no category',
        );
      }
    });

    test('OBD sensor names match SensorType.name (used by OBDService lookup)', () {
      // Spot-check the exact string keys emitted by OBDCommandEngine tier maps
      // to ensure the zero-maintenance enum lookup in OBDService resolves them.
      const obdNames = [
        'rpm', 'speed', 'engineLoad', 'coolantTemp', 'intakeAirTemp',
        'throttlePosition', 'maf', 'fuelLevel', 'controlModuleVoltage',
        'shortFuelTrim', 'longFuelTrim', 'manifoldPressure',
        'relativeThrottlePosition', 'acceleratorPedalPositionD', 'engineOilTemp',
        'timingAdvance', 'fuelPressure', 'barometricPressure', 'absoluteLoad',
        'commandedAirFuelRatio', 'ambientTemp', 'absoluteThrottlePositionB',
        'absoluteThrottlePositionC', 'commandedThrottleActuator',
        'relativeAcceleratorPosition', 'hybridBatteryLife', 'fuelInjectionTiming',
        'engineFuelRate', 'driverDemandTorque', 'actualEngineTorque',
        'engineReferenceTorque', 'commandedEGR', 'egrError', 'commandedEvapPurge',
        'o2Sensor1Voltage', 'o2Sensor2Voltage', 'catalystTempBank1', 'catalystTempBank2',
        'distanceSinceMIL', 'engineRuntime', 'warmupsSinceDTCCleared',
        'distanceSinceDTCCleared', 'evapSystemVaporPressure',
        'absoluteEvapSystemPressure', 'evapSystemPressure2', 'ethanolFuelPercent',
        'fuelRailAbsolutePressure', 'runTimeWithMIL', 'timeSinceDTCCleared',
        'fuelType', 'emissionRequirements', 'exhaustPressure',
        'exhaustGasTempBank1', 'exhaustGasTempBank2', 'turbochargerCompressorInlet',
        'boostPressureControl', 'variableGeometryTurboControl', 'wastegateControl',
        'transmissionGear', 'odometerReading', 'noxSensorConcentration',
        'cylinderFuelRate', 'fuelSystemControl', 'fuelPressureControlSystem',
        'injectionPressureControlSystem', 'monitorStatusSinceDTCCleared',
        'fuelSystemStatus', 'monitorStatusDriveCycle', 'auxiliaryInputStatus',
      ];

      final nameToType = {for (final t in SensorType.values) t.name: t};

      for (final name in obdNames) {
        expect(
          nameToType.containsKey(name),
          isTrue,
          reason: 'OBD sensor name "$name" has no matching SensorType enum value',
        );
      }
    });
  });
}
