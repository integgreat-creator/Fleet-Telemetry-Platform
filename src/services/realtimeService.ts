import { supabase, type SensorData } from '../lib/supabase';

type SensorCallback = (data: SensorData[]) => void;
type AlertCallback = (alert: any) => void;

class RealtimeService {
  private sensorCallbacks: Map<string, SensorCallback[]> = new Map();
  private alertCallbacks: AlertCallback[] = [];

  /**
   * Subscribe to live sensor_data inserts for a specific vehicle.
   * Returns an unsubscribe function.
   */
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
      .subscribe();

    return () => {
      channel.unsubscribe();
      const cbs = this.sensorCallbacks.get(vehicleId) || [];
      const index = cbs.indexOf(callback);
      if (index > -1) cbs.splice(index, 1);
    };
  }

  /**
   * Subscribe to real-time alerts scoped to the caller's vehicles only.
   * Filters to the given vehicle IDs to prevent cross-fleet data leakage.
   *
   * @param vehicleIds  Vehicle UUIDs the current user owns or manages.
   */
  subscribeToAlerts(vehicleIds: string[], callback: AlertCallback) {
    if (vehicleIds.length === 0) return () => {};

    this.alertCallbacks.push(callback);

    const filter = `vehicle_id=in.(${vehicleIds.join(',')})`;

    const channel = supabase
      .channel(`alerts:scoped:${vehicleIds[0]}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'alerts',
          filter,
        },
        (payload) => {
          callback(payload.new);
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
      const index = this.alertCallbacks.indexOf(callback);
      if (index > -1) this.alertCallbacks.splice(index, 1);
    };
  }

  /** No-op — kept so existing call-sites in App.tsx compile without changes. */
  stopAllSimulations() {}
}

export const realtimeService = new RealtimeService();
