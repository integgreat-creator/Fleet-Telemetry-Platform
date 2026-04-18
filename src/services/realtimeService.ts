import { supabase, type Vehicle, type SensorData } from '../lib/supabase';
import { vehicleSimulator, SENSOR_TYPES } from './simulatorService';

type SensorCallback = (data: SensorData[]) => void;
type AlertCallback = (alert: any) => void;

class RealtimeService {
  private sensorCallbacks: Map<string, SensorCallback[]> = new Map();
  private alertCallbacks: AlertCallback[] = [];
  private simulationIntervals: Map<string, number> = new Map();
  private isSimulating: Map<string, boolean> = new Map();

  subscribeToSensorData(vehicleId: string, callback: SensorCallback) {
    const callbacks = this.sensorCallbacks.get(vehicleId) || [];
    callbacks.push(callback);
    this.sensorCallbacks.set(vehicleId, callbacks);

    const channel = supabase
      .channel(`sensor_data:${vehicleId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'sensor_data',
          filter: `vehicle_id=eq.${vehicleId}`,
        },
        (payload) => {
          callbacks.forEach(cb => cb([payload.new as SensorData]));
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR') {
          console.error(`Realtime channel error for vehicle ${vehicleId}:`, err);
        } else if (status === 'TIMED_OUT') {
          console.warn(`Realtime channel timed out for vehicle ${vehicleId} — will auto-reconnect`);
        } else if (status === 'CLOSED') {
          console.info(`Realtime channel closed for vehicle ${vehicleId}`);
        }
      });

    return () => {
      channel.unsubscribe();
      const cbs = this.sensorCallbacks.get(vehicleId) || [];
      const index = cbs.indexOf(callback);
      if (index > -1) {
        cbs.splice(index, 1);
      }
    };
  }

  subscribeToAlerts(callback: AlertCallback) {
    this.alertCallbacks.push(callback);

    const channel = supabase
      .channel('alerts')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'alerts',
        },
        (payload) => {
          callback(payload.new);
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('Alerts realtime channel error:', err);
          // Re-authenticate if JWT expired
          supabase.auth.getSession().then(({ data }) => {
            if (!data.session) {
              window.location.href = '/login';
            }
          });
        } else if (status === 'TIMED_OUT') {
          console.warn('Alerts realtime channel timed out — will auto-reconnect');
        }
      });

    return () => {
      channel.unsubscribe();
      const index = this.alertCallbacks.indexOf(callback);
      if (index > -1) {
        this.alertCallbacks.splice(index, 1);
      }
    };
  }

  async startSimulation(vehicle: Vehicle) {
    if (this.isSimulating.get(vehicle.id)) {
      return;
    }

    this.isSimulating.set(vehicle.id, true);

    await supabase
      .from('vehicles')
      .update({
        is_active: true,
        last_connected: new Date().toISOString()
      })
      .eq('id', vehicle.id);

    const interval = setInterval(async () => {
      if (!this.isSimulating.get(vehicle.id)) {
        clearInterval(interval);
        return;
      }

      if (Math.random() < 0.3) {
        vehicleSimulator.simulateDriving();
      } else if (Math.random() < 0.1) {
        vehicleSimulator.simulateIdle();
      }

      const readings = vehicleSimulator.generateAllReadings();

      // Filter readings based on fuel_type
      const fuelType = (vehicle.fuel_type || 'petrol').toLowerCase();
      const filteredReadings = readings.filter(reading => {
        const type = reading.sensor_type;

        // Always show core sensors
        const isCore = ['rpm', 'speed', 'coolantTemp', 'batteryVoltage', 'throttlePosition', 'intakeAirTemp', 'engineLoad'].includes(type);
        if (isCore) return true;

        // CNG specific
        if (type.startsWith('cng')) return fuelType === 'cng';

        // EV specific
        if (type.startsWith('ev')) return fuelType === 'ev';

        // Fuel specific
        if (type === 'fuelLevel' || type === 'engineFuelRate' || type.includes('Fuel')) {
          return fuelType !== 'ev'; // EVs don't have fuel levels/rates
        }

        return true;
      });

      const sensorData = filteredReadings.map(reading => ({
        vehicle_id: vehicle.id,
        sensor_type: reading.sensor_type,
        value: reading.value,
        unit: reading.unit,
        timestamp: new Date().toISOString(),
      }));

      // Use the sensor-api edge function instead of direct insert to trigger AI Anomaly Detection
      try {
        for (const data of sensorData) {
          await supabase.functions.invoke('sensor-api', {
            body: data,
          });
        }
      } catch (e) {
        console.error('Error calling sensor-api:', e);
        // Fallback to direct insert if function fails (development only)
        for (const data of sensorData) {
          await supabase.from('sensor_data').insert(data);
        }
      }

      const callbacks = this.sensorCallbacks.get(vehicle.id) || [];
      if (callbacks.length > 0) {
        const fullData = sensorData.map(d => ({
          ...d,
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
        })) as SensorData[];
        callbacks.forEach(cb => cb(fullData));
      }

      await this.analyzeDrivingBehavior(vehicle.id, filteredReadings);
    }, 1000);

    this.simulationIntervals.set(vehicle.id, interval as unknown as number);
  }

  async stopSimulation(vehicleId: string) {
    this.isSimulating.set(vehicleId, false);
    const interval = this.simulationIntervals.get(vehicleId);
    if (interval) {
      clearInterval(interval);
      this.simulationIntervals.delete(vehicleId);
    }

    await supabase
      .from('vehicles')
      .update({ is_active: false })
      .eq('id', vehicleId);
  }

  private async analyzeDrivingBehavior(vehicleId: string, readings: any[]) {
    const rpmReading = readings.find(r => r.sensor_type === SENSOR_TYPES.RPM);
    const speedReading = readings.find(r => r.sensor_type === SENSOR_TYPES.SPEED);
    const engineLoadReading = readings.find(r => r.sensor_type === SENSOR_TYPES.ENGINE_LOAD);

    if (!rpmReading || !speedReading || !engineLoadReading) return;

    let harshBraking = 0;
    let harshAcceleration = 0;
    let excessiveRpm = 0;
    let excessiveSpeed = 0;

    if (rpmReading.value > 5000) excessiveRpm = 1;
    if (speedReading.value > 120) excessiveSpeed = 1;

    const avgEngineLoad = engineLoadReading.value;

    const driverScore = Math.max(0, 100 - (harshBraking * 5 + harshAcceleration * 5 + excessiveRpm * 10 + excessiveSpeed * 10));

    if (Math.random() < 0.1) {
      await supabase.from('driver_behavior').insert({
        vehicle_id: vehicleId,
        harsh_braking_count: harshBraking,
        harsh_acceleration_count: harshAcceleration,
        excessive_rpm_count: excessiveRpm,
        excessive_speed_count: excessiveSpeed,
        average_engine_load: avgEngineLoad,
        driver_score: driverScore,
        trip_start: new Date().toISOString(),
      });
    }
  }

  stopAllSimulations() {
    this.isSimulating.forEach((_, vehicleId) => {
      this.stopSimulation(vehicleId);
    });
  }
}

export const realtimeService = new RealtimeService();
