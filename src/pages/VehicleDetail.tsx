import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft, Play, Square, Settings, X, Save,
  ToggleLeft, ToggleRight, Globe, Loader2, Check,
} from 'lucide-react';
import { type Vehicle, type SensorData, supabase } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import { vehicleSimulator } from '../services/simulatorService';
import SensorCard from '../components/SensorCard';

// Sensors that fleet managers typically configure thresholds for.
const THRESHOLD_SENSORS = [
  { key: 'rpm',               label: 'Engine RPM',              unit: 'RPM',  defaultMin: null, defaultMax: 4500 },
  { key: 'speed',             label: 'Vehicle Speed',           unit: 'km/h', defaultMin: null, defaultMax: 120  },
  { key: 'coolantTemp',       label: 'Coolant Temperature',     unit: '°C',   defaultMin: null, defaultMax: 105  },
  { key: 'batteryVoltage',    label: 'Battery Voltage',         unit: 'V',    defaultMin: 11.5, defaultMax: null },
  { key: 'controlModuleVoltage', label: 'Module Voltage',       unit: 'V',    defaultMin: 11.5, defaultMax: null },
  { key: 'engineLoad',        label: 'Engine Load',             unit: '%',    defaultMin: null, defaultMax: 85   },
  { key: 'fuelLevel',         label: 'Fuel Level',              unit: '%',    defaultMin: 15,   defaultMax: null },
  { key: 'intakeAirTemp',     label: 'Intake Air Temperature',  unit: '°C',   defaultMin: null, defaultMax: 65   },
  { key: 'throttlePosition',  label: 'Throttle Position',       unit: '%',    defaultMin: null, defaultMax: null },
  { key: 'maf',               label: 'Mass Air Flow',           unit: 'g/s',  defaultMin: null, defaultMax: null },
  { key: 'fuelPressure',      label: 'Fuel Pressure',           unit: 'kPa',  defaultMin: null, defaultMax: null },
  { key: 'engineOilTemp',     label: 'Engine Oil Temp',         unit: '°C',   defaultMin: null, defaultMax: 130  },
];

interface ThresholdRow {
  sensor_type:   string;
  min_value:     string; // kept as string for input
  max_value:     string;
  alert_enabled: boolean;
  dirty:         boolean;
}

interface VehicleDetailProps {
  vehicle: Vehicle;
  onBack:  () => void;
}

