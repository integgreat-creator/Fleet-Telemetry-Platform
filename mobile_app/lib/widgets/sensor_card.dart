import 'package:flutter/material.dart';
import 'package:syncfusion_flutter_gauges/gauges.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

class SensorCard extends StatelessWidget {
  final SensorData sensorData;
  final VoidCallback? onTap;

  const SensorCard({
    Key? key,
    required this.sensorData,
    this.onTap,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final isWarning = sensorData.isWarning;

    return Card(
      elevation: 4,
      margin: const EdgeInsets.all(8),
      color: isWarning ? Colors.red.shade50 : Colors.white,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      sensorData.name,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: isWarning ? Colors.red.shade900 : Colors.black87,
                      ),
                    ),
                  ),
                  if (isWarning)
                    Icon(
                      Icons.warning_amber_rounded,
                      color: Colors.red.shade900,
                      size: 24,
                    ),
                ],
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 120,
                child: SfRadialGauge(
                  axes: [
                    RadialAxis(
                      minimum: 0,
                      maximum: _getMaxValue(sensorData.type),
                      ranges: [
                        GaugeRange(
                          startValue: 0,
                          endValue: _getMaxValue(sensorData.type) * 0.7,
                          color: Colors.green,
                        ),
                        GaugeRange(
                          startValue: _getMaxValue(sensorData.type) * 0.7,
                          endValue: _getMaxValue(sensorData.type) * 0.9,
                          color: Colors.orange,
                        ),
                        GaugeRange(
                          startValue: _getMaxValue(sensorData.type) * 0.9,
                          endValue: _getMaxValue(sensorData.type),
                          color: Colors.red,
                        ),
                      ],
                      pointers: [
                        NeedlePointer(
                          value: sensorData.value,
                          enableAnimation: true,
                        ),
                      ],
                      annotations: [
                        GaugeAnnotation(
                          widget: Text(
                            '${sensorData.value.toStringAsFixed(1)}\n${sensorData.unit}',
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.bold,
                              color: isWarning ? Colors.red.shade900 : Colors.black87,
                            ),
                            textAlign: TextAlign.center,
                          ),
                          angle: 90,
                          positionFactor: 0.75,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Normal: ${sensorData.normalRange}',
                style: TextStyle(
                  fontSize: 12,
                  color: Colors.grey.shade600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  double _getMaxValue(SensorType type) {
    switch (type) {
    // Existing
      case SensorType.rpm:                          return 8000;
      case SensorType.speed:                        return 250;
      case SensorType.coolantTemp:                  return 150;
      case SensorType.fuelLevel:                    return 100;
      case SensorType.batteryVoltage:               return 16;
      case SensorType.throttlePosition:             return 100;
      case SensorType.intakeAirTemp:                return 100;
      case SensorType.engineLoad:                   return 100;
      case SensorType.maf:                          return 655;
      case SensorType.timingAdvance:                return 64;
      case SensorType.shortFuelTrim:                return 100;
      case SensorType.longFuelTrim:                 return 100;
      case SensorType.manifoldPressure:             return 255;
      case SensorType.fuelPressure:                 return 765;
      case SensorType.distanceSinceMIL:             return 65535;
      case SensorType.engineRuntime:                return 65535;
      case SensorType.controlModuleVoltage:         return 65.5;
      case SensorType.ambientTemp:                  return 215;

    // Engine & Performance
      case SensorType.commandedEGR:                 return 100;
      case SensorType.egrError:                     return 100;
      case SensorType.commandedEvapPurge:           return 100;
      case SensorType.barometricPressure:           return 255;
      case SensorType.absoluteLoad:                 return 100;
      case SensorType.commandedAirFuelRatio:        return 32;
      case SensorType.relativeThrottlePosition:     return 100;
      case SensorType.absoluteThrottlePositionB:    return 100;
      case SensorType.absoluteThrottlePositionC:    return 100;
      case SensorType.absoluteThrottlePositionD:    return 100;
      case SensorType.absoluteThrottlePositionE:    return 100;
      case SensorType.commandedThrottleActuator:    return 100;
      case SensorType.engineOilTemp:                return 215;
      case SensorType.engineFuelRate:               return 655;
      case SensorType.actualEngineTorque:           return 100;
      case SensorType.engineReferenceTorque:        return 65535;
      case SensorType.enginePercentTorque:          return 100;
      case SensorType.coolantTemp2:                 return 215;
      case SensorType.exhaustGasTempBank1:          return 1000;
      case SensorType.exhaustGasTempBank2:          return 1000;
      case SensorType.exhaustGasTempSensor:         return 1000;
      case SensorType.dieselParticulateFilterTemp:  return 1000;
      case SensorType.cylinderFuelRate:             return 655;
      case SensorType.exhaustPressure:              return 655;

    // Fuel & Emissions
      case SensorType.o2Sensor1Voltage:             return 1.275;
      case SensorType.o2Sensor2Voltage:             return 1.275;
      case SensorType.o2Sensor3Voltage:             return 1.275;
      case SensorType.o2Sensor4Voltage:             return 1.275;
      case SensorType.o2Sensor5Voltage:             return 1.275;
      case SensorType.o2Sensor6Voltage:             return 1.275;
      case SensorType.o2Sensor7Voltage:             return 1.275;
      case SensorType.o2Sensor8Voltage:             return 1.275;
      case SensorType.distanceSinceDTCCleared:      return 65535;
      case SensorType.catalystTempBank1:            return 1000;
      case SensorType.catalystTempBank2:            return 1000;
      case SensorType.ethanolFuelPercent:           return 100;
      case SensorType.fuelRailAbsolutePressure:     return 655350;
      case SensorType.driverDemandTorque:           return 100;
      case SensorType.warmupsSinceDTCCleared:       return 255;
      case SensorType.evapSystemVaporPressure:      return 8192;
      case SensorType.absoluteEvapSystemPressure:   return 327.675;
      case SensorType.evapSystemPressure2:          return 8192;
      case SensorType.shortTermSecondaryO2TrimB1:   return 100;
      case SensorType.longTermSecondaryO2TrimB1:    return 100;
      case SensorType.shortTermSecondaryO2TrimB2:   return 100;
      case SensorType.longTermSecondaryO2TrimB2:    return 100;
      case SensorType.engineFuelRateAlt:            return 655;
      case SensorType.noxSensorConcentration:       return 3212;
      case SensorType.odometerReading:              return 999999;

    // Transmission
      case SensorType.transmissionGear:             return 8;
      case SensorType.relativeAcceleratorPosition:  return 100;
      case SensorType.runTimeWithMIL:               return 65535;
      case SensorType.timeSinceDTCCleared:          return 65535;
      case SensorType.acceleratorPedalPositionD:    return 100;
      case SensorType.transmissionTurbineSpeed:     return 8000;
      case SensorType.transmissionFluidTemp:        return 215;
      case SensorType.transmissionTorque:           return 100;

    // Safety
      case SensorType.relativeAcceleratorPedal:     return 100;
      case SensorType.hybridBatteryLife:            return 100;
      case SensorType.fuelInjectionTiming:          return 301.992;
      case SensorType.exhaustGasRecirculation:      return 100;
      case SensorType.intakeAirTempSensor2:         return 215;
      case SensorType.fuelPressureControlSystem:    return 655350;
      case SensorType.injectionPressureControlSystem: return 655350;
      case SensorType.turbochargerCompressorInlet:  return 255;
      case SensorType.boostPressureControl:         return 255;
      case SensorType.variableGeometryTurboControl: return 100;
      case SensorType.wastegateControl:             return 100;
      case SensorType.exhaustPressureControl:       return 255;

    // Vehicle Info & Diagnostics (non-numeric — return a safe default)
      case SensorType.fuelType:                     return 100;
      case SensorType.emissionRequirementsType:     return 100;
      case SensorType.fuelSystemControl:            return 100;
      case SensorType.monitorStatusSinceDTCCleared: return 100;
      case SensorType.freezeDTC:                    return 100;
      case SensorType.fuelSystemStatus:             return 100;
      case SensorType.o2SensorsPresentBank2:        return 100;
      case SensorType.auxiliaryInputStatus:         return 1;
      case SensorType.monitorStatusDriveCycle:      return 100;
      case SensorType.emissionRequirements:       return 100;
      case SensorType.auxiliaryInputOutput:       return 1;
    }
  }
}
