import { AlertTriangle, AlertCircle, Info, Check, Lightbulb, Trash2 } from 'lucide-react';
import type { Alert } from '../lib/supabase';

interface AlertCardProps {
  alert: Alert;
  onAcknowledge: (alertId: string) => void;
  onDelete?: (alertId: string) => void;
}

export default function AlertCard({ alert, onAcknowledge, onDelete }: AlertCardProps) {
  const getSeverityIcon = () => {
    switch (alert.severity) {
      case 'critical':
        return <AlertCircle className="w-5 h-5 text-red-500" />;
      case 'warning':
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      default:
        return <Info className="w-5 h-5 text-blue-500" />;
    }
  };

  const getSeverityColor = () => {
    switch (alert.severity) {
      case 'critical':
        return 'border-red-500 bg-red-500/10';
      case 'warning':
        return 'border-yellow-500 bg-yellow-500/10';
      default:
        return 'border-blue-500 bg-blue-500/10';
    }
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

  const getHumanFriendlyMessage = (alert: Alert) => {
    const type = alert.sensor_type.toLowerCase();
    const value = alert.value;

    // Engine & Performance
    if (type.includes('rpm')) {
      return value > 4000
        ? "Engine is working too hard. Consider upshifting to protect the motor and save fuel."
        : "Engine RPM is outside normal range. Monitor for steady idling.";
    }
    if (type.includes('coolanttemp')) {
      return value > 105
        ? "The engine is running hot. Check coolant levels and avoid heavy loads to prevent overheating."
        : "Engine temperature is rising. Ensure the cooling system is functioning properly.";
    }
    if (type.includes('engineload')) {
      return value > 80
        ? "High stress on the engine detected. This usually happens during steep climbs or heavy towing."
        : "Engine load is higher than usual for current conditions.";
    }

    // Fuel & Emissions
    if (type.includes('fuellevel')) {
      return value < 15
        ? "Fuel is getting very low. Find a station soon to avoid being stranded."
        : "Low fuel warning. Plan your next refuel stop.";
    }
    if (type.includes('fuelpressure')) {
      return "Irregular fuel pressure detected. This could affect engine performance or fuel efficiency.";
    }

    // Battery & Electrical
    if (type.includes('batteryvoltage')) {
      return value < 11.5
        ? "Battery voltage is low. The vehicle might have trouble starting; check the alternator or battery health."
        : "Voltage fluctuation detected in the electrical system.";
    }

    // Driving Safety
    if (type.includes('speed')) {
      return value > 120
        ? "Vehicle is traveling at high speed. Please slow down for safety and better fuel economy."
        : "Speed limit threshold exceeded.";
    }

    // Default fallback
    return alert.message || `${alert.sensor_type} has reached an unusual level of ${alert.value}.`;
  };

  const getActionableAdvice = (alert: Alert) => {
    const type = alert.sensor_type.toLowerCase();
    if (type.includes('temp')) return "Safely pull over if the warning persists.";
    if (type.includes('battery')) return "Check battery terminals for corrosion.";
    if (type.includes('fuel')) return "Check for fuel cap tightness or leaks.";
    if (type.includes('rpm') || type.includes('speed')) return "Adjust driving style for better efficiency.";
    return "Schedule a diagnostic check soon.";
  };

  return (
    <div className={`rounded-lg p-4 border-2 ${getSeverityColor()} ${alert.acknowledged ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start space-x-3 flex-1">
          {getSeverityIcon()}
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-1">
              <h4 className="text-white font-semibold">
                {alert.sensor_type.replace(/([A-Z])/g, ' $1').trim().toUpperCase()}
              </h4>
              {alert.vehicles && (
                <span className="text-xs text-gray-400">• {alert.vehicles.name}</span>
              )}
            </div>
            <p className="text-white text-base mb-2 font-medium">
              {getHumanFriendlyMessage(alert)}
            </p>
            <div className="flex items-center space-x-2 text-blue-400 bg-blue-400/10 px-3 py-1 rounded-md w-fit mb-3">
              <Lightbulb className="w-4 h-4" />
              <span className="text-xs font-semibold">{getActionableAdvice(alert)}</span>
            </div>
            <p className="text-xs text-gray-500">{formatDate(alert.created_at)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 h-fit">
          {!alert.acknowledged && (
            <button
              onClick={() => onAcknowledge(alert.id)}
              className="flex items-center space-x-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-white transition-colors"
            >
              <Check className="w-4 h-4" />
              <span>Acknowledge</span>
            </button>
          )}
          {alert.acknowledged && (
            <div className="flex items-center space-x-2 px-3 py-1.5 bg-green-600/20 rounded-lg text-sm text-green-500">
              <Check className="w-4 h-4" />
              <span>Acknowledged</span>
            </div>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(alert.id)}
              title="Delete alert"
              className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
