import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:uuid/uuid.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/models/threshold.dart' as model;
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';

class ThresholdConfigScreen extends StatefulWidget {
  final SensorType sensorType;

  const ThresholdConfigScreen({Key? key, required this.sensorType})
      : super(key: key);

  @override
  State<ThresholdConfigScreen> createState() => _ThresholdConfigScreenState();
}

class _ThresholdConfigScreenState extends State<ThresholdConfigScreen> {
  final _formKey = GlobalKey<FormState>();
  final _minController = TextEditingController();
  final _maxController = TextEditingController();
  bool _enabled = true;
  model.Threshold? _existingThreshold;

  @override
  void initState() {
    super.initState();
    _loadExistingThreshold();
  }

  void _loadExistingThreshold() {
    final vehicleProvider = context.read<VehicleProvider>();
    final vehicleId = vehicleProvider.selectedVehicle?.id;

    if (vehicleId != null) {
      _existingThreshold = vehicleProvider.getThresholdForSensor(
        vehicleId,
        widget.sensorType.name,
      );

      if (_existingThreshold != null) {
        _minController.text = _existingThreshold!.minValue?.toString() ?? '';
        _maxController.text = _existingThreshold!.maxValue?.toString() ?? '';
        _enabled = _existingThreshold!.alertEnabled;
      }
    }
  }

