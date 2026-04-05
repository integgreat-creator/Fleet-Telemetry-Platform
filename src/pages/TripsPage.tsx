import { useState, useEffect } from 'react';
import { Route, Clock, Fuel, TrendingUp, Car } from 'lucide-react';
import { supabase, type Vehicle, type Trip } from '../lib/supabase';

export default function TripsPage() {
  const [trips, setTrips] = useState<(Trip & { vehicle_name?: string })[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed'>('all');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [tripsRes, vehiclesRes] = await Promise.all([
        supabase.from('trips').select('*, vehicles(name)').order('start_time', { ascending: false }).limit(200),
        supabase.from('vehicles').select('*'),
      ]);

      if (tripsRes.data) {
        setTrips(tripsRes.data.map((t: any) => ({ ...t, vehicle_name: t.vehicles?.name })));
      }
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
    } catch (error) {
      console.error('Error loading trips:', error);
    } finally {
      setLoading(false);
    }
  };

  const filtered = trips.filter(t => {
    if (vehicleFilter !== 'all' && t.vehicle_id !== vehicleFilter) return false;
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    return true;
  });

  const totalDistance = trips.reduce((s, t) => s + (t.distance_km || 0), 0);
  const totalFuel = trips.reduce((s, t) => s + (t.fuel_consumed_litres || 0), 0);
  const avgDuration = trips.length > 0
    ? trips.reduce((s, t) => s + (t.duration_minutes || 0), 0) / trips.length
    : 0;

  const fmt = (d: string) =>
    new Date(d).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Trips</h1>
        <p className="text-gray-400">Complete trip history detected from vehicle speed data</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Trips', value: trips.length, icon: Route, color: 'text-blue-500', bg: 'bg-blue-500/20' },
          { label: 'Total Distance', value: `${totalDistance.toFixed(1)} km`, icon: TrendingUp, color: 'text-green-500', bg: 'bg-green-500/20' },
          { label: 'Total Fuel Used', value: `${totalFuel.toFixed(1)} L`, icon: Fuel, color: 'text-yellow-500', bg: 'bg-yellow-500/20' },
          { label: 'Avg Duration', value: `${avgDuration.toFixed(0)} min`, icon: Clock, color: 'text-purple-500', bg: 'bg-purple-500/20' },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 rounded-lg p-5 border border-gray-800">
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{s.value}</p>
            <p className="text-sm text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 bg-gray-900 rounded-lg p-4 border border-gray-800">
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-400">Vehicle:</label>
          <select
            value={vehicleFilter}
            onChange={e => setVehicleFilter(e.target.value)}
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Vehicles</option>
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-400">Status:</label>
          {(['all', 'active', 'completed'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors capitalize ${
                statusFilter === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table or empty state */}
      {filtered.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <Car className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg">No trips recorded yet</p>
          <p className="text-gray-600 text-sm mt-2">
            Trips are detected automatically when vehicles exceed 5 km/h
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Vehicle
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Start
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    End
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Distance
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Fuel
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Avg Speed
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Idle
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {filtered.map(trip => (
                  <tr key={trip.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="px-4 py-3 text-white font-medium text-sm">
                      {trip.vehicle_name || '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm">
                      {fmt(trip.start_time)}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm">
                      {trip.end_time ? fmt(trip.end_time) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm text-right">
                      {trip.duration_minutes ? `${trip.duration_minutes} min` : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm text-right">
                      {trip.distance_km ? `${trip.distance_km.toFixed(1)} km` : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm text-right">
                      {trip.fuel_consumed_litres ? `${trip.fuel_consumed_litres.toFixed(2)} L` : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm text-right">
                      {trip.avg_speed_kmh ? `${trip.avg_speed_kmh} km/h` : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-300 text-sm text-right">
                      {trip.idle_time_minutes ? `${trip.idle_time_minutes} min` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {trip.status === 'active' ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5 animate-pulse" />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                          Completed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
