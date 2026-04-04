import { Car, Power, Activity, Calendar, Trash2 } from 'lucide-react';
import type { Vehicle } from '../lib/supabase';

interface VehicleCardProps {
  vehicle: Vehicle;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

export default function VehicleCard({ vehicle, onClick, onDelete }: VehicleCardProps) {
  const getHealthColor = (score: number) => {
    if (score >= 80) return 'text-green-500';
    if (score >= 60) return 'text-yellow-500';
    return 'text-red-500';
  };

  const formatDate = (date: string | undefined) => {
    if (!date) return 'Never';
    return new Date(date).toLocaleString();
  };

  return (
    <div
      onClick={onClick}
      className="w-full bg-gray-900 rounded-lg p-6 border border-gray-800 hover:border-blue-500 transition-all text-left cursor-pointer group relative"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(e);
        }}
        className="absolute top-4 right-4 p-2 text-gray-500 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete Vehicle"
      >
        <Trash2 className="w-5 h-5" />
      </button>

      <div className="flex items-start justify-between mb-4 pr-8">
        <div className="flex items-center space-x-3">
          <div className="p-3 bg-blue-600 rounded-lg">
            <Car className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">{vehicle.name}</h3>
            <p className="text-sm text-gray-400">{vehicle.make} {vehicle.model} ({vehicle.year})</p>
          </div>
        </div>
        <div className={`flex items-center space-x-2 px-3 py-1 rounded-full ${
          vehicle.is_active ? 'bg-green-500/20 text-green-500' : 'bg-gray-800 text-gray-500'
        }`}>
          <Power className="w-4 h-4" />
          <span className="text-sm font-medium">{vehicle.is_active ? 'Active' : 'Offline'}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-800">
        <div>
          <div className="flex items-center space-x-2 mb-1">
            <Activity className={`w-4 h-4 ${getHealthColor(vehicle.health_score)}`} />
            <span className="text-xs text-gray-500">Health Score</span>
          </div>
          <p className={`text-xl font-bold ${getHealthColor(vehicle.health_score)}`}>
            {vehicle.health_score.toFixed(0)}%
          </p>
        </div>
        <div>
          <div className="flex items-center space-x-2 mb-1">
            <Calendar className="w-4 h-4 text-gray-500" />
            <span className="text-xs text-gray-500">VIN</span>
          </div>
          <p className="text-sm font-mono text-white truncate">{vehicle.vin}</p>
        </div>
        <div>
          <div className="flex items-center space-x-2 mb-1">
            <Calendar className="w-4 h-4 text-gray-500" />
            <span className="text-xs text-gray-500">Last Connected</span>
          </div>
          <p className="text-xs text-white">{formatDate(vehicle.last_connected)}</p>
        </div>
      </div>
    </div>
  );
}
