import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase, type Vehicle, type Trip } from '../lib/supabase';
import {
  Navigation, Radio, Clock, Fuel, Gauge, Play, Pause,
  SkipBack, ChevronDown, AlertCircle, Loader, MapPin, Car,
} from 'lucide-react';

// ── Fix Leaflet default marker icons broken by Vite asset pipeline ─────────
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl:       'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl:     'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// ── Constants ──────────────────────────────────────────────────────────────
/** Split route into a new segment when consecutive GPS points are >5 min apart */
const GAP_MS           = 5 * 60 * 1000;
/** Max points rendered on the map — downsample if the query returns more */
const MAX_DISPLAY_PTS  = 2_000;
/** Hard DB row cap — warn the user if the range is wider than this */
const ROW_CAP          = 10_000;
/** Route colours for segments (cycles if >6 segments) */
const SEG_COLORS       = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];
/** Mark a live position as stale after 5 min without an update */
const STALE_MS         = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────
interface VehicleLog {
  id:             string;
  vehicle_id:     string;
  latitude:       number | null;
  longitude:      number | null;
  speed:          number;
  ignition_status: boolean;
  timestamp:      string;
}

interface LivePosition {
  vehicleId:  string;
  lat:        number;
  lng:        number;
  speed:      number;
  ignition:   boolean;
  timestamp:  string;
}

interface GeofenceZone {
  id:             string;
  name:           string;
  shape:          'circle' | 'polygon';
  zone_type:      string;
  color:          string;
  center_lat:     number | null;
  center_lng:     number | null;
  radius_metres:  number | null;
  coordinates:    [number, number][] | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Split a flat ordered array of logs into segments separated by large time gaps */
function segmentRoute(points: VehicleLog[]): VehicleLog[][] {
  if (points.length === 0) return [];
  const segments: VehicleLog[][] = [];
  let current: VehicleLog[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const gap =
      new Date(points[i].timestamp).getTime() -
      new Date(points[i - 1].timestamp).getTime();
    if (gap > GAP_MS) {
      if (current.length >= 2) segments.push(current);
      current = [points[i]];
    } else {
      current.push(points[i]);
    }
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}

/** Downsample array to ≤ maxPts by taking every Nth element */
function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = Math.ceil(arr.length / maxPts);
  return arr.filter((_, i) => i % step === 0);
}

/** Haversine distance (km) between consecutive points in an ordered array */
function calcDistanceKm(points: VehicleLog[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.latitude == null || b.latitude == null) continue;
    const R    = 6371;
    const dLat = ((b.latitude  - a.latitude!)  * Math.PI) / 180;
    const dLng = ((b.longitude! - a.longitude!) * Math.PI) / 180;
    const x    =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.latitude  * Math.PI) / 180) *
      Math.cos((b.latitude  * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(Math.min(1, x)));
  }
  return total;
}

// ── Custom Leaflet icons ───────────────────────────────────────────────────

function vehicleIcon(live: boolean, selected: boolean) {
  const color = selected ? '#f59e0b' : live ? '#3b82f6' : '#6b7280';
  const pulse = live ? `box-shadow:0 0 0 5px ${color}33;` : '';
  return L.divIcon({
    html: `<div style="
      width:14px;height:14px;border-radius:50%;
      background:${color};border:2px solid white;${pulse}
    "></div>`,
    className:  '',
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
    popupAnchor:[0, -10],
  });
}

function playbackIcon() {
  return L.divIcon({
    html: `<div style="
      width:18px;height:18px;border-radius:50%;
      background:#f59e0b;border:2.5px solid white;
      box-shadow:0 0 0 5px #f59e0b44;
    "></div>`,
    className:  '',
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
  });
}

