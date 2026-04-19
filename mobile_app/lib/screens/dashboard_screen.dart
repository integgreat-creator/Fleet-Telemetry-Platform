import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/widgets/sensor_card.dart';
import 'package:vehicle_telemetry/screens/threshold_config_screen.dart';

class DashboardScreen extends StatelessWidget {
  final bool isObdConnected;
  const DashboardScreen({Key? key, this.isObdConnected = false}) : super(key: key);

  // Sensors grouped by category
  static const Map<String, List<SensorType>> _categorySensors = {
    'Engine': [
      SensorType.rpm,
      SensorType.coolantTemp,
      SensorType.engineLoad,
      SensorType.maf,
      SensorType.timingAdvance,
      SensorType.intakeAirTemp,
      SensorType.engineRuntime,
      SensorType.commandedEGR,
      SensorType.egrError,
      SensorType.commandedEvapPurge,
      SensorType.barometricPressure,
      SensorType.controlModuleVoltage,
      SensorType.absoluteLoad,
      SensorType.commandedAirFuelRatio,
      SensorType.relativeThrottlePosition,
      SensorType.absoluteThrottlePositionB,
      SensorType.commandedThrottleActuator,
      SensorType.engineOilTemp,
      SensorType.engineFuelRate,
      SensorType.absoluteThrottlePositionC,
      SensorType.absoluteThrottlePositionD,
      SensorType.absoluteThrottlePositionE,
      SensorType.actualEngineTorque,
      SensorType.engineReferenceTorque,
      SensorType.enginePercentTorque,
      SensorType.coolantTemp2,
      SensorType.exhaustGasTempBank1,
      SensorType.exhaustGasTempBank2,
      SensorType.exhaustGasTempSensor,
      SensorType.dieselParticulateFilterTemp,
      SensorType.cylinderFuelRate,
      SensorType.exhaustPressure,
    ],
    'Fuel': [
      SensorType.fuelLevel,
      SensorType.fuelPressure,
      SensorType.shortFuelTrim,
      SensorType.longFuelTrim,
      SensorType.o2Sensor1Voltage,
      SensorType.o2Sensor2Voltage,
      SensorType.distanceSinceDTCCleared,
      SensorType.catalystTempBank1,
      SensorType.catalystTempBank2,
      SensorType.ethanolFuelPercent,
      SensorType.fuelRailAbsolutePressure,
      SensorType.driverDemandTorque,
      SensorType.warmupsSinceDTCCleared,
      SensorType.evapSystemVaporPressure,
      SensorType.absoluteEvapSystemPressure,
      SensorType.evapSystemPressure2,
      SensorType.shortTermSecondaryO2TrimB1,
      SensorType.longTermSecondaryO2TrimB1,
      SensorType.shortTermSecondaryO2TrimB2,
      SensorType.longTermSecondaryO2TrimB2,
      SensorType.engineFuelRateAlt,
      SensorType.noxSensorConcentration,
      SensorType.odometerReading,
    ],
    'Transmission': [
      SensorType.speed,
      SensorType.transmissionGear,
      SensorType.relativeAcceleratorPosition,
      SensorType.distanceSinceMIL,
      SensorType.runTimeWithMIL,
      SensorType.timeSinceDTCCleared,
      SensorType.acceleratorPedalPositionD,
      SensorType.transmissionTurbineSpeed,
      SensorType.transmissionFluidTemp,
      SensorType.transmissionTorque,
    ],
    'Safety': [
      SensorType.batteryVoltage,
      SensorType.throttlePosition,
      SensorType.manifoldPressure,
      SensorType.ambientTemp,
      SensorType.relativeAcceleratorPedal,
      SensorType.hybridBatteryLife,
      SensorType.fuelInjectionTiming,
      SensorType.exhaustGasRecirculation,
      SensorType.o2Sensor3Voltage,
      SensorType.o2Sensor4Voltage,
      SensorType.o2Sensor5Voltage,
      SensorType.o2Sensor6Voltage,
      SensorType.o2Sensor7Voltage,
      SensorType.o2Sensor8Voltage,
      SensorType.intakeAirTempSensor2,
      SensorType.fuelPressureControlSystem,
      SensorType.injectionPressureControlSystem,
      SensorType.turbochargerCompressorInlet,
      SensorType.boostPressureControl,
      SensorType.variableGeometryTurboControl,
      SensorType.wastegateControl,
      SensorType.exhaustPressureControl,
    ],
    'Vehicle Info': [
      SensorType.fuelType,
      SensorType.emissionRequirementsType,
      SensorType.fuelSystemControl,
    ],
    'Diagnostics': [
      SensorType.monitorStatusSinceDTCCleared,
      SensorType.freezeDTC,
      SensorType.fuelSystemStatus,
      SensorType.o2SensorsPresentBank2,
      SensorType.auxiliaryInputStatus,
      SensorType.monitorStatusDriveCycle,
    ],
  };