export default function VehicleDetail({ vehicle, onBack }: VehicleDetailProps) {
  const [sensorData,    setSensorData]    = useState<Map<string, SensorData>>(new Map());
  const [previousData,  setPreviousData]  = useState<Map<string, number>>(new Map());
  const [isSimulating,  setIsSimulating]  = useState(vehicle.is_active);

  // ── Threshold panel ──────────────────────────────────────────────────────
  const [showThresholds,  setShowThresholds]  = useState(false);
  const [thresholdRows,   setThresholdRows]   = useState<Map<string, ThresholdRow>>(new Map());
  const [thresholdsLoading, setThresholdsLoading] = useState(false);
  const [applyToFleet,    setApplyToFleet]    = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [saveOk,          setSaveOk]          = useState(false);
  const [thresholdError,  setThresholdError]  = useState<string | null>(null);

  // ── Real-time sensor subscription ────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = realtimeService.subscribeToSensorData(vehicle.id, (data) => {
      setSensorData((prev) => {
        const newMap = new Map(prev);
        setPreviousData((prevPrev) => {
          const prevMap = new Map(prevPrev);
          data.forEach((reading) => {
            const existing = newMap.get(reading.sensor_type);
            if (existing) prevMap.set(reading.sensor_type, existing.value);
            newMap.set(reading.sensor_type, reading);
          });
          return prevMap;
        });
        return newMap;
      });
    });
    return () => { unsubscribe(); };
  }, [vehicle.id]);

  // ── Load thresholds ───────────────────────────────────────────────────────
  const loadThresholds = useCallback(async () => {
    setThresholdsLoading(true);
    setThresholdError(null);
    try {
      // Load both fleet-scoped and vehicle-scoped thresholds. Vehicle-level
      // rows take precedence — load fleet first, then overwrite with vehicle.
      const queries: Promise<{ data: any[] | null; error: any }>[] = [
        supabase.from('thresholds').select('*').eq('vehicle_id', vehicle.id) as any,
      ];
      if (vehicle.fleet_id) {
        queries.push(
          supabase.from('thresholds').select('*')
            .eq('fleet_id', vehicle.fleet_id)
            .is('vehicle_id', null) as any,
        );
      }
      const results = await Promise.all(queries);
      for (const { error } of results) { if (error) throw error; }

      const existing = new Map<string, ThresholdRow>();
      // Seed defaults for all configurable sensors
      THRESHOLD_SENSORS.forEach((s) => {
        existing.set(s.key, {
          sensor_type:   s.key,
          min_value:     s.defaultMin != null ? String(s.defaultMin) : '',
          max_value:     s.defaultMax != null ? String(s.defaultMax) : '',
          alert_enabled: true,
          dirty:         false,
        });
      });
      // Apply fleet-scoped rows first (lower priority), then vehicle-scoped (higher).
      const fleetRows   = results[1]?.data ?? [];
      const vehicleRows = results[0]?.data ?? [];
      for (const row of [...fleetRows, ...vehicleRows]) {
        if (existing.has(row.sensor_type)) {
          existing.set(row.sensor_type, {
            sensor_type:   row.sensor_type,
            min_value:     row.min_value != null ? String(row.min_value) : '',
            max_value:     row.max_value != null ? String(row.max_value) : '',
            alert_enabled: row.alert_enabled ?? true,
            dirty:         false,
          });
        }
      }
      setThresholdRows(existing);
    } catch (e: any) {
      setThresholdError(e?.message ?? 'Failed to load thresholds');
    } finally {
      setThresholdsLoading(false);
    }
  }, [vehicle.id]);

  const openThresholds = () => {
    setShowThresholds(true);
    setSaveOk(false);
    setThresholdError(null);
    loadThresholds();
  };

  // ── Save thresholds ───────────────────────────────────────────────────────
  const saveThresholds = async () => {
    setSaving(true);
    setSaveOk(false);
    setThresholdError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session!.access_token}`,
        'apikey':        import.meta.env.VITE_SUPABASE_ANON_KEY,
      };
      const baseUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/threshold-api`;

      const rows = Array.from(thresholdRows.values());
      let errorMsg: string | null = null;

      for (const row of rows) {
        const payload: Record<string, unknown> = {
          sensor_type:   row.sensor_type,
          min_value:     row.min_value     !== '' ? parseFloat(row.min_value)     : null,
          max_value:     row.max_value     !== '' ? parseFloat(row.max_value)     : null,
          alert_enabled: row.alert_enabled,
        };

        if (applyToFleet && vehicle.fleet_id) {
          // Apply to all vehicles in the fleet
          payload.fleet_id = vehicle.fleet_id;
        } else {
          payload.vehicle_id = vehicle.id;
        }

        const res = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          errorMsg = (body as any).error ?? `Save failed (${res.status})`;
          break;
        }
      }

      if (errorMsg) {
        setThresholdError(errorMsg);
      } else {
        setSaveOk(true);
        // Mark all rows as clean
        setThresholdRows((prev) => {
          const m = new Map(prev);
          m.forEach((v, k) => m.set(k, { ...v, dirty: false }));
          return m;
        });
      }
    } catch (e: any) {
      setThresholdError(e?.message ?? 'Unexpected error');
    } finally {
      setSaving(false);
    }
  };

  const updateRow = (sensorKey: string, field: keyof ThresholdRow, value: string | boolean) => {
    setThresholdRows((prev) => {
      const m   = new Map(prev);
      const row = m.get(sensorKey);
      if (row) m.set(sensorKey, { ...row, [field]: value, dirty: true });
      return m;
    });
    setSaveOk(false);
  };

  // ── Simulation controls ───────────────────────────────────────────────────
  const handleToggleSimulation = async () => {
    if (isSimulating) {
      await realtimeService.stopSimulation(vehicle.id);
      setIsSimulating(false);
    } else {
      await realtimeService.startSimulation(vehicle);
      setIsSimulating(true);
    }
  };

  const sensors = Array.from(sensorData.values());

  return (
    <div className="space-y-6">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button onClick={onBack} className="p-2 hover:bg-gray-800 rounded-lg transition-colors">
            <ArrowLeft className="w-6 h-6 text-gray-400" />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-white">{vehicle.name}</h1>
            <p className="text-gray-400">{vehicle.make} {vehicle.model} ({vehicle.year}) · VIN: {vehicle.vin}</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={handleToggleSimulation}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
              isSimulating ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isSimulating ? <><Square className="w-5 h-5" /><span>Stop Simulation</span></> : <><Play className="w-5 h-5" /><span>Start Simulation</span></>}
          </button>
          <button
            onClick={openThresholds}
            title="Configure alert thresholds"
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <Settings className="w-6 h-6 text-gray-400" />
          </button>
        </div>
      </div>

      {/* ── Vehicle status card ───────────────────────────────────────────── */}
      <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-gray-400 mb-1">Status</p>
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${vehicle.is_active ? 'bg-green-500' : 'bg-gray-600'}`} />
              <p className="text-white font-semibold">{vehicle.is_active ? 'Active' : 'Offline'}</p>
            </div>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Health Score</p>
            <p className={`text-2xl font-bold ${(vehicle.health_score ?? 0) >= 80 ? 'text-green-500' : (vehicle.health_score ?? 0) >= 60 ? 'text-yellow-500' : 'text-red-500'}`}>
              {vehicle.health_score != null ? vehicle.health_score.toFixed(0) : '—'}%
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Last Connected</p>
            <p className="text-white font-semibold">
              {vehicle.last_connected ? new Date(vehicle.last_connected).toLocaleString() : 'Never'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Sensor grid ──────────────────────────────────────────────────── */}
      {sensors.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-gray-400 mb-4">No sensor data available</p>
          <p className="text-gray-500 text-sm">Start the simulation to generate live sensor readings</p>
        </div>
      ) : (
        <div>
          <h2 className="text-xl font-bold text-white mb-4">Live Sensor Data</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {sensors.map((sensor) => {
              const config = vehicleSimulator.getSensorConfig(sensor.sensor_type);
              return (
                <SensorCard
                  key={sensor.sensor_type}
                  sensorType={sensor.sensor_type}
                  value={sensor.value}
                  unit={sensor.unit}
                  normalMin={config.normal_min}
                  normalMax={config.normal_max}
                  previousValue={previousData.get(sensor.sensor_type)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Threshold settings modal ─────────────────────────────────────── */}
      {showThresholds && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-start justify-end z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg h-full max-h-[calc(100vh-2rem)] flex flex-col shadow-2xl">

            {/* Panel header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-800 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-white">Alert Thresholds</h2>
                <p className="text-xs text-gray-400 mt-0.5">{vehicle.name}</p>
              </div>
              <button onClick={() => setShowThresholds(false)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Sensor rows */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {thresholdsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_80px_80px_40px] gap-2 px-2 mb-1">
                    <span className="text-xs text-gray-500 uppercase tracking-wide">Sensor</span>
                    <span className="text-xs text-gray-500 uppercase tracking-wide text-center">Min</span>
                    <span className="text-xs text-gray-500 uppercase tracking-wide text-center">Max</span>
                    <span className="text-xs text-gray-500 uppercase tracking-wide text-center">On</span>
                  </div>

                  {THRESHOLD_SENSORS.map((sensor) => {
                    const row = thresholdRows.get(sensor.key);
                    if (!row) return null;
                    return (
                      <div
                        key={sensor.key}
                        className={`grid grid-cols-[1fr_80px_80px_40px] gap-2 items-center px-3 py-2.5 rounded-xl border ${
                          row.dirty ? 'border-blue-700/50 bg-blue-900/10' : 'border-gray-800 bg-gray-800/30'
                        }`}
                      >
                        <div>
                          <p className="text-sm text-white font-medium">{sensor.label}</p>
                          <p className="text-xs text-gray-500">{sensor.unit}</p>
                        </div>
                        <input
                          type="number"
                          value={row.min_value}
                          onChange={(e) => updateRow(sensor.key, 'min_value', e.target.value)}
                          placeholder="—"
                          className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:border-blue-500"
                        />
                        <input
                          type="number"
                          value={row.max_value}
                          onChange={(e) => updateRow(sensor.key, 'max_value', e.target.value)}
                          placeholder="—"
                          className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:border-blue-500"
                        />
                        <button
                          onClick={() => updateRow(sensor.key, 'alert_enabled', !row.alert_enabled)}
                          className="flex justify-center"
                          title={row.alert_enabled ? 'Alerts enabled' : 'Alerts disabled'}
                        >
                          {row.alert_enabled
                            ? <ToggleRight className="w-6 h-6 text-green-400" />
                            : <ToggleLeft  className="w-6 h-6 text-gray-600" />}
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-800 flex-shrink-0 space-y-3">

              {/* Fleet-wide toggle */}
              {vehicle.fleet_id && (
                <button
                  onClick={() => setApplyToFleet((v) => !v)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                    applyToFleet
                      ? 'bg-purple-900/30 border-purple-700/50 text-purple-300'
                      : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:text-gray-300'
                  }`}
                >
                  <Globe className={`w-4 h-4 ${applyToFleet ? 'text-purple-400' : 'text-gray-600'}`} />
                  {applyToFleet ? 'Apply to all fleet vehicles (ON)' : 'Apply to all fleet vehicles (this vehicle only)'}
                </button>
              )}

              {thresholdError && (
                <p className="text-xs text-red-400 text-center">{thresholdError}</p>
              )}

              <button
                onClick={saveThresholds}
                disabled={saving || thresholdsLoading}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium text-sm transition-colors"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : saveOk ? (
                  <Check className="w-4 h-4 text-green-300" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {saving ? 'Saving…' : saveOk ? (applyToFleet ? 'Applied to fleet!' : 'Saved!') : 'Save Thresholds'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
