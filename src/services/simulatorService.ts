export interface SensorReading {
  sensor_type: string;
  value: number;
  unit: string;
  min_range: number;
  max_range: number;
  normal_min: number;
  normal_max: number;
}

export const SENSOR_TYPES = {
  // ── Existing & Core ──────────────────────────────────────────
  RPM: 'rpm',
  SPEED: 'speed',
  COOLANT_TEMP: 'coolantTemp',
  FUEL_LEVEL: 'fuelLevel',
  BATTERY_VOLTAGE: 'batteryVoltage',
  THROTTLE_POSITION: 'throttlePosition',
  INTAKE_AIR_TEMP: 'intakeAirTemp',
  ENGINE_LOAD: 'engineLoad',
  MAF: 'maf',
  TIMING_ADVANCE: 'timingAdvance',
  SHORT_FUEL_TRIM: 'shortFuelTrim',
  LONG_FUEL_TRIM: 'longFuelTrim',
  MANIFOLD_PRESSURE: 'manifoldPressure',
  FUEL_PRESSURE: 'fuelPressure',
  DISTANCE_SINCE_MIL: 'distanceSinceMIL',
  ENGINE_RUNTIME: 'engineRuntime',
  CONTROL_MODULE_VOLTAGE: 'controlModuleVoltage',
  AMBIENT_TEMP: 'ambientTemp',

  // ── Engine & Performance ──────────────────────────────────────────
  COMMANDED_EGR: 'commandedEGR',
  EGR_ERROR: 'egrError',
  COMMANDED_EVAP_PURGE: 'commandedEvapPurge',
  BAROMETRIC_PRESSURE: 'barometricPressure',
  ABSOLUTE_LOAD: 'absoluteLoad',
  COMMANDED_AIR_FUEL_RATIO: 'commandedAirFuelRatio',
  RELATIVE_THROTTLE_POSITION: 'relativeThrottlePosition',
  ABSOLUTE_THROTTLE_POSITION_B: 'absoluteThrottlePositionB',
  COMMANDED_THROTTLE_ACTUATOR: 'commandedThrottleActuator',
  ENGINE_OIL_TEMP: 'engineOilTemp',
  ENGINE_FUEL_RATE: 'engineFuelRate',
  ACTUAL_ENGINE_TORQUE: 'actualEngineTorque',
  ENGINE_REFERENCE_TORQUE: 'engineReferenceTorque',
  ENGINE_PERCENT_TORQUE: 'enginePercentTorque',
  COOLANT_TEMP_2: 'coolantTemp2',
  EXHAUST_GAS_TEMP_BANK1: 'exhaustGasTempBank1',
  CYLINDER_FUEL_RATE: 'cylinderFuelRate',
  EXHAUST_PRESSURE: 'exhaustPressure',

  // ── Fuel & Emissions ──────────────────────────────────────────────
  O2_SENSOR_1_VOLTAGE: 'o2Sensor1Voltage',
  O2_SENSOR_2_VOLTAGE: 'o2Sensor2Voltage',
  DISTANCE_SINCE_DTC_CLEARED: 'distanceSinceDTCCleared',
  CATALYST_TEMP_BANK1: 'catalystTempBank1',
  ETHANOL_FUEL_PERCENT: 'ethanolFuelPercent',
  FUEL_RAIL_ABSOLUTE_PRESSURE: 'fuelRailAbsolutePressure',
  ODOMETER_READING: 'odometerReading',

  // ── Transmission & Drivetrain ─────────────────────────────────────
  TRANSMISSION_GEAR: 'transmissionGear',
  RELATIVE_ACCELERATOR_POSITION: 'relativeAcceleratorPosition',
  TRANSMISSION_TURBINE_SPEED: 'transmissionTurbineSpeed',
  TRANSMISSION_FLUID_TEMP: 'transmissionFluidTemp',
  TRANSMISSION_TORQUE: 'transmissionTorque',

  // ── CNG & EV Specific ─────────────────────────────────────────────
  CNG_CYLINDER_PRESSURE: 'cngCylinderPressure',
  CNG_FUEL_LEVEL: 'cngFuelLevel',
  CNG_TEMPERATURE: 'cngTemperature',
  EV_BATTERY_LEVEL: 'evBatteryLevel',
  EV_BATTERY_TEMP: 'evBatteryTemp',
  EV_BATTERY_VOLTAGE: 'evBatteryVoltage',
  EV_BATTERY_CURRENT: 'evBatteryCurrent',
  EV_RANGE_ESTIMATE: 'evRangeEstimate',
  EV_MOTOR_TEMP: 'evMotorTemp',
  EV_MOTOR_RPM: 'evMotorRpm',
} as const;