  @override
  void dispose() {
    _minController.dispose();
    _maxController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    final vehicleProvider = context.read<VehicleProvider>();
    final vehicleId = vehicleProvider.selectedVehicle?.id;

    if (vehicleId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No vehicle selected'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    final threshold = model.Threshold(
      id: _existingThreshold?.id ?? const Uuid().v4(),
      vehicleId: vehicleId,
      sensorType: widget.sensorType,
      minValue: _minController.text.isEmpty
          ? null
          : double.tryParse(_minController.text),
      maxValue: _maxController.text.isEmpty
          ? null
          : double.tryParse(_maxController.text),
      alertEnabled: _enabled,
      createdAt: _existingThreshold?.createdAt ?? DateTime.now(),
      updatedAt: DateTime.now(),
    );

    final success = _existingThreshold == null
        ? await vehicleProvider.createThreshold(threshold)
        : await vehicleProvider.updateThreshold(threshold);

    if (mounted) {
      if (success) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Threshold saved successfully'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.of(context).pop();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Failed to save threshold'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Thresholds'),
            Text('Configure limits', style: TextStyle(fontSize: 12)),
          ],
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Sensor info card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(
                          _getCategoryIcon(),
                          color: Theme.of(context).colorScheme.primary,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _getSensorName(),
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Category: ${_getCategory()}',
                      style: TextStyle(color: Colors.grey.shade600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Normal Range: ${_getNormalRange()}',
                      style: TextStyle(color: Colors.grey.shade600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Unit: ${_getUnit()}',
                      style: TextStyle(color: Colors.grey.shade600),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            // Enable alerts toggle
            SwitchListTile(
              title: const Text('Enable Alerts'),
              subtitle: const Text(
                'Receive notifications when threshold is exceeded',
              ),
              value: _enabled,
              onChanged: (value) => setState(() => _enabled = value),
            ),
            const SizedBox(height: 16),

            // Min value input
            TextFormField(
              controller: _minController,
              decoration: InputDecoration(
                labelText: 'Minimum Value (${_getUnit()})',
                border: const OutlineInputBorder(),
                prefixIcon: const Icon(Icons.arrow_downward),
                helperText: 'Normal: ${_getNormalRange()}',
              ),
              keyboardType:
              const TextInputType.numberWithOptions(decimal: true),
              validator: (value) {
                if (value != null && value.isNotEmpty) {
                  if (double.tryParse(value) == null) {
                    return 'Please enter a valid number';
                  }
                }
                return null;
              },
            ),
            const SizedBox(height: 16),

            // Max value input
            TextFormField(
              controller: _maxController,
              decoration: InputDecoration(
                labelText: 'Maximum Value (${_getUnit()})',
                border: const OutlineInputBorder(),
                prefixIcon: const Icon(Icons.arrow_upward),
                helperText: 'Normal: ${_getNormalRange()}',
              ),
              keyboardType:
              const TextInputType.numberWithOptions(decimal: true),
              validator: (value) {
                if (value != null && value.isNotEmpty) {
                  if (double.tryParse(value) == null) {
                    return 'Please enter a valid number';
                  }
                  final max = double.tryParse(value);
                  final min = double.tryParse(_minController.text);
                  if (min != null && max != null && max <= min) {
                    return 'Maximum must be greater than minimum';
                  }
                }
                return null;
              },
            ),
            const SizedBox(height: 24),

            // Save button
            ElevatedButton(
              onPressed: _save,
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
              child: const Text('Save Threshold'),
            ),
          ],
        ),
      ),
    );
  }

  // ── Sensor name ───────────────────────────────────────────────────

  String _getSensorName() {
    switch (widget.sensorType) {
    // Existing
      case SensorType.rpm:                              return 'Engine RPM';
      case SensorType.speed:                            return 'Vehicle Speed';
      case SensorType.coolantTemp:                      return 'Coolant Temperature';
      case SensorType.fuelLevel:                        return 'Fuel Level';
      case SensorType.batteryVoltage:                   return 'Battery Voltage';
      case SensorType.throttlePosition:                 return 'Throttle Position';
      case SensorType.intakeAirTemp:                    return 'Intake Air Temperature';
      case SensorType.engineLoad:                       return 'Engine Load';
      case SensorType.maf:                              return 'Mass Air Flow';
      case SensorType.timingAdvance:                    return 'Timing Advance';
      case SensorType.shortFuelTrim:                    return 'Short Fuel Trim';
      case SensorType.longFuelTrim:                     return 'Long Fuel Trim';
      case SensorType.manifoldPressure:                 return 'Manifold Pressure';
      case SensorType.fuelPressure:                     return 'Fuel Pressure';
      case SensorType.distanceSinceMIL:                 return 'Distance Since MIL';
      case SensorType.engineRuntime:                    return 'Engine Runtime';
      case SensorType.controlModuleVoltage:             return 'Control Module Voltage';
      case SensorType.ambientTemp:                      return 'Ambient Temperature';
    // Engine & Performance
      case SensorType.commandedEGR:                     return 'Commanded EGR';
      case SensorType.egrError:                         return 'EGR Error';
      case SensorType.commandedEvapPurge:               return 'Commanded Evap Purge';
      case SensorType.barometricPressure:               return 'Barometric Pressure';
      case SensorType.absoluteLoad:                     return 'Absolute Load';
      case SensorType.commandedAirFuelRatio:            return 'Commanded Air-Fuel Ratio';
      case SensorType.relativeThrottlePosition:         return 'Relative Throttle Position';
      case SensorType.absoluteThrottlePositionB:        return 'Absolute Throttle Position B';
      case SensorType.commandedThrottleActuator:        return 'Commanded Throttle Actuator';
      case SensorType.engineOilTemp:                    return 'Engine Oil Temperature';
      case SensorType.engineFuelRate:                   return 'Engine Fuel Rate';
    // Engine & Performance Extras
      case SensorType.absoluteThrottlePositionC:        return 'Absolute Throttle Position C';
      case SensorType.absoluteThrottlePositionD:        return 'Absolute Throttle Position D';
      case SensorType.absoluteThrottlePositionE:        return 'Absolute Throttle Position E';
      case SensorType.actualEngineTorque:               return 'Actual Engine Torque';
      case SensorType.engineReferenceTorque:            return 'Engine Reference Torque';
      case SensorType.enginePercentTorque:              return 'Engine Percent Torque';
      case SensorType.coolantTemp2:                     return 'Engine Coolant Temperature 2';
      case SensorType.exhaustGasTempBank1:              return 'Exhaust Gas Temp Bank 1';
      case SensorType.exhaustGasTempBank2:              return 'Exhaust Gas Temp Bank 2';
      case SensorType.exhaustGasTempSensor:             return 'Exhaust Gas Temp Sensor';
      case SensorType.dieselParticulateFilterTemp:      return 'Diesel Particulate Filter Temp';
      case SensorType.cylinderFuelRate:                 return 'Cylinder Fuel Rate';
      case SensorType.exhaustPressure:                  return 'Exhaust Pressure';
    // Fuel & Emissions
      case SensorType.o2Sensor1Voltage:                 return 'O2 Sensor 1 Voltage';
      case SensorType.o2Sensor2Voltage:                 return 'O2 Sensor 2 Voltage';
      case SensorType.distanceSinceDTCCleared:          return 'Distance Since DTC Cleared';
      case SensorType.catalystTempBank1:                return 'Catalyst Temp Bank 1';
      case SensorType.catalystTempBank2:                return 'Catalyst Temp Bank 2';
      case SensorType.ethanolFuelPercent:               return 'Ethanol Fuel Percentage';
      case SensorType.fuelRailAbsolutePressure:         return 'Fuel Rail Absolute Pressure';
      case SensorType.driverDemandTorque:               return 'Driver Demand Torque';
    // Fuel & Emissions Extras
      case SensorType.warmupsSinceDTCCleared:           return 'Warm-ups Since DTC Cleared';
      case SensorType.evapSystemVaporPressure:          return 'Evap System Vapor Pressure';
      case SensorType.absoluteEvapSystemPressure:       return 'Absolute Evap System Pressure';
      case SensorType.evapSystemPressure2:              return 'Evap System Pressure 2';
      case SensorType.shortTermSecondaryO2TrimB1:       return 'Short Term Secondary O2 Trim B1';
      case SensorType.longTermSecondaryO2TrimB1:        return 'Long Term Secondary O2 Trim B1';
      case SensorType.shortTermSecondaryO2TrimB2:       return 'Short Term Secondary O2 Trim B2';
      case SensorType.longTermSecondaryO2TrimB2:        return 'Long Term Secondary O2 Trim B2';
      case SensorType.emissionRequirements:             return 'Emission Requirements';
      case SensorType.engineFuelRateAlt:                return 'Engine Fuel Rate (Alt)';
      case SensorType.noxSensorConcentration:           return 'NOx Sensor Concentration';
      case SensorType.odometerReading:                  return 'Odometer Reading';
    // Transmission & Drivetrain
      case SensorType.transmissionGear:                 return 'Transmission Gear';
      case SensorType.relativeAcceleratorPosition:      return 'Relative Accelerator Position';
      case SensorType.runTimeWithMIL:                   return 'Run Time With MIL On';
      case SensorType.timeSinceDTCCleared:              return 'Time Since DTC Cleared';
    // Transmission Extras
      case SensorType.acceleratorPedalPositionD:        return 'Accelerator Pedal Position D';
      case SensorType.auxiliaryInputOutput:             return 'Auxiliary Input/Output';
      case SensorType.transmissionTurbineSpeed:         return 'Transmission Turbine Speed';
      case SensorType.transmissionFluidTemp:            return 'Transmission Fluid Temperature';
      case SensorType.transmissionTorque:               return 'Transmission Torque';
    // Driver & Safety
      case SensorType.relativeAcceleratorPedal:         return 'Relative Accelerator Pedal';
      case SensorType.hybridBatteryLife:                return 'Hybrid Battery Pack Life';
      case SensorType.fuelInjectionTiming:              return 'Fuel Injection Timing';
      case SensorType.exhaustGasRecirculation:          return 'Exhaust Gas Recirculation';
    // Driver & Safety Extras
      case SensorType.o2Sensor3Voltage:                 return 'O2 Sensor 3 Voltage';
      case SensorType.o2Sensor4Voltage:                 return 'O2 Sensor 4 Voltage';
      case SensorType.o2Sensor5Voltage:                 return 'O2 Sensor 5 Voltage';
      case SensorType.o2Sensor6Voltage:                 return 'O2 Sensor 6 Voltage';
      case SensorType.o2Sensor7Voltage:                 return 'O2 Sensor 7 Voltage';
      case SensorType.o2Sensor8Voltage:                 return 'O2 Sensor 8 Voltage';
      case SensorType.intakeAirTempSensor2:             return 'Intake Air Temp Sensor 2';
      case SensorType.fuelPressureControlSystem:        return 'Fuel Pressure Control System';
      case SensorType.injectionPressureControlSystem:   return 'Injection Pressure Control';
      case SensorType.turbochargerCompressorInlet:      return 'Turbocharger Compressor Inlet';
      case SensorType.boostPressureControl:             return 'Boost Pressure Control';
      case SensorType.variableGeometryTurboControl:     return 'Variable Geometry Turbo';
      case SensorType.wastegateControl:                 return 'Wastegate Control';
      case SensorType.exhaustPressureControl:           return 'Exhaust Pressure Control';
    // Vehicle Information
      case SensorType.fuelType:                         return 'Fuel Type';
      case SensorType.emissionRequirementsType:         return 'Emission Requirements Type';
      case SensorType.fuelSystemControl:                return 'Fuel System Control';
    // Diagnostics & DTC
      case SensorType.monitorStatusSinceDTCCleared:     return 'Monitor Status Since DTC Cleared';
      case SensorType.freezeDTC:                        return 'Freeze DTC';
      case SensorType.fuelSystemStatus:                 return 'Fuel System Status';
      case SensorType.o2SensorsPresentBank2:            return 'O2 Sensors Present Bank 2';
      case SensorType.auxiliaryInputStatus:             return 'Auxiliary Input Status';
      case SensorType.monitorStatusDriveCycle:          return 'Monitor Status Drive Cycle';
    }
  }

  // ── Sensor unit ───────────────────────────────────────────────────

  String _getUnit() {
    switch (widget.sensorType) {
    // Existing
      case SensorType.rpm:                              return 'RPM';
      case SensorType.speed:                            return 'km/h';
      case SensorType.coolantTemp:                      return '°C';
      case SensorType.fuelLevel:                        return '%';
      case SensorType.batteryVoltage:                   return 'V';
      case SensorType.throttlePosition:                 return '%';
      case SensorType.intakeAirTemp:                    return '°C';
      case SensorType.engineLoad:                       return '%';
      case SensorType.maf:                              return 'g/s';
      case SensorType.timingAdvance:                    return '° BTDC';
      case SensorType.shortFuelTrim:                    return '%';
      case SensorType.longFuelTrim:                     return '%';
      case SensorType.manifoldPressure:                 return 'kPa';
      case SensorType.fuelPressure:                     return 'kPa';
      case SensorType.distanceSinceMIL:                 return 'km';
      case SensorType.engineRuntime:                    return 's';
      case SensorType.controlModuleVoltage:             return 'V';
      case SensorType.ambientTemp:                      return '°C';
    // Engine & Performance
      case SensorType.commandedEGR:                     return '%';
      case SensorType.egrError:                         return '%';
      case SensorType.commandedEvapPurge:               return '%';
      case SensorType.barometricPressure:               return 'kPa';
      case SensorType.absoluteLoad:                     return '%';
      case SensorType.commandedAirFuelRatio:            return 'ratio';
      case SensorType.relativeThrottlePosition:         return '%';
      case SensorType.absoluteThrottlePositionB:        return '%';
      case SensorType.commandedThrottleActuator:        return '%';
      case SensorType.engineOilTemp:                    return '°C';
      case SensorType.engineFuelRate:                   return 'L/h';
    // Engine & Performance Extras
      case SensorType.absoluteThrottlePositionC:        return '%';
      case SensorType.absoluteThrottlePositionD:        return '%';
      case SensorType.absoluteThrottlePositionE:        return '%';
      case SensorType.actualEngineTorque:               return '%';
      case SensorType.engineReferenceTorque:            return 'Nm';
      case SensorType.enginePercentTorque:              return '%';
      case SensorType.coolantTemp2:                     return '°C';
      case SensorType.exhaustGasTempBank1:              return '°C';
      case SensorType.exhaustGasTempBank2:              return '°C';
      case SensorType.exhaustGasTempSensor:             return '°C';
      case SensorType.dieselParticulateFilterTemp:      return '°C';
      case SensorType.cylinderFuelRate:                 return 'mg/str';
      case SensorType.exhaustPressure:                  return 'kPa';
    // Fuel & Emissions
      case SensorType.o2Sensor1Voltage:                 return 'V';
      case SensorType.o2Sensor2Voltage:                 return 'V';
      case SensorType.distanceSinceDTCCleared:          return 'km';
      case SensorType.catalystTempBank1:                return '°C';
      case SensorType.catalystTempBank2:                return '°C';
      case SensorType.ethanolFuelPercent:               return '%';
      case SensorType.fuelRailAbsolutePressure:         return 'kPa';
      case SensorType.driverDemandTorque:               return '%';
    // Fuel & Emissions Extras
      case SensorType.warmupsSinceDTCCleared:           return 'count';
      case SensorType.evapSystemVaporPressure:          return 'Pa';
      case SensorType.absoluteEvapSystemPressure:       return 'kPa';
      case SensorType.evapSystemPressure2:              return 'Pa';
      case SensorType.shortTermSecondaryO2TrimB1:       return '%';
      case SensorType.longTermSecondaryO2TrimB1:        return '%';
      case SensorType.shortTermSecondaryO2TrimB2:       return '%';
      case SensorType.longTermSecondaryO2TrimB2:        return '%';
      case SensorType.emissionRequirements:             return '';
      case SensorType.engineFuelRateAlt:                return 'L/h';
      case SensorType.noxSensorConcentration:           return 'ppm';
      case SensorType.odometerReading:                  return 'km';
    // Transmission & Drivetrain
      case SensorType.transmissionGear:                 return 'gear';
      case SensorType.relativeAcceleratorPosition:      return '%';
      case SensorType.runTimeWithMIL:                   return 's';
      case SensorType.timeSinceDTCCleared:              return 's';
    // Transmission Extras
      case SensorType.acceleratorPedalPositionD:        return '%';
      case SensorType.auxiliaryInputOutput:             return '';
      case SensorType.transmissionTurbineSpeed:         return 'RPM';
      case SensorType.transmissionFluidTemp:            return '°C';
      case SensorType.transmissionTorque:               return 'Nm';
    // Driver & Safety
      case SensorType.relativeAcceleratorPedal:         return '%';
      case SensorType.hybridBatteryLife:                return '%';
      case SensorType.fuelInjectionTiming:              return '°';
      case SensorType.exhaustGasRecirculation:          return '%';
    // Driver & Safety Extras
      case SensorType.o2Sensor3Voltage:                 return 'V';
      case SensorType.o2Sensor4Voltage:                 return 'V';
      case SensorType.o2Sensor5Voltage:                 return 'V';
      case SensorType.o2Sensor6Voltage:                 return 'V';
      case SensorType.o2Sensor7Voltage:                 return 'V';
      case SensorType.o2Sensor8Voltage:                 return 'V';
      case SensorType.intakeAirTempSensor2:             return '°C';
      case SensorType.fuelPressureControlSystem:        return 'kPa';
      case SensorType.injectionPressureControlSystem:   return 'kPa';
      case SensorType.turbochargerCompressorInlet:      return 'kPa';
      case SensorType.boostPressureControl:             return 'kPa';
      case SensorType.variableGeometryTurboControl:     return '%';
      case SensorType.wastegateControl:                 return '%';
      case SensorType.exhaustPressureControl:           return 'kPa';
    // Vehicle Information
      case SensorType.fuelType:                         return '';
      case SensorType.emissionRequirementsType:         return '';
      case SensorType.fuelSystemControl:                return '';
    // Diagnostics & DTC
      case SensorType.monitorStatusSinceDTCCleared:     return '';
      case SensorType.freezeDTC:                        return '';
      case SensorType.fuelSystemStatus:                 return '';
      case SensorType.o2SensorsPresentBank2:            return '';
      case SensorType.auxiliaryInputStatus:             return '';
      case SensorType.monitorStatusDriveCycle:          return '';
    }
  }

  // ── Normal range ──────────────────────────────────────────────────

  String _getNormalRange() {
    switch (widget.sensorType) {
    // Existing
      case SensorType.rpm:                              return '600-6000 RPM';
      case SensorType.speed:                            return '0-200 km/h';
      case SensorType.coolantTemp:                      return '80-100°C';
      case SensorType.fuelLevel:                        return '10-100%';
      case SensorType.batteryVoltage:                   return '12-14.5V';
      case SensorType.throttlePosition:                 return '0-100%';
      case SensorType.intakeAirTemp:                    return '20-50°C';
      case SensorType.engineLoad:                       return '0-100%';
      case SensorType.maf:                              return '0-655 g/s';
      case SensorType.timingAdvance:                    return '-64-63.5°';
      case SensorType.shortFuelTrim:                    return '-100-99.2%';
      case SensorType.longFuelTrim:                     return '-100-99.2%';
      case SensorType.manifoldPressure:                 return '0-255 kPa';
      case SensorType.fuelPressure:                     return '0-765 kPa';
      case SensorType.distanceSinceMIL:                 return '0-65535 km';
      case SensorType.engineRuntime:                    return '0-65535 s';
      case SensorType.controlModuleVoltage:             return '0-65.5 V';
      case SensorType.ambientTemp:                      return '-40-215°C';
    // Engine & Performance
      case SensorType.commandedEGR:                     return '0-100%';
      case SensorType.egrError:                         return '-100-100%';
      case SensorType.commandedEvapPurge:               return '0-100%';
      case SensorType.barometricPressure:               return '60-110 kPa';
      case SensorType.absoluteLoad:                     return '0-100%';
      case SensorType.commandedAirFuelRatio:            return '10-20 ratio';
      case SensorType.relativeThrottlePosition:         return '0-100%';
      case SensorType.absoluteThrottlePositionB:        return '0-100%';
      case SensorType.commandedThrottleActuator:        return '0-100%';
      case SensorType.engineOilTemp:                    return '60-135°C';
      case SensorType.engineFuelRate:                   return '0-50 L/h';
    // Engine & Performance Extras
      case SensorType.absoluteThrottlePositionC:        return '0-100%';
      case SensorType.absoluteThrottlePositionD:        return '0-100%';
      case SensorType.absoluteThrottlePositionE:        return '0-100%';
      case SensorType.actualEngineTorque:               return '-125-125%';
      case SensorType.engineReferenceTorque:            return '0-65535 Nm';
      case SensorType.enginePercentTorque:              return '0-100%';
      case SensorType.coolantTemp2:                     return '80-100°C';
      case SensorType.exhaustGasTempBank1:              return '200-900°C';
      case SensorType.exhaustGasTempBank2:              return '200-900°C';
      case SensorType.exhaustGasTempSensor:             return '200-900°C';
      case SensorType.dieselParticulateFilterTemp:      return '200-600°C';
      case SensorType.cylinderFuelRate:                 return '0-2047 mg/str';
      case SensorType.exhaustPressure:                  return '0-655 kPa';
    // Fuel & Emissions
      case SensorType.o2Sensor1Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor2Voltage:                 return '0-1.275 V';
      case SensorType.distanceSinceDTCCleared:          return '0-65535 km';
      case SensorType.catalystTempBank1:                return '200-900°C';
      case SensorType.catalystTempBank2:                return '200-900°C';
      case SensorType.ethanolFuelPercent:               return '0-100%';
      case SensorType.fuelRailAbsolutePressure:         return '0-655350 kPa';
      case SensorType.driverDemandTorque:               return '-125-125%';
    // Fuel & Emissions Extras
      case SensorType.warmupsSinceDTCCleared:           return '0-255 count';
      case SensorType.evapSystemVaporPressure:          return '-8192-8192 Pa';
      case SensorType.absoluteEvapSystemPressure:       return '0-327.675 kPa';
      case SensorType.evapSystemPressure2:              return '-8192-8192 Pa';
      case SensorType.shortTermSecondaryO2TrimB1:       return '-100-99.2%';
      case SensorType.longTermSecondaryO2TrimB1:        return '-100-99.2%';
      case SensorType.shortTermSecondaryO2TrimB2:       return '-100-99.2%';
      case SensorType.longTermSecondaryO2TrimB2:        return '-100-99.2%';
      case SensorType.emissionRequirements:             return 'N/A';
      case SensorType.engineFuelRateAlt:                return '0-3212.75 L/h';
      case SensorType.noxSensorConcentration:           return '0-3212 ppm';
      case SensorType.odometerReading:                  return '0-429496729 km';
    // Transmission & Drivetrain
      case SensorType.transmissionGear:                 return '1-8';
      case SensorType.relativeAcceleratorPosition:      return '0-100%';
      case SensorType.runTimeWithMIL:                   return '0-65535 s';
      case SensorType.timeSinceDTCCleared:              return '0-65535 s';
    // Transmission Extras
      case SensorType.acceleratorPedalPositionD:        return '0-100%';
      case SensorType.auxiliaryInputOutput:             return 'N/A';
      case SensorType.transmissionTurbineSpeed:         return '0-16383 RPM';
      case SensorType.transmissionFluidTemp:            return '50-120°C';
      case SensorType.transmissionTorque:               return '0-65535 Nm';
    // Driver & Safety
      case SensorType.relativeAcceleratorPedal:         return '0-100%';
      case SensorType.hybridBatteryLife:                return '0-100%';
      case SensorType.fuelInjectionTiming:              return '-210-302°';
      case SensorType.exhaustGasRecirculation:          return '0-100%';
    // Driver & Safety Extras
      case SensorType.o2Sensor3Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor4Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor5Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor6Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor7Voltage:                 return '0-1.275 V';
      case SensorType.o2Sensor8Voltage:                 return '0-1.275 V';
      case SensorType.intakeAirTempSensor2:             return '20-50°C';
      case SensorType.fuelPressureControlSystem:        return '0-765 kPa';
      case SensorType.injectionPressureControlSystem:   return '0-765 kPa';
      case SensorType.turbochargerCompressorInlet:      return '0-655 kPa';
      case SensorType.boostPressureControl:             return '0-655 kPa';
      case SensorType.variableGeometryTurboControl:     return '0-100%';
      case SensorType.wastegateControl:                 return '0-100%';
      case SensorType.exhaustPressureControl:           return '0-655 kPa';
    // Vehicle Information
      case SensorType.fuelType:                         return 'N/A';
      case SensorType.emissionRequirementsType:         return 'N/A';
      case SensorType.fuelSystemControl:                return 'N/A';
    // Diagnostics & DTC
      case SensorType.monitorStatusSinceDTCCleared:     return 'N/A';
      case SensorType.freezeDTC:                        return 'N/A';
      case SensorType.fuelSystemStatus:                 return 'N/A';
      case SensorType.o2SensorsPresentBank2:            return 'N/A';
      case SensorType.auxiliaryInputStatus:             return 'N/A';
      case SensorType.monitorStatusDriveCycle:          return 'N/A';
    }
  }

  // ── Category name ─────────────────────────────────────────────────

  String _getCategory() {
    switch (widget.sensorType) {
      case SensorType.rpm:
      case SensorType.coolantTemp:
      case SensorType.engineLoad:
      case SensorType.maf:
      case SensorType.timingAdvance:
      case SensorType.intakeAirTemp:
      case SensorType.engineRuntime:
      case SensorType.commandedEGR:
      case SensorType.egrError:
      case SensorType.commandedEvapPurge:
      case SensorType.barometricPressure:
      case SensorType.controlModuleVoltage:
      case SensorType.absoluteLoad:
      case SensorType.commandedAirFuelRatio:
      case SensorType.relativeThrottlePosition:
      case SensorType.absoluteThrottlePositionB:
      case SensorType.commandedThrottleActuator:
      case SensorType.engineOilTemp:
      case SensorType.engineFuelRate:
      case SensorType.absoluteThrottlePositionC:
      case SensorType.absoluteThrottlePositionD:
      case SensorType.absoluteThrottlePositionE:
      case SensorType.actualEngineTorque:
      case SensorType.engineReferenceTorque:
      case SensorType.enginePercentTorque:
      case SensorType.coolantTemp2:
      case SensorType.exhaustGasTempBank1:
      case SensorType.exhaustGasTempBank2:
      case SensorType.exhaustGasTempSensor:
      case SensorType.dieselParticulateFilterTemp:
      case SensorType.cylinderFuelRate:
      case SensorType.exhaustPressure:
        return 'Engine & Performance';

      case SensorType.fuelLevel:
      case SensorType.fuelPressure:
      case SensorType.shortFuelTrim:
      case SensorType.longFuelTrim:
      case SensorType.o2Sensor1Voltage:
      case SensorType.o2Sensor2Voltage:
      case SensorType.distanceSinceDTCCleared:
      case SensorType.catalystTempBank1:
      case SensorType.catalystTempBank2:
      case SensorType.ethanolFuelPercent:
      case SensorType.fuelRailAbsolutePressure:
      case SensorType.driverDemandTorque:
      case SensorType.warmupsSinceDTCCleared:
      case SensorType.evapSystemVaporPressure:
      case SensorType.absoluteEvapSystemPressure:
      case SensorType.evapSystemPressure2:
      case SensorType.shortTermSecondaryO2TrimB1:
      case SensorType.longTermSecondaryO2TrimB1:
      case SensorType.shortTermSecondaryO2TrimB2:
      case SensorType.longTermSecondaryO2TrimB2:
      case SensorType.emissionRequirements:
      case SensorType.engineFuelRateAlt:
      case SensorType.noxSensorConcentration:
      case SensorType.odometerReading:
        return 'Fuel & Emissions';

      case SensorType.speed:
      case SensorType.transmissionGear:
      case SensorType.relativeAcceleratorPosition:
      case SensorType.distanceSinceMIL:
      case SensorType.runTimeWithMIL:
      case SensorType.timeSinceDTCCleared:
      case SensorType.acceleratorPedalPositionD:
      case SensorType.auxiliaryInputOutput:
      case SensorType.transmissionTurbineSpeed:
      case SensorType.transmissionFluidTemp:
      case SensorType.transmissionTorque:
        return 'Transmission & Drivetrain';

      case SensorType.batteryVoltage:
      case SensorType.throttlePosition:
      case SensorType.manifoldPressure:
      case SensorType.ambientTemp:
      case SensorType.relativeAcceleratorPedal:
      case SensorType.hybridBatteryLife:
      case SensorType.fuelInjectionTiming:
      case SensorType.exhaustGasRecirculation:
      case SensorType.o2Sensor3Voltage:
      case SensorType.o2Sensor4Voltage:
      case SensorType.o2Sensor5Voltage:
      case SensorType.o2Sensor6Voltage:
      case SensorType.o2Sensor7Voltage:
      case SensorType.o2Sensor8Voltage:
      case SensorType.intakeAirTempSensor2:
      case SensorType.fuelPressureControlSystem:
      case SensorType.injectionPressureControlSystem:
      case SensorType.turbochargerCompressorInlet:
      case SensorType.boostPressureControl:
      case SensorType.variableGeometryTurboControl:
      case SensorType.wastegateControl:
      case SensorType.exhaustPressureControl:
        return 'Driver & Safety';

      case SensorType.fuelType:
      case SensorType.emissionRequirementsType:
      case SensorType.fuelSystemControl:
        return 'Vehicle Information';

      case SensorType.monitorStatusSinceDTCCleared:
      case SensorType.freezeDTC:
      case SensorType.fuelSystemStatus:
      case SensorType.o2SensorsPresentBank2:
      case SensorType.auxiliaryInputStatus:
      case SensorType.monitorStatusDriveCycle:
        return 'Diagnostics & DTC';
    }
  }

  // ── Category icon ─────────────────────────────────────────────────

  IconData _getCategoryIcon() {
    switch (_getCategory()) {
      case 'Engine & Performance':      return Icons.settings;
      case 'Fuel & Emissions':          return Icons.local_gas_station;
      case 'Transmission & Drivetrain': return Icons.speed;
      case 'Driver & Safety':           return Icons.shield;
      case 'Vehicle Information':       return Icons.directions_car;
      case 'Diagnostics & DTC':         return Icons.bug_report;
      default:                          return Icons.sensors;
    }
  }
}