function startIcon() {
  return L.divIcon({
    html: `<div style="width:12px;height:12px;border-radius:50%;background:#10b981;border:2px solid white;"></div>`,
    className: '', iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

function endIcon() {
  return L.divIcon({
    html: `<div style="width:12px;height:12px;border-radius:50%;background:#ef4444;border:2px solid white;"></div>`,
    className: '', iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

// ── FitBounds: adjusts map view when data changes ─────────────────────────
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map          = useMap();
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (positions.length === 0) return;
    // Re-fit only on first load or when a new route is loaded (count changes by >10)
    const changed = Math.abs(positions.length - prevCountRef.current) > 10 || prevCountRef.current === 0;
    if (changed) {
      try {
        if (positions.length === 1) {
          map.setView(positions[0], 14);
        } else {
          map.fitBounds(positions as L.LatLngBoundsExpression, { padding: [50, 50] });
        }
      } catch { /* ignore if map is unmounted */ }
    }
    prevCountRef.current = positions.length;
  }, [positions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FleetMapPage
// ═══════════════════════════════════════════════════════════════════════════
export default function FleetMapPage() {
  // ── Shared state ────────────────────────────────────────────────────────
  const [vehicles,        setVehicles]        = useState<Vehicle[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [mode,            setMode]            = useState<'live' | 'history'>('live');

  // ── Live-mode state ─────────────────────────────────────────────────────
  const [livePositions,   setLivePositions]   = useState<Map<string, LivePosition>>(new Map());
  const [vehicleFuel,     setVehicleFuel]     = useState<Map<string, number | null>>(new Map());
  const [selectedVid,     setSelectedVid]     = useState<string | null>(null);
  const [kmSinceStop,     setKmSinceStop]     = useState<number | null>(null);

  // ── Zone overlay state ──────────────────────────────────────────────────
  const [showZones,       setShowZones]       = useState(false);
  const [zones,           setZones]           = useState<GeofenceZone[]>([]);

  // ── History-mode state ──────────────────────────────────────────────────
  const [histVid,         setHistVid]         = useState('');
  const [histMode,        setHistMode]        = useState<'range' | 'trip'>('range');
  const [histStart,       setHistStart]       = useState('');
  const [histEnd,         setHistEnd]         = useState('');
  const [trips,           setTrips]           = useState<Trip[]>([]);
  const [selectedTripId,  setSelectedTripId]  = useState('');
  const [histLoading,     setHistLoading]     = useState(false);
  const [histTruncated,   setHistTruncated]   = useState(false);
  const [routeSegments,   setRouteSegments]   = useState<VehicleLog[][]>([]);
  const [routePoints,     setRoutePoints]     = useState<VehicleLog[]>([]);

  // ── Playback state ──────────────────────────────────────────────────────
  const [pbActive,        setPbActive]        = useState(false);
  const [pbIndex,         setPbIndex]         = useState(0);
  const [pbSpeed,         setPbSpeed]         = useState(5);
  const [pbPos,           setPbPos]           = useState<VehicleLog | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const vehicleIds   = useRef<Set<string>>(new Set());
  const realtimeRef  = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const pbIndexRef   = useRef(0);   // always-current index used inside setInterval closure

  // ── Load vehicles + initial positions ────────────────────────────────────
  useEffect(() => {
    initMap();
    return () => {
      if (realtimeRef.current) supabase.removeChannel(realtimeRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function initMap() {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: fleet } = await supabase
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id)
        .single();
      if (!fleet) return;

      const { data: vData } = await supabase
        .from('vehicles')
        .select('*')
        .eq('fleet_id', fleet.id)
        .eq('is_active', true);
      if (!vData?.length) return;

      setVehicles(vData);
      const ids = vData.map(v => v.id);
      vehicleIds.current = new Set(ids);

      // Latest GPS position per vehicle (parallel)
      const posMap = new Map<string, LivePosition>();
      await Promise.all(ids.map(async id => {
        const { data } = await supabase
          .from('vehicle_logs')
          .select('vehicle_id, latitude, longitude, speed, ignition_status, timestamp')
          .eq('vehicle_id', id)
          .not('latitude', 'is', null)
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (data?.latitude != null && data?.longitude != null) {
          posMap.set(id, {
            vehicleId: id,
            lat:       Number(data.latitude),
            lng:       Number(data.longitude),
            speed:     Number(data.speed),
            ignition:  data.ignition_status,
            timestamp: data.timestamp,
          });
        }
      }));
      setLivePositions(new Map(posMap));

      // Latest fuel level per vehicle (parallel)
      const fuelMap = new Map<string, number | null>();
      await Promise.all(ids.map(async id => {
        const { data } = await supabase
          .from('sensor_data')
          .select('value')
          .eq('vehicle_id', id)
          .eq('sensor_type', 'fuel_level')
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();
        fuelMap.set(id, data?.value != null ? Number(data.value) : null);
      }));
      setVehicleFuel(new Map(fuelMap));

      // Load active geofence zones for this fleet
      const { data: zoneData } = await supabase
        .from('geofences')
        .select('id, name, shape, zone_type, color, center_lat, center_lng, radius_metres, coordinates')
        .eq('fleet_id', fleet.id)
        .eq('is_active', true);
      if (zoneData) setZones(zoneData as GeofenceZone[]);

      // Subscribe for live updates
      subscribeRealtime();
    } finally {
      setLoading(false);
    }
  }

  function subscribeRealtime() {
    const ch = supabase
      .channel('fleet-map-logs')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vehicle_logs' },
        (payload) => {
          const row = payload.new as VehicleLog;
          if (!vehicleIds.current.has(row.vehicle_id)) return;
          if (row.latitude == null || row.longitude == null)  return;
          setLivePositions(prev => {
            const next = new Map(prev);
            next.set(row.vehicle_id, {
              vehicleId: row.vehicle_id,
              lat:       Number(row.latitude),
              lng:       Number(row.longitude),
              speed:     Number(row.speed),
              ignition:  row.ignition_status,
              timestamp: row.timestamp,
            });
            return next;
          });
          // Refresh fuel on sensor_data insert — handled separately via polling is fine;
          // Realtime on sensor_data would need a second channel — keep it simple.
        }
      )
      .subscribe();
    realtimeRef.current = ch;
  }

  // ── km since last stop (live mode popup detail) ───────────────────────────
  useEffect(() => {
    if (!selectedVid || mode !== 'live') { setKmSinceStop(null); return; }
    computeKmSinceStop(selectedVid);
  }, [selectedVid, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function computeKmSinceStop(vehicleId: string) {
    setKmSinceStop(null);
    const { data } = await supabase
      .from('vehicle_logs')
      .select('latitude, longitude, speed, timestamp')
      .eq('vehicle_id', vehicleId)
      .not('latitude', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(200);
    if (!data?.length) return;

    // Walk backwards through points; collect the consecutive moving block
    const moving: VehicleLog[] = [];
    for (let i = 0; i < data.length; i++) {
      if (Number(data[i].speed) === 0) break;
      if (i > 0) {
        const gapMs =
          new Date(data[i - 1].timestamp).getTime() -
          new Date(data[i].timestamp).getTime();
        if (gapMs > GAP_MS) break;
      }
      moving.unshift(data[i] as VehicleLog);
    }
    setKmSinceStop(moving.length >= 2 ? calcDistanceKm(moving) : 0);
  }

  // ── Load trips for history vehicle ───────────────────────────────────────
  useEffect(() => {
    if (!histVid || histMode !== 'trip') { setTrips([]); return; }
    supabase
      .from('trips')
      .select('id, start_time, end_time, distance_km, avg_speed_kmh, status')
      .eq('vehicle_id', histVid)
      .eq('status', 'completed')
      .order('start_time', { ascending: false })
      .limit(50)
      .then(({ data }) => setTrips((data as Trip[]) ?? []));
  }, [histVid, histMode]);

  // ── Load history route ────────────────────────────────────────────────────
  async function loadHistory() {
    if (!histVid) return;
    stopPlayback();
    setHistLoading(true);
    setRouteSegments([]);
    setRoutePoints([]);
    setHistTruncated(false);
    setPbPos(null);
    setPbIndex(0);
    pbIndexRef.current = 0;

    let startIso: string;
    let endIso:   string;

    if (histMode === 'trip' && selectedTripId) {
      const trip = trips.find(t => t.id === selectedTripId);
      if (!trip) { setHistLoading(false); return; }
      startIso = trip.start_time;
      endIso   = trip.end_time ?? new Date().toISOString();
    } else {
      if (!histStart || !histEnd) { setHistLoading(false); return; }
      startIso = new Date(histStart).toISOString();
      endIso   = new Date(`${histEnd}T23:59:59`).toISOString();
    }

    const { data } = await supabase
      .from('vehicle_logs')
      .select('id, vehicle_id, latitude, longitude, speed, ignition_status, timestamp')
      .eq('vehicle_id', histVid)
      .not('latitude', 'is', null)
      .gte('timestamp', startIso)
      .lte('timestamp', endIso)
      .order('timestamp', { ascending: true })
      .limit(ROW_CAP + 1);   // +1 to detect truncation

    setHistLoading(false);
    if (!data?.length) return;

    let pts = data as VehicleLog[];
    if (pts.length > ROW_CAP) {
      pts = pts.slice(0, ROW_CAP);
      setHistTruncated(true);
    }

    // Downsample for display performance, then segment
    const displayed = downsample(pts, MAX_DISPLAY_PTS);
    const segments  = segmentRoute(displayed);

    setRoutePoints(displayed);
    setRouteSegments(segments);
    setPbPos(displayed[0] ?? null);
    setPbIndex(0);
    pbIndexRef.current = 0;
    setPbActive(false);
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setPbActive(false);
  }, []);

  const togglePlayback = useCallback(() => {
    if (pbActive) { stopPlayback(); return; }
    if (routePoints.length === 0) return;

    // Restart from beginning if at the last point
    if (pbIndexRef.current >= routePoints.length - 1) {
      pbIndexRef.current = 0;
      setPbIndex(0);
      setPbPos(routePoints[0]);
    }

    const intervalMs = Math.max(40, 500 / pbSpeed);
    const pts = routePoints; // stable reference captured at start

    intervalRef.current = setInterval(() => {
      pbIndexRef.current++;
      if (pbIndexRef.current >= pts.length) {
        clearInterval(intervalRef.current!);
        intervalRef.current = null;
        setPbActive(false);
        return;
      }
      setPbIndex(pbIndexRef.current);
      setPbPos(pts[pbIndexRef.current]);
    }, intervalMs);

    setPbActive(true);
  }, [pbActive, pbSpeed, routePoints, stopPlayback]);

  const resetPlayback = useCallback(() => {
    stopPlayback();
    pbIndexRef.current = 0;
    setPbIndex(0);
    setPbPos(routePoints[0] ?? null);
  }, [routePoints, stopPlayback]);

  // Stop playback when speed changes so user can re-press Play with new speed
  useEffect(() => { stopPlayback(); }, [pbSpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived values ────────────────────────────────────────────────────────
  const selectedVehicle = vehicles.find(v => v.id === selectedVid);

  const allLiveLatLngs = Array.from(livePositions.values())
    .map(p => [p.lat, p.lng] as [number, number]);

  const allRouteLatLngs = routePoints
    .filter(p => p.latitude != null && p.longitude != null)
    .map(p => [Number(p.latitude), Number(p.longitude)] as [number, number]);

  const routeTotalKm = routeSegments.reduce((s, seg) => s + calcDistanceKm(seg), 0);
  const routeAvgSpeed =
    routePoints.length > 0
      ? routePoints.reduce((s, p) => s + p.speed, 0) / routePoints.length
      : 0;

  function isStale(ts: string) { return Date.now() - new Date(ts).getTime() > STALE_MS; }

  // ── Loading screen ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="space-y-4">

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1">Fleet Map</h1>
          <p className="text-gray-400 text-sm">
            Live vehicle positions · historical route playback
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Zone overlay toggle */}
          <button
            onClick={() => setShowZones(prev => !prev)}
            title={showZones ? 'Hide geofence zones' : 'Show geofence zones on map'}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
              showZones
                ? 'bg-green-600/20 text-green-400 border-green-600/40'
                : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            Zones
            {zones.length > 0 && (
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-bold ${
                showZones ? 'bg-green-500/30 text-green-300' : 'bg-gray-700 text-gray-400'
              }`}>
                {zones.length}
              </span>
            )}
          </button>

          {/* Live / History toggle */}
          <div className="flex bg-gray-800 rounded-xl p-1 border border-gray-700">
            {(['live', 'history'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); if (m === 'live') stopPlayback(); }}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                  mode === m
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {m === 'live' ? <><Radio className="w-3.5 h-3.5" /> Live</> : <><Clock className="w-3.5 h-3.5" /> History</>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Two-panel layout ─────────────────────────────────────────────── */}
      <div className="flex gap-4" style={{ height: 'calc(100vh - 250px)', minHeight: 520 }}>

        {/* ── Left panel ─────────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">

          {/* ─────────── LIVE PANEL ─────────── */}
          {mode === 'live' && (
            <>
              <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
                  {vehicles.length} Vehicle{vehicles.length !== 1 ? 's' : ''}
                </p>
                <span className="flex items-center gap-1.5 text-[10px] text-green-400 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                  Realtime
                </span>
              </div>

              {vehicles.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-6 text-center">
                  <div>
                    <Car className="w-10 h-10 text-gray-700 mx-auto mb-3" />
                    <p className="text-gray-500 text-sm">No active vehicles</p>
                    <p className="text-gray-600 text-xs mt-1">Add vehicles from the Vehicles page</p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto divide-y divide-gray-800/60">
                  {vehicles.map(v => {
                    const pos      = livePositions.get(v.id);
                    const fuel     = vehicleFuel.get(v.id);
                    const online   = pos && !isStale(pos.timestamp);
                    const selected = selectedVid === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => setSelectedVid(selected ? null : v.id)}
                        className={`w-full px-4 py-3 text-left transition-colors ${
                          selected
                            ? 'bg-blue-900/30 border-l-2 border-l-blue-500'
                            : 'hover:bg-gray-800/50'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <p className="text-white text-sm font-medium truncate pr-2">{v.name}</p>
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                            online
                              ? 'bg-green-500/20 text-green-400'
                              : pos
                                ? 'bg-gray-700 text-gray-500'
                                : 'bg-gray-800 text-gray-600'
                          }`}>
                            {online ? 'LIVE' : pos ? 'OFFLINE' : 'NO DATA'}
                          </span>
                        </div>
                        <p className="text-gray-500 text-xs mb-1">{v.make} {v.model}</p>
                        {pos ? (
                          <div className="flex gap-3">
                            <span className="flex items-center gap-1 text-xs text-gray-400">
                              <Gauge className="w-3 h-3" /> {Number(pos.speed).toFixed(0)} km/h
                            </span>
                            {fuel != null && (
                              <span className="flex items-center gap-1 text-xs text-gray-400">
                                <Fuel className="w-3 h-3" /> {fuel.toFixed(0)}%
                              </span>
                            )}
                          </div>
                        ) : (
                          <p className="text-gray-600 text-xs italic">No GPS data yet</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Selected vehicle detail card */}
              {selectedVehicle && livePositions.get(selectedVid!) && (
                <div className="border-t border-gray-800 p-4 bg-gray-800/30 space-y-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
                    {selectedVehicle.name}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-800 rounded-lg p-2.5">
                      <p className="text-[10px] text-gray-500 mb-0.5">Current Speed</p>
                      <p className="text-white text-sm font-bold">
                        {Number(livePositions.get(selectedVid!)!.speed).toFixed(0)}
                        <span className="text-gray-500 text-xs ml-0.5">km/h</span>
                      </p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-2.5">
                      <p className="text-[10px] text-gray-500 mb-0.5">Fuel Level</p>
                      <p className="text-white text-sm font-bold">
                        {vehicleFuel.get(selectedVid!) != null
                          ? <>{vehicleFuel.get(selectedVid!)!.toFixed(0)}<span className="text-gray-500 text-xs ml-0.5">%</span></>
                          : <span className="text-gray-600 text-xs">N/A</span>}
                      </p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-2.5 col-span-2">
                      <p className="text-[10px] text-gray-500 mb-0.5">km Since Last Stop</p>
                      <p className="text-white text-sm font-bold">
                        {kmSinceStop == null
                          ? <span className="text-gray-500 text-xs">Calculating…</span>
                          : kmSinceStop === 0
                            ? <span className="text-gray-500 text-xs">Currently stopped</span>
                            : <>~{kmSinceStop.toFixed(1)}<span className="text-gray-500 text-xs ml-0.5">km</span></>}
                      </p>
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-600 text-center">
                    Updated {new Date(livePositions.get(selectedVid!)!.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              )}
            </>
          )}

          {/* ─────────── HISTORY PANEL ─────────── */}
          {mode === 'history' && (
            <>
              <div className="px-4 py-3 border-b border-gray-800">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Route History</p>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">

                {/* Vehicle selector */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-gray-400">Vehicle</label>
                  <div className="relative">
                    <select
                      value={histVid}
                      onChange={e => {
                        setHistVid(e.target.value);
                        setRouteSegments([]);
                        setRoutePoints([]);
                        setSelectedTripId('');
                        stopPlayback();
                      }}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm appearance-none focus:outline-none focus:border-blue-500"
                    >
                      <option value="">Select vehicle…</option>
                      {vehicles.map(v => (
                        <option key={v.id} value={v.id}>{v.name} — {v.make} {v.model}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                  </div>
                </div>

                {/* Range / Trip toggle */}
                <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                  {(['range', 'trip'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setHistMode(m)}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        histMode === m ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {m === 'range' ? 'Date Range' : 'By Trip'}
                    </button>
                  ))}
                </div>

                {/* Date range inputs */}
                {histMode === 'range' && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-gray-400">From</label>
                      <input
                        type="date"
                        value={histStart}
                        onChange={e => setHistStart(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-gray-400">To</label>
                      <input
                        type="date"
                        value={histEnd}
                        onChange={e => setHistEnd(e.target.value)}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </>
                )}

                {/* Trip selector */}
                {histMode === 'trip' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-gray-400">Trip</label>
                    {!histVid ? (
                      <p className="text-gray-600 text-xs italic">Select a vehicle first</p>
                    ) : trips.length === 0 ? (
                      <p className="text-gray-600 text-xs italic">No completed trips found</p>
                    ) : (
                      <div className="relative">
                        <select
                          value={selectedTripId}
                          onChange={e => setSelectedTripId(e.target.value)}
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm appearance-none focus:outline-none focus:border-blue-500"
                        >
                          <option value="">Select trip…</option>
                          {trips.map(t => (
                            <option key={t.id} value={t.id}>
                              {new Date(t.start_time).toLocaleDateString()} · {t.distance_km.toFixed(1)} km
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                      </div>
                    )}
                  </div>
                )}

                {/* Truncation warning */}
                {histTruncated && (
                  <div className="flex items-start gap-2 bg-yellow-900/30 border border-yellow-700/40 rounded-lg px-3 py-2.5">
                    <AlertCircle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-yellow-300">
                      Capped at {ROW_CAP.toLocaleString()} GPS points.
                      Narrow the date range for full detail.
                    </p>
                  </div>
                )}

                {/* Load Route button */}
                <button
                  onClick={loadHistory}
                  disabled={histLoading || !histVid}
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                >
                  {histLoading
                    ? <><Loader className="w-4 h-4 animate-spin" /> Loading…</>
                    : <><Navigation className="w-4 h-4" /> Load Route</>}
                </button>

                {/* Route summary */}
                {routePoints.length > 0 && (
                  <div className="bg-gray-800 rounded-xl p-3 space-y-2">
                    <p className="text-xs font-semibold text-gray-400 mb-2">Route Summary</p>
                    {[
                      { label: 'GPS Points',      value: routePoints.length.toLocaleString() },
                      { label: 'Segments',         value: String(routeSegments.length) },
                      { label: 'Distance (approx)',value: `${routeTotalKm.toFixed(1)} km` },
                      { label: 'Avg Speed',        value: `${routeAvgSpeed.toFixed(0)} km/h` },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between text-xs">
                        <span className="text-gray-500">{row.label}</span>
                        <span className="text-white font-medium">{row.value}</span>
                      </div>
                    ))}
                    {routeSegments.length > 1 && (
                      <p className="text-[10px] text-gray-600 mt-1 pt-1 border-t border-gray-700">
                        Route split into {routeSegments.length} segments at gaps &gt;5 min
                      </p>
                    )}
                  </div>
                )}

                {/* Playback controls */}
                {routePoints.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-gray-400">Playback</p>

                    {/* Speed selector */}
                    <div className="flex gap-1.5">
                      {[1, 5, 10, 20].map(s => (
                        <button
                          key={s}
                          onClick={() => setPbSpeed(s)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                            pbSpeed === s
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-700 text-gray-400 hover:text-white'
                          }`}
                        >
                          {s}×
                        </button>
                      ))}
                    </div>

                    {/* Scrub bar */}
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, routePoints.length - 1)}
                      value={pbIndex}
                      onChange={e => {
                        const idx = Number(e.target.value);
                        pbIndexRef.current = idx;
                        setPbIndex(idx);
                        setPbPos(routePoints[idx]);
                      }}
                      className="w-full accent-blue-500"
                    />

                    {/* Play/pause + reset */}
                    <div className="flex gap-2">
                      <button
                        onClick={resetPlayback}
                        className="flex-shrink-0 p-2.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                        title="Reset to start"
                      >
                        <SkipBack className="w-4 h-4" />
                      </button>
                      <button
                        onClick={togglePlayback}
                        className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        {pbActive
                          ? <><Pause className="w-4 h-4" /> Pause</>
                          : <><Play  className="w-4 h-4" /> Play</>}
                      </button>
                    </div>

                    {/* Current playback timestamp */}
                    {pbPos && (
                      <div className="bg-gray-800/60 rounded-lg px-3 py-2 text-center space-y-0.5">
                        <p className="text-[11px] text-gray-300">
                          {new Date(pbPos.timestamp).toLocaleString()}
                        </p>
                        <p className="text-[11px] text-gray-500">
                          {Number(pbPos.speed).toFixed(0)} km/h ·{' '}
                          {pbPos.ignition_status ? 'Ignition ON' : 'Ignition OFF'}
                        </p>
                        <p className="text-[10px] text-gray-600">
                          {pbIndex + 1} / {routePoints.length}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Map panel ──────────────────────────────────────────────────── */}
        <div className="flex-1 rounded-xl overflow-hidden border border-gray-800 relative">
          {vehicles.length === 0 ? (
            <div className="h-full flex items-center justify-center bg-gray-900">
              <div className="text-center">
                <MapPin className="w-16 h-16 text-gray-700 mx-auto mb-4" />
                <p className="text-gray-400 text-lg">No vehicles in your fleet</p>
                <p className="text-gray-600 text-sm mt-1">Add vehicles from the Vehicles page to see them on the map</p>
              </div>
            </div>
          ) : (
            <MapContainer
              center={[20.5937, 78.9629]}
              zoom={5}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />

              {/* ─── LIVE: vehicle markers ─── */}
              {mode === 'live' && Array.from(livePositions.values()).map(pos => {
                const v        = vehicles.find(x => x.id === pos.vehicleId);
                if (!v) return null;
                const online   = !isStale(pos.timestamp);
                const selected = selectedVid === pos.vehicleId;
                const fuel     = vehicleFuel.get(pos.vehicleId);
                return (
                  <Marker
                    key={pos.vehicleId}
                    position={[pos.lat, pos.lng]}
                    icon={vehicleIcon(online, selected)}
                    eventHandlers={{ click: () => setSelectedVid(pos.vehicleId) }}
                  >
                    <Popup>
                      <div className="min-w-[170px] space-y-1">
                        <p className="font-bold text-gray-900 text-sm">{v.name}</p>
                        <p className="text-gray-500 text-xs">{v.make} {v.model} · {v.year}</p>
                        <hr className="my-1.5 border-gray-200" />
                        <p className="text-sm">Speed: <b>{Number(pos.speed).toFixed(0)} km/h</b></p>
                        {fuel != null && (
                          <p className="text-sm">Fuel: <b>{fuel.toFixed(0)}%</b></p>
                        )}
                        {kmSinceStop != null && selected && (
                          <p className="text-sm">Since stop: <b>~{kmSinceStop.toFixed(1)} km</b></p>
                        )}
                        <p className="text-xs text-gray-400 pt-1">
                          {online ? '🟢 Live · ' : '⚫ Offline · Last seen '}
                          {new Date(pos.timestamp).toLocaleTimeString()}
                        </p>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}

              {/* LIVE: fit all vehicles on first load */}
              {mode === 'live' && allLiveLatLngs.length > 0 && (
                <FitBounds positions={allLiveLatLngs} />
              )}

              {/* ─── HISTORY: route polylines ─── */}
              {mode === 'history' && routeSegments.map((seg, i) => {
                const pts = seg
                  .filter(p => p.latitude != null && p.longitude != null)
                  .map(p => [Number(p.latitude), Number(p.longitude)] as [number, number]);
                return (
                  <Polyline
                    key={i}
                    positions={pts}
                    color={SEG_COLORS[i % SEG_COLORS.length]}
                    weight={3.5}
                    opacity={0.85}
                  />
                );
              })}

              {/* HISTORY: start and end markers */}
              {mode === 'history' && routePoints.length > 0 && (() => {
                const first = routePoints.find(p => p.latitude != null);
                const last  = [...routePoints].reverse().find(p => p.latitude != null);
                return (
                  <>
                    {first && (
                      <Marker
                        position={[Number(first.latitude), Number(first.longitude)]}
                        icon={startIcon()}
                      >
                        <Popup>
                          <p className="font-semibold text-sm">Route Start</p>
                          <p className="text-gray-500 text-xs">{new Date(first.timestamp).toLocaleString()}</p>
                        </Popup>
                      </Marker>
                    )}
                    {last && last.id !== first?.id && (
                      <Marker
                        position={[Number(last.latitude), Number(last.longitude)]}
                        icon={endIcon()}
                      >
                        <Popup>
                          <p className="font-semibold text-sm">Route End</p>
                          <p className="text-gray-500 text-xs">{new Date(last.timestamp).toLocaleString()}</p>
                        </Popup>
                      </Marker>
                    )}
                  </>
                );
              })()}

              {/* HISTORY: animated playback marker */}
              {mode === 'history' && pbPos?.latitude != null && (
                <Marker
                  position={[Number(pbPos.latitude), Number(pbPos.longitude)]}
                  icon={playbackIcon()}
                >
                  <Popup>
                    <p className="text-sm font-semibold">{new Date(pbPos.timestamp).toLocaleString()}</p>
                    <p className="text-sm text-gray-600">{Number(pbPos.speed).toFixed(0)} km/h</p>
                  </Popup>
                </Marker>
              )}

              {/* HISTORY: fit bounds when route loads */}
              {mode === 'history' && allRouteLatLngs.length > 0 && (
                <FitBounds positions={allRouteLatLngs} />
              )}

              {/* ─── Zone overlays (both modes) ─── */}
              {showZones && zones.map(zone => {
                const opts = {
                  color:       zone.color,
                  fillColor:   zone.color,
                  fillOpacity: 0.12,
                  weight:      2,
                  dashArray:   '6 4',
                };
                if (zone.shape === 'circle' &&
                    zone.center_lat != null &&
                    zone.center_lng != null &&
                    zone.radius_metres != null) {
                  return (
                    <Circle
                      key={zone.id}
                      center={[Number(zone.center_lat), Number(zone.center_lng)]}
                      radius={Number(zone.radius_metres)}
                      pathOptions={opts}
                    >
                      <Popup>
                        <p className="font-semibold text-sm">{zone.name}</p>
                        <p className="text-xs text-gray-500 capitalize">{zone.zone_type.replace('_', ' ')}</p>
                        <p className="text-xs text-gray-400">r = {Number(zone.radius_metres).toFixed(0)} m</p>
                      </Popup>
                    </Circle>
                  );
                }
                if (zone.shape === 'polygon' && zone.coordinates?.length) {
                  return (
                    <Polygon
                      key={zone.id}
                      positions={zone.coordinates.map(c => [c[0], c[1]] as [number, number])}
                      pathOptions={opts}
                    >
                      <Popup>
                        <p className="font-semibold text-sm">{zone.name}</p>
                        <p className="text-xs text-gray-500 capitalize">{zone.zone_type.replace('_', ' ')}</p>
                        <p className="text-xs text-gray-400">{zone.coordinates.length} vertices</p>
                      </Popup>
                    </Polygon>
                  );
                }
                return null;
              })}

            </MapContainer>
          )}
        </div>
      </div>

      {/* ── Map legend ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 bg-gray-900 rounded-lg p-3 border border-gray-800 text-xs text-gray-400">
        {mode === 'live' ? (
          <>
            <span className="font-medium text-gray-500">Legend:</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-blue-500 inline-block ring-2 ring-blue-500/30" /> Live vehicle</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-yellow-500 inline-block" /> Selected</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-gray-500 inline-block" /> Offline (last known)</span>
            {showZones && zones.length > 0 && (
              <span className="flex items-center gap-1.5 text-green-400">
                <MapPin className="w-3 h-3" /> {zones.length} zone{zones.length !== 1 ? 's' : ''} visible
              </span>
            )}
            <span className="ml-auto text-gray-600">Positions update in real-time · Marked offline after 5 min</span>
          </>
        ) : (
          <>
            <span className="font-medium text-gray-500">Legend:</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-green-500 inline-block" /> Start</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-red-500 inline-block" /> End</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-yellow-400 inline-block ring-2 ring-yellow-400/30" /> Playback position</span>
            {routeSegments.length > 1 && (
              <span className="flex items-center gap-1.5">
                {SEG_COLORS.slice(0, Math.min(routeSegments.length, 4)).map((c, i) => (
                  <span key={i} className="inline-block w-5 h-1.5 rounded-full" style={{ background: c }} />
                ))}
                {routeSegments.length} segments
              </span>
            )}
            {showZones && zones.length > 0 && (
              <span className="flex items-center gap-1.5 text-green-400">
                <MapPin className="w-3 h-3" /> {zones.length} zone{zones.length !== 1 ? 's' : ''} visible
              </span>
            )}
            <span className="ml-auto text-gray-600">Max {ROW_CAP.toLocaleString()} pts · Segments split at gaps &gt;5 min</span>
          </>
        )}
      </div>
    </div>
  );
}
