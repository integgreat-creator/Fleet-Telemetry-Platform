import { useMemo } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface SensorCardProps {
  sensorType: string;
  value: number;
  unit: string;
  normalMin: number;
  normalMax: number;
  previousValue?: number;
}

export default function SensorCard({
  sensorType,
  value,
  unit,
  normalMin,
  normalMax,
  previousValue,
}: SensorCardProps) {
  const isWarning = value < normalMin || value > normalMax;
  const isCritical = value < normalMin * 0.8 || value > normalMax * 1.2;

  const trend = useMemo(() => {
    if (!previousValue) return 'neutral';
    if (value > previousValue + 1) return 'up';
    if (value < previousValue - 1) return 'down';
    return 'neutral';
  }, [value, previousValue]);

  const getGaugePercentage = () => {
    const range = normalMax - normalMin;
    const valueInRange = Math.max(normalMin, Math.min(normalMax, value));
    return ((valueInRange - normalMin) / range) * 100;
  };

  const formatSensorName = (type: string) => {
    return type
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <div
      className={`bg-gray-900 rounded-lg p-6 border-2 transition-all ${
        isCritical
          ? 'border-red-500 shadow-lg shadow-red-500/20'
          : isWarning
          ? 'border-yellow-500 shadow-lg shadow-yellow-500/20'
          : 'border-gray-800 hover:border-gray-700'
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-gray-400">{formatSensorName(sensorType)}</h3>
          <div className="flex items-baseline space-x-2 mt-1">
            <span className="text-3xl font-bold text-white">{value.toFixed(1)}</span>
            <span className="text-lg text-gray-500">{unit}</span>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          {trend === 'up' && <TrendingUp className="w-5 h-5 text-green-500" />}
          {trend === 'down' && <TrendingDown className="w-5 h-5 text-red-500" />}
          {trend === 'neutral' && <Minus className="w-5 h-5 text-gray-500" />}
          {(isWarning || isCritical) && (
            <AlertTriangle className={`w-5 h-5 ${isCritical ? 'text-red-500' : 'text-yellow-500'}`} />
          )}
        </div>
      </div>

      <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`absolute left-0 top-0 h-full rounded-full transition-all duration-300 ${
            isCritical
              ? 'bg-red-500'
              : isWarning
              ? 'bg-yellow-500'
              : 'bg-blue-500'
          }`}
          style={{ width: `${getGaugePercentage()}%` }}
        />
      </div>

      <div className="flex justify-between mt-2 text-xs text-gray-500">
        <span>Normal: {normalMin} - {normalMax} {unit}</span>
        {(isWarning || isCritical) && (
          <span className={isCritical ? 'text-red-400' : 'text-yellow-400'}>
            {isCritical ? 'Critical' : 'Warning'}
          </span>
        )}
      </div>
    </div>
  );
}
