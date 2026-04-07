import 'dart:async';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';

class OBDCommand {
  final String command;
  final SensorType sensorType;
  final String unit;
  final double Function(List<int>) parser;

  OBDCommand({
    required this.command,
    required this.sensorType,
    required this.unit,
    required this.parser,
  });
}

class OBDService {
  static final OBDService _instance = OBDService._internal();
  factory OBDService() => _instance;
  OBDService._internal();

  final BluetoothService _bluetoothService = BluetoothService();
  final _sensorDataController = StreamController<SensorData>.broadcast();
  Timer? _pollingTimer;

  final Map<String, String> _responseBuffer = {};
  StreamSubscription? _dataSubscription;

  Stream<SensorData> get sensorDataStream => _sensorDataController.stream;

  final List<OBDCommand> _commands = [

    // ── Existing Sensors ────────────────────────────────────────────

    OBDCommand(
      command: '010C',
      sensorType: SensorType.rpm,
      unit: 'RPM',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) / 4,
    ),
    OBDCommand(
      command: '010D',
      sensorType: SensorType.speed,
      unit: 'km/h',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0105',
      sensorType: SensorType.coolantTemp,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '012F',
      sensorType: SensorType.fuelLevel,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0142',
      sensorType: SensorType.batteryVoltage,
      unit: 'V',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) / 1000,
    ),
    OBDCommand(
      command: '0111',
      sensorType: SensorType.throttlePosition,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '010F',
      sensorType: SensorType.intakeAirTemp,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '0104',
      sensorType: SensorType.engineLoad,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0110',
      sensorType: SensorType.maf,
      unit: 'g/s',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) / 100,
    ),
    OBDCommand(
      command: '010E',
      sensorType: SensorType.timingAdvance,
      unit: '°',
      parser: (bytes) => (bytes[0] / 2) - 64,
    ),
    OBDCommand(
      command: '0106',
      sensorType: SensorType.shortFuelTrim,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '0107',
      sensorType: SensorType.longFuelTrim,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '010B',
      sensorType: SensorType.manifoldPressure,
      unit: 'kPa',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '010A',
      sensorType: SensorType.fuelPressure,
      unit: 'kPa',
      parser: (bytes) => (bytes[0] * 3).toDouble(),
    ),
    OBDCommand(
      command: '0121',
      sensorType: SensorType.distanceSinceMIL,
      unit: 'km',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '011F',
      sensorType: SensorType.engineRuntime,
      unit: 's',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '0146',
      sensorType: SensorType.ambientTemp,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '0143',
      sensorType: SensorType.controlModuleVoltage,
      unit: 'V',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) / 1000,
    ),

    // ── Engine & Performance ─────────────────────────────────────────

    OBDCommand(
      command: '012C',
      sensorType: SensorType.commandedEGR,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '012D',
      sensorType: SensorType.egrError,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '012E',
      sensorType: SensorType.commandedEvapPurge,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0133',
      sensorType: SensorType.barometricPressure,
      unit: 'kPa',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0143',
      sensorType: SensorType.absoluteLoad,
      unit: '%',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 100 / 255,
    ),
    OBDCommand(
      command: '0144',
      sensorType: SensorType.commandedAirFuelRatio,
      unit: 'ratio',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 2 / 65536,
    ),
    OBDCommand(
      command: '0145',
      sensorType: SensorType.relativeThrottlePosition,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0147',
      sensorType: SensorType.absoluteThrottlePositionB,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '014C',
      sensorType: SensorType.commandedThrottleActuator,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '015C',
      sensorType: SensorType.engineOilTemp,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '015E',
      sensorType: SensorType.engineFuelRate,
      unit: 'L/h',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 0.05,
    ),
    OBDCommand(
      command: '0143',
      sensorType: SensorType.absoluteThrottlePositionC,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0148',
      sensorType: SensorType.absoluteThrottlePositionD,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0149',
      sensorType: SensorType.absoluteThrottlePositionE,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0162',
      sensorType: SensorType.actualEngineTorque,
      unit: '%',
      parser: (bytes) => (bytes[0] - 125).toDouble(),
    ),
    OBDCommand(
      command: '0163',
      sensorType: SensorType.engineReferenceTorque,
      unit: 'Nm',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '0164',
      sensorType: SensorType.enginePercentTorque,
      unit: '%',
      parser: (bytes) => (bytes[0] - 125).toDouble(),
    ),
    OBDCommand(
      command: '0167',
      sensorType: SensorType.coolantTemp2,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '016B',
      sensorType: SensorType.exhaustGasTempBank1,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '016C',
      sensorType: SensorType.exhaustGasTempBank2,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '0178',
      sensorType: SensorType.exhaustGasTempSensor,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '017C',
      sensorType: SensorType.dieselParticulateFilterTemp,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '01A2',
      sensorType: SensorType.cylinderFuelRate,
      unit: 'mg/str',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 0.03125,
    ),
    OBDCommand(
      command: '01A8',
      sensorType: SensorType.exhaustPressure,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),

    // ── Fuel & Emissions ─────────────────────────────────────────────

    OBDCommand(
      command: '0114',
      sensorType: SensorType.o2Sensor1Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200,
    ),
    OBDCommand(
      command: '0115',
      sensorType: SensorType.o2Sensor2Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200,
    ),
    OBDCommand(
      command: '0131',
      sensorType: SensorType.distanceSinceDTCCleared,
      unit: 'km',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '013C',
      sensorType: SensorType.catalystTempBank1,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '013D',
      sensorType: SensorType.catalystTempBank2,
      unit: '°C',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 10) - 40,
    ),
    OBDCommand(
      command: '0152',
      sensorType: SensorType.ethanolFuelPercent,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0159',
      sensorType: SensorType.fuelRailAbsolutePressure,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 10,
    ),
    OBDCommand(
      command: '0161',
      sensorType: SensorType.driverDemandTorque,
      unit: '%',
      parser: (bytes) => (bytes[0] - 125).toDouble(),
    ),
    OBDCommand(
      command: '0130',
      sensorType: SensorType.warmupsSinceDTCCleared,
      unit: 'count',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0132',
      sensorType: SensorType.evapSystemVaporPressure,
      unit: 'Pa',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]).toSigned(16)) / 4.0,
    ),
    OBDCommand(
      command: '0153',
      sensorType: SensorType.absoluteEvapSystemPressure,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) / 200.0,
    ),
    OBDCommand(
      command: '0154',
      sensorType: SensorType.evapSystemPressure2,
      unit: 'Pa',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]).toSigned(16)) / 4.0,
    ),
    OBDCommand(
      command: '0155',
      sensorType: SensorType.shortTermSecondaryO2TrimB1,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '0156',
      sensorType: SensorType.longTermSecondaryO2TrimB1,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '0157',
      sensorType: SensorType.shortTermSecondaryO2TrimB2,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '0158',
      sensorType: SensorType.longTermSecondaryO2TrimB2,
      unit: '%',
      parser: (bytes) => ((bytes[0] - 128) * 100) / 128,
    ),
    OBDCommand(
      command: '019D',
      sensorType: SensorType.engineFuelRateAlt,
      unit: 'L/h',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 0.05,
    ),
    OBDCommand(
      command: '01A0',
      sensorType: SensorType.noxSensorConcentration,
      unit: 'ppm',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '01A6',
      sensorType: SensorType.odometerReading,
      unit: 'km',
      parser: (bytes) =>
      ((bytes[0] * 16777216) + (bytes[1] * 65536) +
          (bytes[2] * 256) + bytes[3]) / 10.0,
    ),

    // ── Transmission & Drivetrain ────────────────────────────────────

    OBDCommand(
      command: '01A4',
      sensorType: SensorType.transmissionGear,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '014A',
      sensorType: SensorType.relativeAcceleratorPosition,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '014D',
      sensorType: SensorType.runTimeWithMIL,
      unit: 's',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '014E',
      sensorType: SensorType.timeSinceDTCCleared,
      unit: 's',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '014B',
      sensorType: SensorType.acceleratorPedalPositionD,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '01A3',
      sensorType: SensorType.transmissionTurbineSpeed,
      unit: 'RPM',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]) * 0.25,
    ),
    OBDCommand(
      command: '01A5',
      sensorType: SensorType.transmissionFluidTemp,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '01C0',
      sensorType: SensorType.transmissionTorque,
      unit: 'Nm',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),

    // ── Driver & Safety ──────────────────────────────────────────────

    OBDCommand(
      command: '015A',
      sensorType: SensorType.relativeAcceleratorPedal,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '015B',
      sensorType: SensorType.hybridBatteryLife,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '015D',
      sensorType: SensorType.fuelInjectionTiming,
      unit: '°',
      parser: (bytes) => (((bytes[0] * 256) + bytes[1]) / 128) - 210,
    ),
    OBDCommand(
      command: '016B',
      sensorType: SensorType.exhaustGasRecirculation,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0117',
      sensorType: SensorType.o2Sensor3Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '0118',
      sensorType: SensorType.o2Sensor4Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '0119',
      sensorType: SensorType.o2Sensor5Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '011A',
      sensorType: SensorType.o2Sensor6Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '011B',
      sensorType: SensorType.o2Sensor7Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '011C',
      sensorType: SensorType.o2Sensor8Voltage,
      unit: 'V',
      parser: (bytes) => bytes[0] / 200.0,
    ),
    OBDCommand(
      command: '0168',
      sensorType: SensorType.intakeAirTempSensor2,
      unit: '°C',
      parser: (bytes) => (bytes[0] - 40).toDouble(),
    ),
    OBDCommand(
      command: '016D',
      sensorType: SensorType.fuelPressureControlSystem,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '016E',
      sensorType: SensorType.injectionPressureControlSystem,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '016F',
      sensorType: SensorType.turbochargerCompressorInlet,
      unit: 'kPa',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0170',
      sensorType: SensorType.boostPressureControl,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '0171',
      sensorType: SensorType.variableGeometryTurboControl,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0173',
      sensorType: SensorType.wastegateControl,
      unit: '%',
      parser: (bytes) => (bytes[0] * 100 / 255),
    ),
    OBDCommand(
      command: '0174',
      sensorType: SensorType.exhaustPressureControl,
      unit: 'kPa',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    // ── Vehicle Information ───────────────────────────────────────────

    OBDCommand(
      command: '0151',
      sensorType: SensorType.fuelType,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '01A1',
      sensorType: SensorType.fuelSystemControl,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),

    // ── Diagnostics & DTC ─────────────────────────────────────────────

    OBDCommand(
      command: '0101',
      sensorType: SensorType.monitorStatusSinceDTCCleared,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0102',
      sensorType: SensorType.freezeDTC,
      unit: '',
      parser: (bytes) => ((bytes[0] * 256) + bytes[1]).toDouble(),
    ),
    OBDCommand(
      command: '0103',
      sensorType: SensorType.fuelSystemStatus,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '011D',
      sensorType: SensorType.o2SensorsPresentBank2,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '011E',
      sensorType: SensorType.auxiliaryInputStatus,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
    OBDCommand(
      command: '0141',
      sensorType: SensorType.monitorStatusDriveCycle,
      unit: '',
      parser: (bytes) => bytes[0].toDouble(),
    ),
  ];

  // ── VIN Read (Mode 09, PID 02) ───────────────────────────────────────────

  /// Requests the Vehicle Identification Number via OBD Mode 09 PID 02.
  /// Returns the 17-char VIN string, or null if the adapter / vehicle does
  /// not support the request (common on Indian-market vehicles).
  Future<String?> readVin() async {
    try {
      final completer = Completer<String?>();

      // One-shot listener on the data stream — captures the first non-empty
      // response that arrives after we send the VIN command.
      late StreamSubscription<String> sub;
      sub = _bluetoothService.dataStream.listen((raw) {
        if (completer.isCompleted) return;
        final vin = _parseVinResponse(raw);
        if (vin != null) {
          sub.cancel();
          completer.complete(vin);
        }
      });

      // Send VIN request command (carriage-return terminator required by ELM327)
      await _bluetoothService.sendCommand('0902');

      // Allow up to 3 seconds for a multi-frame ISO 15765 response
      Future.delayed(const Duration(seconds: 3), () {
        if (!completer.isCompleted) {
          sub.cancel();
          completer.complete(null);
        }
      });

      return await completer.future;
    } catch (_) {
      return null;
    }
  }

  /// Parses a raw hex string from the OBD adapter into a VIN.
  /// Handles single-line and multi-frame ISO 15765-4 responses.
  String? _parseVinResponse(String raw) {
    final cleaned = raw.replaceAll(RegExp(r'\s+'), '').toUpperCase();
    if (cleaned.isEmpty ||
        cleaned.contains('NODATA') ||
        cleaned.contains('ERROR') ||
        cleaned.contains('UNABLETOCONNECT')) {
      return null;
    }

    // Strip any non-hex characters ('>','?', line headers, etc.)
    final hexOnly = cleaned.replaceAll(RegExp(r'[^0-9A-F]'), '');

    // Locate the 4902 response marker (Mode 09, PID 02 reply)
    final markerIdx = hexOnly.indexOf('4902');
    if (markerIdx == -1) return null;

    final vinHex = hexOnly.substring(markerIdx + 4);
    if (vinHex.length < 34) return null; // 17 bytes = 34 hex chars min

    // Convert hex pairs to ASCII characters
    final sb = StringBuffer();
    for (int i = 0; i + 1 < vinHex.length && sb.length < 17; i += 2) {
      final byte = int.tryParse(vinHex.substring(i, i + 2), radix: 16);
      if (byte == null || byte == 0) continue;
      sb.writeCharCode(byte);
    }

    // VIN must be A-H, J-N, P, R-Z, 0-9 only (I, O, Q are excluded by standard)
    final vin = sb.toString().replaceAll(RegExp(r'[^A-HJ-NPR-Z0-9]'), '');
    if (vin.length < 11) return null;
    return vin.length >= 17 ? vin.substring(0, 17) : vin;
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  void startPolling() {
    if (_pollingTimer != null && _pollingTimer!.isActive) {
      return;
    }

    _dataSubscription = _bluetoothService.dataStream.listen(_processResponse);

    _pollingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      _pollSensors();
    });
  }

  Future<void> _pollSensors() async {
    for (final command in _commands) {
      try {
        await _bluetoothService.sendCommand(command.command);
        await Future.delayed(const Duration(milliseconds: 100));
      } catch (e) {
        print('Error polling sensor ${command.sensorType}: $e');
      }
    }
  }

  void _processResponse(String data) {
    try {
      final cleanData = data.replaceAll(RegExp(r'[\r\n\s>]'), '');

      if (cleanData.isEmpty ||
          cleanData.contains('NODATA') ||
          cleanData.contains('ERROR')) {
        return;
      }

      for (final command in _commands) {
        final responsePrefix = command.command.substring(2);

        if (cleanData.contains(responsePrefix)) {
          final parts = cleanData.split(responsePrefix);
          if (parts.length > 1) {
            final hexData = parts[1].substring(
              0,
              parts[1].length >= 4 ? 4 : parts[1].length,
            );
            final bytes = _hexToBytes(hexData);

            if (bytes.isNotEmpty) {
              final value = command.parser(bytes);
              final sensorData = SensorData(
                type: command.sensorType,
                value: value,
                timestamp: DateTime.now(),
              );

              _sensorDataController.add(sensorData);
            }
          }
        }
      }
    } catch (e) {
      print('Error processing response: $e');
    }
  }

  List<int> _hexToBytes(String hex) {
    final bytes = <int>[];
    for (int i = 0; i < hex.length; i += 2) {
      if (i + 1 < hex.length) {
        final hexByte = hex.substring(i, i + 2);
        bytes.add(int.parse(hexByte, radix: 16));
      }
    }
    return bytes;
  }

  // Poll only specific category sensors
  Future<void> pollCategory(String category) async {
    final categorySensors = _commands
        .where((cmd) {
      final data = SensorData(
        type: cmd.sensorType,
        value: 0,
        timestamp: DateTime.now(),
      );
      return data.category == category;
    })
        .toList();

    for (final command in categorySensors) {
      try {
        await _bluetoothService.sendCommand(command.command);
        await Future.delayed(const Duration(milliseconds: 100));
      } catch (e) {
        print('Error polling category sensor ${command.sensorType}: $e');
      }
    }
  }

  void stopPolling() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
    _dataSubscription?.cancel();
    _dataSubscription = null;
  }

  void dispose() {
    stopPolling();
    _sensorDataController.close();
  }
}