class VehicleSimulator {
  private baseValues: Map<string, number> = new Map();
  private trends: Map<string, number> = new Map();

  constructor() {
    this.initializeBaseValues();
  }

  private initializeBaseValues() {
    this.baseValues.set(SENSOR_TYPES.RPM, 800);
    this.baseValues.set(SENSOR_TYPES.SPEED, 0);
    this.baseValues.set(SENSOR_TYPES.COOLANT_TEMP, 90);
    this.baseValues.set(SENSOR_TYPES.FUEL_LEVEL, 75);
    this.baseValues.set(SENSOR_TYPES.BATTERY_VOLTAGE, 12.6);
    this.baseValues.set(SENSOR_TYPES.THROTTLE_POSITION, 0);
    this.baseValues.set(SENSOR_TYPES.INTAKE_TEMP, 25);
    this.baseValues.set(SENSOR_TYPES.ENGINE_LOAD, 20);
    this.baseValues.set(SENSOR_TYPES.MAF, 5.0);
    this.baseValues.set(SENSOR_TYPES.TIMING_ADVANCE, 15);
    this.baseValues.set(SENSOR_TYPES.SHORT_FUEL_TRIM, 0);
    this.baseValues.set(SENSOR_TYPES.LONG_FUEL_TRIM, 0);
    this.baseValues.set(SENSOR_TYPES.MANIFOLD_PRESSURE, 30);
    this.baseValues.set(SENSOR_TYPES.FUEL_PRESSURE, 300);
    this.baseValues.set(SENSOR_TYPES.DISTANCE_SINCE_MIL, 0);
    this.baseValues.set(SENSOR_TYPES.ENGINE_RUNTIME, 0);
    this.baseValues.set(SENSOR_TYPES.CONTROL_MODULE_VOLTAGE, 12.5);
    this.baseValues.set(SENSOR_TYPES.AMBIENT_TEMP, 22);
    this.baseValues.set(SENSOR_TYPES.ENGINE_OIL_TEMP, 85);
    this.baseValues.set(SENSOR_TYPES.ENGINE_FUEL_RATE, 2.5);
    this.baseValues.set(SENSOR_TYPES.ODOMETER_READING, 15240);
    this.baseValues.set(SENSOR_TYPES.TRANSMISSION_FLUID_TEMP, 75);
    this.baseValues.set(SENSOR_TYPES.CNG_CYLINDER_PRESSURE, 200);
    this.baseValues.set(SENSOR_TYPES.CNG_FUEL_LEVEL, 80);
    this.baseValues.set(SENSOR_TYPES.EV_BATTERY_LEVEL, 95);
    this.baseValues.set(SENSOR_TYPES.EV_RANGE_ESTIMATE, 350);

    this.trends.set(SENSOR_TYPES.FUEL_LEVEL, -0.01);
    this.trends.set(SENSOR_TYPES.CNG_FUEL_LEVEL, -0.01);
    this.trends.set(SENSOR_TYPES.EV_BATTERY_LEVEL, -0.02);
    this.trends.set(SENSOR_TYPES.ENGINE_RUNTIME, 1);
    this.trends.set(SENSOR_TYPES.ODOMETER_READING, 0.01);
  }

