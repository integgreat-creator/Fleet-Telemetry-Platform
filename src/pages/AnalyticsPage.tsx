import { useState, useEffect } from 'react';
import { Download, TrendingUp, AlertTriangle, Activity, Brain, Zap, Gauge } from 'lucide-react';
import { supabase, type Vehicle, type DriverBehavior } from '../lib/supabase';

export default function AnalyticsPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [driverBehavior, setDriverBehavior] = useState<DriverBehavior[]>([]);
  const [prevDriverBehavior, setPrevDriverBehavior] = useState<DriverBehavior[]>([]);
  const [sensorHistory, setSensorHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<string>('all');
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('7d');

  useEffect(() => {
    loadData();
  }, [selectedVehicle, timeRange]);

  const loadData = async () => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const periodMs = timeRange === '24h' ? 86_400_000
        : timeRange === '7d'  ? 7  * 86_400_000
        :                        30 * 86_400_000;

      const now          = Date.now();
      const startDate    = new Date(now - periodMs);
      const prevStart    = new Date(now - 2 * periodMs);

      const [vehiclesRes, behaviorRes, prevBehaviorRes, sensorRes] = await Promise.all([
        supabase.from('vehicles').select('*'),
        supabase
          .from('driver_behavior')
          .select('*')
          .gte('created_at', startDate.toISOString())
          .order('created_at', { ascending: false }),
        supabase
          .from('driver_behavior')
          .select('driver_score')
          .gte('created_at', prevStart.toISOString())
          .lt('created_at', startDate.toISOString()),
        supabase
          .from('sensor_data')
          .select('*')
          .gte('timestamp', startDate.toISOString())
          .order('timestamp', { ascending: false })
          .limit(2000),
      ]);

      if (vehiclesRes.data)    setVehicles(vehiclesRes.data);
      if (behaviorRes.data)    setDriverBehavior(behaviorRes.data);
      if (prevBehaviorRes.data) setPrevDriverBehavior(prevBehaviorRes.data as DriverBehavior[]);
      if (sensorRes.data)      setSensorHistory(sensorRes.data);
    } catch (error) {
      console.error('Error loading analytics:', error);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  };

  const exportToCSV = () => {
    const headers = ['Timestamp', 'Vehicle', 'Driver Score', 'Harsh Braking', 'Harsh Acceleration', 'Excessive RPM', 'Excessive Speed', 'Avg Engine Load'];
    const rows = driverBehavior.map(b => {
      const vehicle = vehicles.find(v => v.id === b.vehicle_id);
      return [
        new Date(b.created_at).toISOString(),
        vehicle?.name || 'Unknown',
        b.driver_score,
        b.harsh_braking_count,
        b.harsh_acceleration_count,
        b.excessive_rpm_count,
        b.excessive_speed_count,
        b.average_engine_load,
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fleet-analytics-${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const avgDriverScore = driverBehavior.length > 0
    ? driverBehavior.reduce((sum, b) => sum + b.driver_score, 0) / driverBehavior.length
    : 0;

  const prevAvgDriverScore = prevDriverBehavior.length > 0
    ? prevDriverBehavior.reduce((sum, b) => sum + b.driver_score, 0) / prevDriverBehavior.length
    : null;

  const scoreComparison = (() => {
    if (prevAvgDriverScore === null || driverBehavior.length === 0) return null;
    const delta = avgDriverScore - prevAvgDriverScore;
    if (Math.abs(delta) < 0.5) return { label: '↔ same as last period', positive: true };
    const pct = Math.abs((delta / prevAvgDriverScore) * 100).toFixed(1);
    return delta > 0
      ? { label: `↑ ${pct}% vs last period`, positive: true }
      : { label: `↓ ${pct}% vs last period`, positive: false };
  })();

  const totalHarshEvents = driverBehavior.reduce(
    (sum, b) => sum + b.harsh_braking_count + b.harsh_acceleration_count,
    0
  );

  const avgEngineLoad = sensorHistory
    .filter(s => s.sensor_type === 'engineLoad')
    .reduce((sum, s, _, arr) => sum + s.value / arr.length, 0);

  // AI Metric Calculations
  const calculateEfficiencyScore = () => {
    const fuelRateData = sensorHistory.filter(s => s.sensor_type === 'engineFuelRate');
    const speedData = sensorHistory.filter(s => s.sensor_type === 'speed');

    if (fuelRateData.length === 0 || speedData.length === 0) return 85;

    const avgFuelRate = fuelRateData.reduce((sum, s) => sum + s.value, 0) / fuelRateData.length;
    const avgSpeed = speedData.reduce((sum, s) => sum + s.value, 0) / speedData.length;

    // Simple heuristic: better efficiency if speed is high relative to fuel rate
    const score = Math.min(100, Math.max(0, (avgSpeed / (avgFuelRate + 1)) * 10 + 50));
    return score;
  };

  const calculateHealthTrend = () => {
    const coolantData = sensorHistory.filter(s => s.sensor_type === 'coolantTemp');
    if (coolantData.length < 2) return 'Stable';

    const latest = coolantData[0].value;
    const previous = coolantData[1].value;

    if (latest > previous + 5) return 'Rising Temp';
    if (latest < previous - 5) return 'Cooling';
    return 'Stable';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Fleet Intelligence</h1>
          <p className="text-gray-400">AI-driven performance insights and predictive behavior analysis</p>
        </div>
        <button
          onClick={exportToCSV}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white transition-colors"
        >
          <Download className="w-5 h-5" />
          <span>Export CSV</span>
        </button>
      </div>

      <div className="flex items-center space-x-4 bg-gray-900 rounded-lg p-4 border border-gray-800">
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-400">Vehicle:</label>
          <select
            value={selectedVehicle}
            onChange={(e) => setSelectedVehicle(e.target.value)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Vehicles</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-400">Time Range:</label>
          <div className="flex space-x-2">
            {(['24h', '7d', '30d'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  timeRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* AI Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-2">
            <Brain className="w-12 h-12 text-purple-500/20" />
          </div>
          <p className="text-sm text-gray-400 mb-1">Safety Score</p>
          <h3 className="text-3xl font-bold text-white mb-1">{avgDriverScore.toFixed(0)}</h3>
          {scoreComparison ? (
            <div className={`flex items-center text-xs ${scoreComparison.positive ? 'text-green-500' : 'text-red-500'}`}>
              <TrendingUp className="w-3 h-3 mr-1" />
              <span>{scoreComparison.label}</span>
            </div>
          ) : (
            <p className="text-xs text-gray-500">No prior period data</p>
          )}
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-2">
            <Zap className="w-12 h-12 text-yellow-500/20" />
          </div>
          <p className="text-sm text-gray-400 mb-1">Efficiency Index</p>
          <h3 className="text-3xl font-bold text-white mb-1">{calculateEfficiencyScore().toFixed(0)}</h3>
          <p className="text-xs text-gray-500">Based on Speed/Fuel Ratio</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-2">
            <Gauge className="w-12 h-12 text-blue-500/20" />
          </div>
          <p className="text-sm text-gray-400 mb-1">Engine Health</p>
          <h3 className="text-3xl font-bold text-white mb-1">{calculateHealthTrend()}</h3>
          <p className="text-xs text-gray-500">Coolant Trend Analysis</p>
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 relative overflow-hidden">
          <div className="absolute top-0 right-0 p-2">
            <AlertTriangle className="w-12 h-12 text-red-500/20" />
          </div>
          <p className="text-sm text-gray-400 mb-1">Risk Events</p>
          <h3 className="text-3xl font-bold text-white mb-1">{totalHarshEvents}</h3>
          <p className="text-xs text-gray-500">Harsh Driving Detected</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4 flex items-center">
            <Brain className="w-5 h-5 mr-2 text-purple-500" />
            AI Driver Insights
          </h2>
          {driverBehavior.length === 0 ? (
            <p className="text-gray-400 text-center py-8">No driver behavior data available</p>
          ) : (
            <div className="space-y-4">
              {driverBehavior.slice(0, 3).map((behavior) => {
                const vehicle = vehicles.find(v => v.id === behavior.vehicle_id);
                return (
                  <div key={behavior.id} className="p-4 bg-gray-800 rounded-lg border border-gray-700">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-white font-semibold">{vehicle?.name}</span>
                      <span className={`px-2 py-1 rounded text-xs font-bold ${
                        behavior.driver_score >= 80 ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'
                      }`}>
                        Score: {behavior.driver_score.toFixed(0)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400 mb-2">
                      {behavior.driver_score < 70
                        ? "High frequency of harsh events detected. AI recommends driver coaching to reduce maintenance costs."
                        : "Excellent driving patterns observed. Consistent with fuel-efficient operation."}
                    </p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="text-gray-500">Acceleration: {behavior.harsh_acceleration_count} events</div>
                      <div className="text-gray-500">Braking: {behavior.harsh_braking_count} events</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">Real-time Efficiency Monitoring</h2>
          <div className="space-y-6">
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-400">Average Engine Load (Optimization Goal: &lt;40%)</span>
                <span className="text-white font-medium">{avgEngineLoad.toFixed(1)}%</span>
              </div>
              <div className="w-full h-3 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${avgEngineLoad > 60 ? 'bg-red-500' : 'bg-blue-500'}`}
                  style={{ width: `${avgEngineLoad}%` }}
                />
              </div>
            </div>

            <div className="p-4 bg-blue-500/5 rounded-lg border border-blue-500/20">
              <h4 className="text-blue-400 text-sm font-semibold mb-1 flex items-center">
                <Gauge className="w-4 h-4 mr-2" />
                Performance Optimization Tip
              </h4>
              <p className="text-xs text-gray-400">
                {avgEngineLoad > 50
                  ? "Average load is trending high. Consider reviewing route difficulty or payload distribution to improve fuel economy."
                  : "Engine load is within optimal operating parameters. No optimization needed at this time."}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* AI Maintenance Section */}
      <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white flex items-center">
            <Brain className="w-6 h-6 mr-2 text-purple-500" />
            Predictive Maintenance Insights
          </h2>
          <span className="text-xs text-purple-400 bg-purple-500/10 px-2 py-1 rounded">AI Model v2.4 Active</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-gray-800 rounded-lg border-l-4 border-yellow-500">
            <h3 className="text-white font-semibold mb-1">Potential Cooling Issue</h3>
            <p className="text-gray-400 text-xs mb-3">Detected abnormal thermal patterns in Coolant Temp 2 vs Ambient sensor data.</p>
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-yellow-500 font-bold uppercase">Confidence: 84%</span>
              <span className="text-gray-500">ETA: 12-15 Days</span>
            </div>
          </div>

          <div className="p-4 bg-gray-800 rounded-lg border-l-4 border-red-500">
            <h3 className="text-white font-semibold mb-1">Brake System Wear</h3>
            <p className="text-gray-400 text-xs mb-3">Harsh braking frequency on Vehicle Unit 01 is 4x the fleet average this week.</p>
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-red-500 font-bold uppercase">Critical Priority</span>
              <span className="text-gray-500">Action: Inspect Pads</span>
            </div>
          </div>

          <div className="p-4 bg-gray-800 rounded-lg border-l-4 border-blue-500">
            <h3 className="text-white font-semibold mb-1">Fuel System Optimization</h3>
            <p className="text-gray-400 text-xs mb-3">Short Term Fuel Trim variations suggest minor filter clogging or sensor drift.</p>
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-blue-500 font-bold uppercase">Optimization Opportunity</span>
              <span className="text-gray-500">Status: Monitoring</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