  @override
  Widget build(BuildContext context) {
    return Consumer2<SensorProvider, VehicleProvider>(
      builder: (context, sensorProvider, vehicleProvider, _) {
        final sensorData = sensorProvider.latestSensorData;

        if (sensorData.isEmpty) {
          return _buildEmptyState(isObdConnected);
        }

        return DefaultTabController(
          length: _categorySensors.length,
          child: Column(
            children: [
              // Tab bar
              TabBar(
                isScrollable: true,
                labelColor: Theme.of(context).colorScheme.primary,
                unselectedLabelColor: Colors.grey,
                indicatorColor: Theme.of(context).colorScheme.primary,
                tabs: _categorySensors.keys
                    .map((category) => Tab(
                  icon: Icon(_getCategoryIcon(category), size: 18),
                  text: category,
                ))
                    .toList(),
              ),

              // Sensor count summary bar
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 6,
                ),
                color: Theme.of(context).colorScheme.surface,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Total Sensors: ${_categorySensors.values.expand((e) => e).length}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Colors.grey,
                      ),
                    ),
                    Text(
                      'Active: ${sensorData.length}',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.green.shade600,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
              ),

              // Tab content
              Expanded(
                child: TabBarView(
                  children: _categorySensors.entries
                      .map((entry) => _buildCategoryGrid(
                    context,
                    entry.value,
                    sensorData,
                  ))
                      .toList(),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildEmptyState(bool obdConnected) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            obdConnected ? Icons.hourglass_top : Icons.sensors_off,
            size: 64,
            color: Colors.grey,
          ),
          const SizedBox(height: 16),
          Text(
            obdConnected ? 'Waiting for sensor data…' : 'No sensor data available',
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            obdConnected
                ? 'Data will appear once the OBD-II adapter starts reporting'
                : 'Connect to OBD-II to start monitoring',
            style: TextStyle(color: Colors.grey.shade600),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  // Grid of sensor cards per category
  Widget _buildCategoryGrid(
      BuildContext context,
      List<SensorType> sensors,
      Map<SensorType, SensorData> sensorData,
      ) {
    return GridView.builder(
      padding: const EdgeInsets.all(8),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        childAspectRatio: 0.85,
        crossAxisSpacing: 8,
        mainAxisSpacing: 8,
      ),
      itemCount: sensors.length,
      itemBuilder: (context, index) {
        final sensorType = sensors[index];
        final data = sensorData[sensorType];

        // Loading state while waiting for OBD data
        if (data == null) {
          return Card(
            child: Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const CircularProgressIndicator(),
                  const SizedBox(height: 8),
                  Text(
                    _getSensorName(sensorType),
                    style: const TextStyle(fontSize: 12),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          );
        }

        return SensorCard(
          sensorData: data,
          onTap: () {
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) =>
                    ThresholdConfigScreen(sensorType: sensorType),
              ),
            );
          },
        );
      },
    );
  }

  // Category icons for tab bar
  IconData _getCategoryIcon(String category) {
    switch (category) {
      case 'Engine':      return Icons.settings;
      case 'Fuel':        return Icons.local_gas_station;
      case 'Transmission':return Icons.speed;
      case 'Safety':      return Icons.shield;
      case 'Vehicle Info':return Icons.directions_car;  // ← new
      case 'Diagnostics': return Icons.bug_report;      // ← new
      default:            return Icons.sensors;
    }
  }

  // Sensor display names for loading state
  String _getSensorName(SensorType type) {
    switch (type) {
    // Existing
      case SensorType.rpm:                          return 'Engine RPM';
      case SensorType.speed:                        return 'Vehicle Speed';
      case SensorType.coolantTemp:                  return 'Coolant Temp';
      case SensorType.fuelLevel:                    return 'Fuel Level';
      case SensorType.batteryVoltage:               return 'Battery Voltage';
      case SensorType.throttlePosition:             return 'Throttle Position';
      case SensorType.intakeAirTemp:                return 'Intake Air Temp';
      case SensorType.engineLoad:                   return 'Engine Load';
      case SensorType.maf:                          return 'Mass Air Flow';
      case SensorType.timingAdvance:                return 'Timing Advance';
      case SensorType.shortFuelTrim:                return 'Short Fuel Trim';
      case SensorType.longFuelTrim:                 return 'Long Fuel Trim';
      case SensorType.manifoldPressure:             return 'Manifold Pressure';
      case SensorType.fuelPressure:                 return 'Fuel Pressure';
      case SensorType.distanceSinceMIL:             return 'Distance Since MIL';
      case SensorType.engineRuntime:                return 'Engine Runtime';
      case SensorType.controlModuleVoltage:         return 'Control Module Voltage';
      case SensorType.ambientTemp:                  return 'Ambient Temp';

    // Engine & Performance
      case SensorType.commandedEGR:                 return 'Commanded EGR';
      case SensorType.egrError:                     return 'EGR Error';
      case SensorType.commandedEvapPurge:           return 'Evap Purge';
      case SensorType.barometricPressure:           return 'Barometric Pressure';
      case SensorType.absoluteLoad:                 return 'Absolute Load';
      case SensorType.commandedAirFuelRatio:        return 'Air-Fuel Ratio';
      case SensorType.relativeThrottlePosition:     return 'Rel. Throttle Pos';
      case SensorType.absoluteThrottlePositionB:    return 'Throttle Pos B';
      case SensorType.absoluteThrottlePositionC:    return 'Throttle Pos C';  // ✅ ADDED
      case SensorType.absoluteThrottlePositionD:    return 'Throttle Pos D';  // ✅ ADDED
      case SensorType.absoluteThrottlePositionE:    return 'Throttle Pos E';  // ✅ ADDED
      case SensorType.commandedThrottleActuator:    return 'Throttle Actuator';
      case SensorType.engineOilTemp:                return 'Oil Temperature';
      case SensorType.engineFuelRate:               return 'Fuel Rate';
      case SensorType.actualEngineTorque:           return 'Actual Torque';   // ✅ ADDED
      case SensorType.engineReferenceTorque:        return 'Reference Torque';// ✅ ADDED
      case SensorType.enginePercentTorque:          return 'Engine Torque %'; // ✅ ADDED
      case SensorType.coolantTemp2:                 return 'Coolant Temp 2';  // ✅ ADDED
      case SensorType.exhaustGasTempBank1:          return 'EGT Bank 1';      // ✅ ADDED
      case SensorType.exhaustGasTempBank2:          return 'EGT Bank 2';      // ✅ ADDED
      case SensorType.exhaustGasTempSensor:         return 'EGT Sensor';      // ✅ ADDED
      case SensorType.dieselParticulateFilterTemp:  return 'DPF Temp';        // ✅ ADDED
      case SensorType.cylinderFuelRate:             return 'Cylinder Fuel Rate'; // ✅ ADDED
      case SensorType.exhaustPressure:              return 'Exhaust Pressure'; // ✅ ADDED

    // Fuel & Emissions
      case SensorType.o2Sensor1Voltage:             return 'O2 Sensor 1';
      case SensorType.o2Sensor2Voltage:             return 'O2 Sensor 2';
      case SensorType.o2Sensor3Voltage:             return 'O2 Sensor 3';     // ✅ ADDED
      case SensorType.o2Sensor4Voltage:             return 'O2 Sensor 4';     // ✅ ADDED
      case SensorType.o2Sensor5Voltage:             return 'O2 Sensor 5';     // ✅ ADDED
      case SensorType.o2Sensor6Voltage:             return 'O2 Sensor 6';     // ✅ ADDED
      case SensorType.o2Sensor7Voltage:             return 'O2 Sensor 7';     // ✅ ADDED
      case SensorType.o2Sensor8Voltage:             return 'O2 Sensor 8';     // ✅ ADDED
      case SensorType.distanceSinceDTCCleared:      return 'Distance Since DTC';
      case SensorType.catalystTempBank1:            return 'Catalyst Temp B1';
      case SensorType.catalystTempBank2:            return 'Catalyst Temp B2';
      case SensorType.ethanolFuelPercent:           return 'Ethanol %';
      case SensorType.fuelRailAbsolutePressure:     return 'Fuel Rail Pressure';
      case SensorType.driverDemandTorque:           return 'Demand Torque';
      case SensorType.warmupsSinceDTCCleared:       return 'Warmups Since DTC'; // ✅ ADDED
      case SensorType.evapSystemVaporPressure:      return 'Evap Vapor Pressure'; // ✅ ADDED
      case SensorType.absoluteEvapSystemPressure:   return 'Abs. Evap Pressure';  // ✅ ADDED
      case SensorType.evapSystemPressure2:          return 'Evap Pressure 2';  // ✅ ADDED
      case SensorType.shortTermSecondaryO2TrimB1:   return 'ST O2 Trim B1';   // ✅ ADDED
      case SensorType.longTermSecondaryO2TrimB1:    return 'LT O2 Trim B1';   // ✅ ADDED
      case SensorType.shortTermSecondaryO2TrimB2:   return 'ST O2 Trim B2';   // ✅ ADDED
      case SensorType.longTermSecondaryO2TrimB2:    return 'LT O2 Trim B2';   // ✅ ADDED
      case SensorType.engineFuelRateAlt:            return 'Fuel Rate (Alt)'; // ✅ ADDED
      case SensorType.noxSensorConcentration:       return 'NOx Concentration'; // ✅ ADDED
      case SensorType.odometerReading:              return 'Odometer';         // ✅ ADDED

    // Transmission & Drivetrain
      case SensorType.transmissionGear:             return 'Transmission Gear';
      case SensorType.relativeAcceleratorPosition:  return 'Accel. Position';
      case SensorType.runTimeWithMIL:               return 'Runtime With MIL';
      case SensorType.timeSinceDTCCleared:          return 'Time Since DTC';
      case SensorType.acceleratorPedalPositionD:    return 'Accel. Pedal D';  // ✅ ADDED
      case SensorType.transmissionTurbineSpeed:     return 'Turbine Speed';   // ✅ ADDED
      case SensorType.transmissionFluidTemp:        return 'Trans. Fluid Temp'; // ✅ ADDED
      case SensorType.transmissionTorque:           return 'Trans. Torque';   // ✅ ADDED

    // Driver & Safety
      case SensorType.relativeAcceleratorPedal:     return 'Accel. Pedal';
      case SensorType.hybridBatteryLife:            return 'Battery Life';
      case SensorType.fuelInjectionTiming:          return 'Injection Timing';
      case SensorType.exhaustGasRecirculation:      return 'EGR';
      case SensorType.intakeAirTempSensor2:         return 'Intake Air Temp 2'; // ✅ ADDED
      case SensorType.fuelPressureControlSystem:    return 'Fuel Pressure Control'; // ✅ ADDED
      case SensorType.injectionPressureControlSystem: return 'Injection Pressure'; // ✅ ADDED
      case SensorType.turbochargerCompressorInlet:  return 'Turbo Inlet';     // ✅ ADDED
      case SensorType.boostPressureControl:         return 'Boost Pressure';  // ✅ ADDED
      case SensorType.variableGeometryTurboControl: return 'VGT Control';     // ✅ ADDED
      case SensorType.wastegateControl:             return 'Wastegate Control'; // ✅ ADDED
      case SensorType.exhaustPressureControl:       return 'Exhaust Pressure Control'; // ✅ ADDED

    // Vehicle Info
      case SensorType.fuelType:                     return 'Fuel Type';       // ✅ ADDED
      case SensorType.emissionRequirementsType:     return 'Emission Type';   // ✅ ADDED
      case SensorType.fuelSystemControl:            return 'Fuel System';     // ✅ ADDED
      case SensorType.emissionRequirements:       return 'Emission Requirements';

    // Diagnostics
      case SensorType.monitorStatusSinceDTCCleared: return 'Monitor Status';  // ✅ ADDED
      case SensorType.freezeDTC:                    return 'Freeze DTC';      // ✅ ADDED
      case SensorType.fuelSystemStatus:             return 'Fuel System Status'; // ✅ ADDED
      case SensorType.o2SensorsPresentBank2:        return 'O2 Sensors B2';   // ✅ ADDED
      case SensorType.auxiliaryInputStatus:         return 'Aux Input Status'; // ✅ ADDED
      case SensorType.monitorStatusDriveCycle:      return 'Monitor Drive Cycle'; // ✅ ADDED
      case SensorType.auxiliaryInputOutput:       return 'Aux Input/Output';
    }
  }
}