  getSensorConfig(sensorType: string): { min_range: number; max_range: number; normal_min: number; normal_max: number; unit: string } {
    const configs: Record<string, any> = {
      [SENSOR_TYPES.RPM]: { min_range: 0, max_range: 8000, normal_min: 600, normal_max: 3000, unit: 'RPM' },
      [SENSOR_TYPES.SPEED]: { min_range: 0, max_range: 200, normal_min: 0, normal_max: 120, unit: 'km/h' },
      [SENSOR_TYPES.COOLANT_TEMP]: { min_range: 0, max_range: 150, normal_min: 80, normal_max: 100, unit: '°C' },
      [SENSOR_TYPES.FUEL_LEVEL]: { min_range: 0, max_range: 100, normal_min: 10, normal_max: 100, unit: '%' },
      [SENSOR_TYPES.BATTERY_VOLTAGE]: { min_range: 0, max_range: 16, normal_min: 12, normal_max: 14.5, unit: 'V' },
      [SENSOR_TYPES.THROTTLE_POSITION]: { min_range: 0, max_range: 100, normal_min: 0, normal_max: 100, unit: '%' },
      [SENSOR_TYPES.INTAKE_TEMP]: { min_range: -20, max_range: 100, normal_min: 20, normal_max: 50, unit: '°C' },
      [SENSOR_TYPES.ENGINE_LOAD]: { min_range: 0, max_range: 100, normal_min: 0, normal_max: 100, unit: '%' },
      [SENSOR_TYPES.MAF]: { min_range: 0, max_range: 655, normal_min: 2, normal_max: 500, unit: 'g/s' },
      [SENSOR_TYPES.TIMING_ADVANCE]: { min_range: -64, max_range: 63.5, normal_min: -20, normal_max: 45, unit: '° BTDC' },
      [SENSOR_TYPES.SHORT_FUEL_TRIM]: { min_range: -100, max_range: 99.2, normal_min: -15, normal_max: 15, unit: '%' },
      [SENSOR_TYPES.LONG_FUEL_TRIM]: { min_range: -100, max_range: 99.2, normal_min: -10, normal_max: 10, unit: '%' },
      [SENSOR_TYPES.MANIFOLD_PRESSURE]: { min_range: 0, max_range: 255, normal_min: 20, normal_max: 105, unit: 'kPa' },
      [SENSOR_TYPES.FUEL_PRESSURE]: { min_range: 0, max_range: 765, normal_min: 200, normal_max: 600, unit: 'kPa' },
      [SENSOR_TYPES.DISTANCE_SINCE_MIL]: { min_range: 0, max_range: 65535, normal_min: 0, normal_max: 1, unit: 'km' },
      [SENSOR_TYPES.ENGINE_RUNTIME]: { min_range: 0, max_range: 65535, normal_min: 0, normal_max: 65535, unit: 's' },
      [SENSOR_TYPES.CONTROL_MODULE_VOLTAGE]: { min_range: 0, max_range: 65.5, normal_min: 11, normal_max: 15, unit: 'V' },
      [SENSOR_TYPES.AMBIENT_TEMP]: { min_range: -40, max_range: 215, normal_min: -10, normal_max: 45, unit: '°C' },
      [SENSOR_TYPES.ENGINE_OIL_TEMP]: { min_range: 60, max_range: 150, normal_min: 80, normal_max: 110, unit: '°C' },
      [SENSOR_TYPES.ENGINE_FUEL_RATE]: { min_range: 0, max_range: 50, normal_min: 0, normal_max: 30, unit: 'L/h' },
      [SENSOR_TYPES.CNG_CYLINDER_PRESSURE]: { min_range: 0, max_range: 300, normal_min: 20, normal_max: 250, unit: 'bar' },
      [SENSOR_TYPES.EV_BATTERY_LEVEL]: { min_range: 0, max_range: 100, normal_min: 20, normal_max: 100, unit: '%' },
      [SENSOR_TYPES.EV_RANGE_ESTIMATE]: { min_range: 0, max_range: 1000, normal_min: 50, normal_max: 800, unit: 'km' },
    };
    return configs[sensorType] || { min_range: 0, max_range: 100, normal_min: 0, normal_max: 100, unit: '' };
  }

  generateReading(sensorType: string): SensorReading {
    const config = this.getSensorConfig(sensorType);
    let baseValue = this.baseValues.get(sensorType);
    if (baseValue === undefined) {
      baseValue = (config.normal_min + config.normal_max) / 2;
      this.baseValues.set(sensorType, baseValue);
    }
    const trend = this.trends.get(sensorType) || 0;
    baseValue += trend;
    const variationRange = (config.max_range - config.min_range) * 0.01;
    const variation = (Math.random() - 0.5) * variationRange;
    let value = baseValue + variation;
    value = Math.max(config.min_range, Math.min(config.max_range, value));
    this.baseValues.set(sensorType, value);
    return {
      sensor_type: sensorType,
      value: Math.round(value * 100) / 100,
      unit: config.unit,
      min_range: config.min_range,
      max_range: config.max_range,
      normal_min: config.normal_min,
      normal_max: config.normal_max,
    };
  }

  generateAllReadings(): SensorReading[] {
    return Object.values(SENSOR_TYPES).map(type => this.generateReading(type));
  }

  simulateDriving() {
    this.baseValues.set(SENSOR_TYPES.RPM, 2000 + Math.random() * 1000);
    this.baseValues.set(SENSOR_TYPES.SPEED, 40 + Math.random() * 40);
    this.baseValues.set(SENSOR_TYPES.ENGINE_LOAD, 40 + Math.random() * 20);
    this.baseValues.set(SENSOR_TYPES.EV_BATTERY_CURRENT, 50 + Math.random() * 100);
  }

  simulateIdle() {
    this.baseValues.set(SENSOR_TYPES.RPM, 700 + Math.random() * 200);
    this.baseValues.set(SENSOR_TYPES.SPEED, 0);
    this.baseValues.set(SENSOR_TYPES.ENGINE_LOAD, 15 + Math.random() * 10);
  }
}

export const vehicleSimulator = new VehicleSimulator();
