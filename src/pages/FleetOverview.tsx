import { useState, useEffect, useCallback } from 'react';
import {
  Car, Activity, AlertTriangle, TrendingUp, Wifi, WifiOff, Shield,
  CheckCircle2, RefreshCw, Clock, ChevronRight, PlusCircle, Map, Bell, Info,
} from 'lucide-react';
import { supabase, type Vehicle, type Alert } from '../lib/supabase';
import type { Page } from '../App';

// Extended alert type that includes the joined vehicle name
interface AlertWithVehicle extends Alert {
  vehicles?: { name: string } | null;
}

interface FleetOverviewProps {
  onNavigate: (page: Page) => void;
}

type TimeFilter = '1d' | '7d' | '30d';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatLastUpdated(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1_000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

// ─── component ────────────────────────────────────────────────────────────────

export default function FleetOverview({ onNavigate }: FleetOverviewProps) {
  const [vehicles, setVehicles]           = useState<Vehicle[]>([]);
  const [alerts, setAlerts]               = useState<Alert[]>([]);
  const [allRecentAlerts, setAllRecent]   = useState<AlertWithVehicle[]>([]);
  const [vehicleEvents, setVehicleEvents] = useState<any[]>([]);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [timeFilter, setTimeFilter]       = useState<TimeFilter>('7d');
  const [lastUpdated, setLastUpdated]     = useState<Date>(new Date());
  const [, setTick]                       = useState(0); // drives "X ago" re-render

  // Re-render the "last updated" text every 30 s
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);

    // Safety net: unblock the spinner after 8 s even if queries stall
    const timeout = setTimeout(() => {
      setLoading(false);
      setRefreshing(false);
    }, 8000);

    try {
      const since30d = new Date();
      since30d.setDate(since30d.getDate() - 30);

      const [vehiclesRes, alertsRes, eventsRes, historyRes] = await Promise.all([
        supabase.from('vehicles').select('*'),
        supabase
          .from('alerts')
          .select('*')
          .eq('acknowledged', false)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('vehicle_events')
          .select('*')
          .eq('acknowledged', false)
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('alerts')
          .select('id, severity, created_at, acknowledged, sensor_type, message, vehicle_id, vehicles(name)')
          .gte('created_at', since30d.toISOString())
          .order('created_at', { ascending: false })
          .limit(300),
      ]);

      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
      if (alertsRes.data)   setAlerts(alertsRes.data);
      if (eventsRes.data)   setVehicleEvents(eventsRes.data);
      if (historyRes.data)  setAllRecent(historyRes.data as AlertWithVehicle[]);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Analytics intelligence pipeline — silent background runner
    const runIntelligence = async () => {
      const base    = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fleet-intelligence`;
      const headers = {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };
      const actions = [
        'detect-trips', 'populate-behavior', 'calculate-scores',
        'predict-fuel',  'predict-costs',     'generate-insights',
        'detect-anomalies', 'detect-gaps',    'score-trip-data',
      ];
      for (const action of actions) {
        try { await fetch(`${base}?action=${action}`, { method: 'POST', headers }); }
        catch { /* silent */ }
      }
    };
    runIntelligence();
    const timer = setInterval(runIntelligence, 5 * 60 * 1_000);
    return () => clearInterval(timer);
  }, [loadData]);

  // ── derived state ───────────────────────────────────────────────────────────

  const activeVehicles  = vehicles.filter(v => v.is_active).length;
  const totalVehicles   = vehicles.length;
  const criticalAlerts  = alerts.filter(a => a.severity === 'critical').length;
  const avgHealthScore  = vehicles.length > 0
    ? vehicles.reduce((s, v) => s + v.health_score, 0) / vehicles.length
    : 0;

  const offlineVehicleIds = new Set(vehicleEvents.filter(e => e.event_type === 'device_offline').map(e => e.vehicle_id));
  const tamperVehicleIds  = new Set(vehicleEvents.filter(e => e.event_type === 'device_tamper').map(e => e.vehicle_id));
  const offlineVehicles   = offlineVehicleIds.size;
  const tamperAlerts      = tamperVehicleIds.size;

  const getVehicleStatus = (id: string) => {
    if (tamperVehicleIds.has(id))  return 'tampered';
    if (offlineVehicleIds.has(id)) return 'offline';
    return 'online';
  };

  // Alerts filtered by the selected time range
  const getFilteredAlerts = (): AlertWithVehicle[] => {
    const days = timeFilter === '1d' ? 1 : timeFilter === '7d' ? 7 : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);
    return allRecentAlerts.filter(
      a => !a.acknowledged && new Date(a.created_at) >= since
    );
  };

  // 7-day alert trend (for mini bar chart)
  const alertTrend = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dayEnd   = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const count = allRecentAlerts.filter(a => {
      const t = new Date(a.created_at);
      return t >= dayStart && t < dayEnd;
    }).length;
    return { label: d.toLocaleDateString('en', { weekday: 'short' }), count };
  });
  const trendMax = Math.max(...alertTrend.map(d => d.count), 1);

  // ── stat cards config ───────────────────────────────────────────────────────

  const alertColor  = criticalAlerts > 0 ? 'text-red-400'    : alerts.length > 0 ? 'text-yellow-400' : 'text-gray-400';
  const alertBg     = criticalAlerts > 0 ? 'bg-red-500/20'   : alerts.length > 0 ? 'bg-yellow-500/20' : 'bg-gray-700/40';
  const alertBorder = criticalAlerts > 0 ? 'border-red-500/60 ring-1 ring-red-500/30' : 'border-gray-800';

  const healthColor = avgHealthScore >= 80 ? 'text-green-400'
                    : avgHealthScore >= 60 ? 'text-yellow-400'
                    : 'text-red-400';

  const filteredAlerts: AlertWithVehicle[] = getFilteredAlerts();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Fleet Overview</h1>
          <p className="text-gray-400">Real-time monitoring and analytics for your entire fleet</p>
        </div>
        <div className="flex items-center gap-3 mt-1">
          {/* Live "last updated" indicator */}
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            Updated {formatLastUpdated(lastUpdated)}
          </div>
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            title="Refresh data"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Time filter ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
        {(['1d', '7d', '30d'] as TimeFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setTimeFilter(f)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              timeFilter === f
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {f === '1d' ? 'Today' : f === '7d' ? '7 days' : '30 days'}
          </button>
        ))}
      </div>

      {/* ── Stat cards ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">

        {/* Total Vehicles */}
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 hover:border-gray-700 transition-colors">
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 rounded-lg bg-blue-500/20">
              <Car className="w-6 h-6 text-blue-400" />
            </div>
          </div>
          <h3 className="text-3xl font-bold text-white mb-1">{totalVehicles}</h3>
          <p className="text-sm text-gray-400">Total Vehicles</p>
          <p className="text-xs text-gray-600 mt-1">Registered in fleet</p>
        </div>

        {/* Active Vehicles */}
        <div
          className="bg-gray-900 rounded-lg p-6 border border-gray-800 hover:border-gray-700 transition-colors"
          title="Vehicles that have connected and transmitted data at least once"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="p-3 rounded-lg bg-green-500/20">
              <Activity className="w-6 h-6 text-green-400" />
            </div>
          </div>
          <h3 className="text-3xl font-bold text-white mb-1">{activeVehicles}</h3>
          <p className="text-sm text-gray-400">Active Vehicles</p>
          <p className="text-xs text-gray-600 mt-1">Currently transmitting</p>
        </div>

        {/* Active Alerts — dynamic colour based on severity */}
        <div className={`bg-gray-900 rounded-lg p-6 border transition-colors ${alertBorder} ${
          criticalAlerts > 0 ? 'bg-red-500/5' : ''
        }`}>
          <div className="flex items-center justify-between mb-4">
            <div className={`p-3 rounded-lg ${alertBg}`}>
              <AlertTriangle className={`w-6 h-6 ${alertColor}`} />
            </div>
            {criticalAlerts > 0 && (
              <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full font-medium animate-pulse">
                {criticalAlerts} critical
              </span>
            )}
          </div>
          <h3 className={`text-3xl font-bold mb-1 ${alerts.length > 0 ? alertColor : 'text-white'}`}>
            {alerts.length}
          </h3>
          <p className="text-sm text-gray-400">Active Alerts</p>
          <p className="text-xs text-gray-600 mt-1">Unacknowledged</p>
        </div>

        {/* Avg Health Score */}
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800 hover:border-gray-700 transition-colors">
          <div className="flex items-center justify-between mb-4">
            <div className={`p-3 rounded-lg ${
              avgHealthScore >= 80 ? 'bg-green-500/20' :
              avgHealthScore >= 60 ? 'bg-yellow-500/20' : 'bg-red-500/20'
            }`}>
              <TrendingUp className={`w-6 h-6 ${healthColor}`} />
            </div>
          </div>
          <h3 className={`text-3xl font-bold mb-1 ${healthColor}`}>
            {avgHealthScore.toFixed(0)}%
          </h3>
          <p className="text-sm text-gray-400">Avg Health Score</p>
          <p className="text-xs text-gray-600 mt-1">Avg across {totalVehicles} vehicle{totalVehicles !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* ── Main panels ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Recent Alerts */}
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-white">Recent Alerts</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {filteredAlerts.length > 0
                  ? `${filteredAlerts.length} unacknowledged`
                  : 'Unacknowledged sensor & threshold alerts'}
              </p>
            </div>
            {/* 7-day mini trend chart */}
            <div className="flex items-end gap-0.5 h-8" title="7-day alert volume">
              {alertTrend.map((day, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5 group relative">
                  <div
                    className={`w-4 rounded-sm transition-all ${
                      day.count > 0 ? 'bg-yellow-500/70 group-hover:bg-yellow-400' : 'bg-gray-700'
                    }`}
                    style={{ height: `${Math.max(4, (day.count / trendMax) * 28)}px` }}
                  />
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:block
                    text-[10px] bg-gray-700 text-gray-200 px-1.5 py-0.5 rounded whitespace-nowrap z-10">
                    {day.label}: {day.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {filteredAlerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="p-3 rounded-full bg-green-500/10 mb-3">
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              </div>
              <p className="text-white font-medium mb-1">All systems normal</p>
              <p className="text-gray-500 text-sm">
                No unacknowledged alerts
                {timeFilter === '1d' ? ' today' : timeFilter === '7d' ? ' in the last 7 days' : ' in the last 30 days'}
              </p>
              <p className="text-gray-600 text-xs mt-2">
                Last checked: {formatLastUpdated(lastUpdated)}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredAlerts.slice(0, 5).map((alert) => {
                const isCtitical = alert.severity === 'critical';
                const isWarning  = alert.severity === 'warning';
                const borderColor = isCtitical ? 'border-l-red-500'    : isWarning ? 'border-l-yellow-500'    : 'border-l-blue-500';
                const bgColor     = isCtitical ? 'bg-red-500/10'       : isWarning ? 'bg-yellow-500/10'       : 'bg-blue-500/10';
                const badgeCls    = isCtitical ? 'bg-red-500/20 text-red-400'  : isWarning ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400';
                const Icon        = isCtitical ? AlertTriangle : isWarning ? AlertTriangle : Info;
                const iconCls     = isCtitical ? 'text-red-400' : isWarning ? 'text-yellow-400' : 'text-blue-400';

                // Format sensor_type from snake_case to Title Case
                const sensorLabel = (alert.sensor_type ?? 'Unknown Sensor')
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, c => c.toUpperCase());

                const vehicleName = (alert.vehicles as { name?: string } | null)?.name;

                return (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border border-gray-700/40 border-l-4 ${borderColor} ${bgColor} hover:brightness-110 transition-all cursor-default`}
                  >
                    {/* Severity icon */}
                    <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconCls}`} />

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-white font-semibold text-sm">{sensorLabel}</p>
                        {vehicleName && (
                          <span className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded">
                            {vehicleName}
                          </span>
                        )}
                      </div>
                      {alert.message && (
                        <p className="text-gray-400 text-xs mt-0.5 line-clamp-1">{alert.message}</p>
                      )}
                    </div>

                    {/* Right: severity badge + time */}
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded capitalize ${badgeCls}`}>
                        {alert.severity}
                      </span>
                      <span className="text-xs text-gray-600 flex items-center gap-0.5">
                        <Clock className="w-3 h-3" />
                        {formatRelativeTime(alert.created_at)}
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* View all button */}
              <button
                onClick={() => onNavigate('alerts')}
                className="w-full flex items-center justify-center gap-1.5 mt-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/5 py-2 rounded-lg transition-all border border-transparent hover:border-blue-500/20"
              >
                {filteredAlerts.length > 5
                  ? `+${filteredAlerts.length - 5} more · View all alerts`
                  : 'View all alerts'}
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Fleet Status */}
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Fleet Status</h2>
            <span className="text-xs text-gray-500">{vehicles.length} vehicle{vehicles.length !== 1 ? 's' : ''}</span>
          </div>

          {(offlineVehicles > 0 || tamperAlerts > 0) && (
            <div className="flex gap-3 mb-4 flex-wrap">
              {offlineVehicles > 0 && (
                <div className="flex items-center gap-1.5 text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded-full border border-red-500/30">
                  <WifiOff className="w-3 h-3 text-red-400" />
                  {offlineVehicles} offline
                </div>
              )}
              {tamperAlerts > 0 && (
                <div className="flex items-center gap-1.5 text-xs bg-gray-800 text-gray-300 px-2 py-1 rounded-full border border-yellow-500/30">
                  <Shield className="w-3 h-3 text-yellow-400" />
                  {tamperAlerts} tamper alert{tamperAlerts !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            {vehicles.slice(0, 5).map((vehicle) => {
              const status = getVehicleStatus(vehicle.id);
              return (
                <div
                  key={vehicle.id}
                  className="flex items-center justify-between p-3 bg-gray-800 rounded-lg border border-gray-700/50 hover:border-gray-600 transition-colors"
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    {status === 'online' && vehicle.is_active
                      ? <Wifi    className="w-4 h-4 text-green-500 flex-shrink-0" />
                      : status === 'offline'
                      ? <WifiOff className="w-4 h-4 text-red-500  flex-shrink-0" />
                      : status === 'tampered'
                      ? <Shield  className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                      : <div className="w-3 h-3 rounded-full bg-gray-600 flex-shrink-0 ml-0.5" />
                    }
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium text-sm truncate">{vehicle.name}</p>
                        {status === 'tampered' && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 flex-shrink-0">Tampered</span>
                        )}
                        {status === 'offline' && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 flex-shrink-0">Offline</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className="text-gray-400 text-xs">{vehicle.make} {vehicle.model}</p>
                        {vehicle.driver_email && (
                          <>
                            <span className="text-gray-700">·</span>
                            <p className="text-gray-500 text-xs truncate">{vehicle.driver_email}</p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className={`text-sm font-bold ${
                      vehicle.health_score >= 80 ? 'text-green-500'
                      : vehicle.health_score >= 60 ? 'text-yellow-500'
                      : 'text-red-500'
                    }`}>
                      {vehicle.health_score.toFixed(0)}%
                    </p>
                    <div className="flex items-center gap-1 justify-end mt-0.5">
                      <Clock className="w-3 h-3 text-gray-600" />
                      <p className="text-xs text-gray-500">{formatRelativeTime(vehicle.last_connected)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
            {vehicles.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <div className="p-3 rounded-full bg-gray-800 mb-3">
                  <Car className="w-7 h-7 text-gray-600" />
                </div>
                <p className="text-gray-400 text-sm">No vehicles registered yet</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Critical alert banner ───────────────────────────────────────────── */}
      {criticalAlerts > 0 && (
        <div className="bg-red-500/10 border-2 border-red-500 rounded-lg p-5 flex items-center justify-between">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-bold text-white mb-0.5">
                {criticalAlerts} Critical Alert{criticalAlerts !== 1 ? 's' : ''} Require Attention
              </h3>
              <p className="text-gray-300 text-sm">
                Please review and acknowledge the alerts to keep your fleet safe.
              </p>
            </div>
          </div>
          <button
            onClick={() => onNavigate('alerts')}
            className="flex items-center gap-1.5 px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0 ml-4"
          >
            View Alerts <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Quick actions ───────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">Quick Actions</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <button
            onClick={() => onNavigate('vehicles')}
            className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 hover:border-blue-500/50 hover:bg-blue-500/5 rounded-lg text-left transition-all group"
          >
            <div className="p-2 rounded-lg bg-blue-500/20 group-hover:bg-blue-500/30 transition-colors">
              <PlusCircle className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-white text-sm font-medium">Add Vehicle</p>
              <p className="text-gray-500 text-xs">Register or invite a driver</p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-600 ml-auto group-hover:text-gray-400 transition-colors" />
          </button>

          <button
            onClick={() => onNavigate('alerts')}
            className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 hover:border-yellow-500/50 hover:bg-yellow-500/5 rounded-lg text-left transition-all group"
          >
            <div className="p-2 rounded-lg bg-yellow-500/20 group-hover:bg-yellow-500/30 transition-colors">
              <Bell className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <p className="text-white text-sm font-medium">View Alerts</p>
              <p className="text-gray-500 text-xs">{alerts.length} unacknowledged</p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-600 ml-auto group-hover:text-gray-400 transition-colors" />
          </button>

          <button
            onClick={() => onNavigate('map')}
            className="flex items-center gap-3 p-4 bg-gray-900 border border-gray-800 hover:border-teal-500/50 hover:bg-teal-500/5 rounded-lg text-left transition-all group"
          >
            <div className="p-2 rounded-lg bg-teal-500/20 group-hover:bg-teal-500/30 transition-colors">
              <Map className="w-5 h-5 text-teal-400" />
            </div>
            <div>
              <p className="text-white text-sm font-medium">Fleet Map</p>
              <p className="text-gray-500 text-xs">Live vehicle positions</p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-600 ml-auto group-hover:text-gray-400 transition-colors" />
          </button>
        </div>
      </div>
    </div>
  );
}
