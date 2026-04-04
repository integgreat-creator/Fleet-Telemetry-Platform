import { useState, useEffect } from 'react';
import { ArrowLeft, Play, Square, Settings } from 'lucide-react';
import { type Vehicle, type SensorData } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import { vehicleSimulator } from '../services/simulatorService';
import SensorCard from '../components/SensorCard';

interface VehicleDetailProps {
  vehicle: Vehicle;
  onBack: () => void;
}

export default function VehicleDetail({ vehicle, onBack }: VehicleDetailProps) {
  const [sensorData, setSensorData] = useState<Map<string, SensorData>>(new Map());
  const [previousData, setPreviousData] = useState<Map<string, number>>(new Map());
  const [isSimulating, setIsSimulating] = useState(vehicle.is_active);

  useEffect(() => {
    const unsubscribe = realtimeService.subscribeToSensorData(vehicle.id, (data) => {
      const newMap = new Map(sensorData);
      const prevMap = new Map(previousData);

      data.forEach((reading) => {
        const existing = newMap.get(reading.sensor_type);
        if (existing) {
          prevMap.set(reading.sensor_type, existing.value);
        }
        newMap.set(reading.sensor_type, reading);
      });

      setSensorData(newMap);
      setPreviousData(prevMap);
    });

    return () => {
      unsubscribe();
    };
  }, [vehicle.id]);

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
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button
            onClick={onBack}
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-gray-400" />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-white">{vehicle.name}</h1>
            <p className="text-gray-400">{vehicle.make} {vehicle.model} ({vehicle.year}) - VIN: {vehicle.vin}</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={handleToggleSimulation}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
              isSimulating
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isSimulating ? (
              <>
                <Square className="w-5 h-5" />
                <span>Stop Simulation</span>
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                <span>Start Simulation</span>
              </>
            )}
          </button>
          <button className="p-2 hover:bg-gray-800 rounded-lg transition-colors">
            <Settings className="w-6 h-6 text-gray-400" />
          </button>
        </div>
      </div>

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
            <p className={`text-2xl font-bold ${
              vehicle.health_score >= 80
                ? 'text-green-500'
                : vehicle.health_score >= 60
                ? 'text-yellow-500'
                : 'text-red-500'
            }`}>
              {vehicle.health_score.toFixed(0)}%
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
    </div>
  );
}
