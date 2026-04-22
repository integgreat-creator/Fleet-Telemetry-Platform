import { useState, useEffect, useCallback, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import {
  MapContainer, TileLayer, Circle, Polygon, useMapEvents, Marker,
} from 'react-leaflet';
import L from 'leaflet';
import {
  Plus, Trash2, Edit2, Save, X, MapPin, Shield, Building2,
  Users, Globe, Layers, ChevronDown, CheckCircle2, AlertCircle,
  Loader, ToggleLeft, ToggleRight, Clock,
} from 'lucide-react';
import { supabase, type Vehicle } from '../lib/supabase';

// ── Fix Leaflet marker icons (same fix as FleetMapPage) ───────────────────────
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl:       'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl:     'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Geofence {
  id:                      string;
  fleet_id:                string;
  name:                    string;
  zone_type:               string;
  shape:                   'circle' | 'polygon';
  center_lat?:             number | null;
  center_lng?:             number | null;
  radius_metres?:          number | null;
  coordinates?:            [number, number][] | null;
  time_restriction_start?: string | null;
  time_restriction_end?:   string | null;
  color:                   string;
  is_active:               boolean;
  created_at:              string;
}

interface Assignment {
  id:               string;
  geofence_id:      string;
  vehicle_id:       string;
  alert_on_entry:   boolean;
  alert_on_exit:    boolean;
  alert_on_dwell:   boolean;
  dwell_minutes:    number;
  alert_channels:   { in_app: boolean; whatsapp: boolean };
  cooldown_minutes: number;
  is_active:        boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ZONE_TYPES = [
  { value: 'depot',      label: 'Depot',      icon: Building2 },
  { value: 'customer',   label: 'Customer',   icon: Users     },
  { value: 'restricted', label: 'Restricted', icon: Shield    },
  { value: 'city',       label: 'City',       icon: Globe     },
  { value: 'state',      label: 'State',      icon: Globe     },
  { value: 'custom',     label: 'Custom',     icon: MapPin    },
];

const ZONE_COLORS = [
  { value: '#3B82F6', label: 'Blue'   },
  { value: '#10B981', label: 'Green'  },
  { value: '#F59E0B', label: 'Amber'  },
  { value: '#EF4444', label: 'Red'    },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#06B6D4', label: 'Cyan'   },
];

const MAX_POLYGON_VERTICES = 50;
// Default map center: Chennai
const DEFAULT_CENTER: [number, number] = [13.0827, 80.2707];

// ── Zone type badge ───────────────────────────────────────────────────────────

function ZoneBadge({ type }: { type: string }) {
  const cfg = ZONE_TYPES.find(z => z.value === type) ?? ZONE_TYPES[5];
  const colors: Record<string, string> = {
    depot:      'bg-blue-500/20 text-blue-300',
    customer:   'bg-green-500/20 text-green-300',
    restricted: 'bg-red-500/20 text-red-300',
    city:       'bg-purple-500/20 text-purple-300',
    state:      'bg-cyan-500/20 text-cyan-300',
    custom:     'bg-gray-500/20 text-gray-300',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${colors[type] ?? colors.custom}`}>
      {cfg.label}
    </span>
  );
}

// ── Map drawing component ─────────────────────────────────────────────────────

type DrawMode = 'none' | 'circle-center' | 'polygon';

interface DrawingLayerProps {
  drawMode:        DrawMode;
  polygonVertices: [number, number][];
  onCircleCenter:  (lat: number, lng: number) => void;
  onPolygonVertex: (lat: number, lng: number) => void;
}

function DrawingLayer({
  drawMode, polygonVertices, onCircleCenter, onPolygonVertex,
}: DrawingLayerProps) {
  useMapEvents({
    click(e) {
      if (drawMode === 'circle-center') {
        onCircleCenter(e.latlng.lat, e.latlng.lng);
      } else if (drawMode === 'polygon') {
        if (polygonVertices.length >= MAX_POLYGON_VERTICES) return;
        // Clicking within 20px of the first vertex closes the polygon
        if (polygonVertices.length >= 3) {
          const map    = e.target;
          const first  = L.latLng(polygonVertices[0][0], polygonVertices[0][1]);
          const pxDist = map.latLngToContainerPoint(first)
            .distanceTo(e.containerPoint);
          if (pxDist < 20) {
            // Signal close by re-adding first vertex as last
            onPolygonVertex(polygonVertices[0][0], polygonVertices[0][1]);
            return;
          }
        }
        onPolygonVertex(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GeofencesPage() {
  const [zones,        setZones]        = useState<Geofence[]>([]);
  const [vehicles,     setVehicles]     = useState<Vehicle[]>([]);
  const [assignments,  setAssignments]  = useState<Assignment[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [fleetId,      setFleetId]      = useState('');
  const [planLimit,    setPlanLimit]    = useState(10);

  const [selectedZone, setSelectedZone] = useState<Geofence | null>(null);
  const [showForm,     setShowForm]     = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saveMsg,      setSaveMsg]      = useState('');
  const [deleteConfirm,setDeleteConfirm]= useState<string | null>(null);

  // ── Drawing state ──────────────────────────────────────────────────────────
  const [drawMode,       setDrawMode]       = useState<DrawMode>('none');
  const [polygonVerts,   setPolygonVerts]   = useState<[number, number][]>([]);
  const [polygonClosed,  setPolygonClosed]  = useState(false);
  const [circleCenter,   setCircleCenter]   = useState<[number, number] | null>(null);

  // ── Form state ────────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    name:                   '',
    zone_type:              'depot',
    shape:                  'circle' as 'circle' | 'polygon',
    radius_metres:          '500',
    color:                  '#3B82F6',
    time_restriction_start: '',
    time_restriction_end:   '',
  });

  // Per-vehicle assignment toggles while editing a zone
  const [assignedVehicles,  setAssignedVehicles]  = useState<Set<string>>(new Set());
  const [alertOnEntry,      setAlertOnEntry]       = useState(false);
  const [alertOnExit,       setAlertOnExit]        = useState(false);
  const [alertOnDwell,      setAlertOnDwell]       = useState(false);
  const [dwellMinutes,      setDwellMinutes]       = useState('30');
  const [cooldownMinutes,   setCooldownMinutes]    = useState('15');
  const [whatsappAlert,     setWhatsappAlert]      = useState(false);

  // ── Load data ─────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: fleet } = await supabase
        .from('fleets').select('id').eq('manager_id', user.id).single();
      if (!fleet) return;
      setFleetId(fleet.id);

      // Get plan limit
      const { data: sub } = await supabase
        .from('subscriptions').select('plan')
        .eq('fleet_id', fleet.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const plan = sub?.plan ?? 'free';
      setPlanLimit(plan === 'pro' ? 999999 : plan === 'starter' ? 10 : 2);

      const [zonesRes, vehiclesRes, assignRes] = await Promise.all([
        supabase.from('geofences').select('*').eq('fleet_id', fleet.id).order('created_at', { ascending: false }),
        supabase.from('vehicles').select('id, name, vin').eq('fleet_id', fleet.id).order('name'),
        supabase.from('geofence_assignments').select('*').in(
          'geofence_id',
          (await supabase.from('geofences').select('id').eq('fleet_id', fleet.id)).data?.map((z: any) => z.id) ?? [],
        ),
      ]);

      setZones((zonesRes.data ?? []) as Geofence[]);
      setVehicles((vehiclesRes.data ?? []) as Vehicle[]);
      setAssignments((assignRes.data ?? []) as Assignment[]);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Open create form ──────────────────────────────────────────────────────
  function openCreate() {
    setSelectedZone(null);
    setForm({ name: '', zone_type: 'depot', shape: 'circle', radius_metres: '500', color: '#3B82F6', time_restriction_start: '', time_restriction_end: '' });
    setAssignedVehicles(new Set());
    setAlertOnEntry(true); setAlertOnExit(true); setAlertOnDwell(false);
    setDwellMinutes('30'); setCooldownMinutes('15'); setWhatsappAlert(false);
    setCircleCenter(null); setPolygonVerts([]); setPolygonClosed(false);
    setDrawMode('none');
    setSaveMsg('');
    setShowForm(true);
  }

  // ── Open edit form ────────────────────────────────────────────────────────
  function openEdit(zone: Geofence) {
    setSelectedZone(zone);
    setForm({
      name:                   zone.name,
      zone_type:              zone.zone_type,
      shape:                  zone.shape,
      radius_metres:          String(zone.radius_metres ?? 500),
      color:                  zone.color,
      time_restriction_start: zone.time_restriction_start ?? '',
      time_restriction_end:   zone.time_restriction_end   ?? '',
    });
    if (zone.shape === 'circle' && zone.center_lat != null && zone.center_lng != null) {
      setCircleCenter([zone.center_lat, zone.center_lng]);
    } else {
      setCircleCenter(null);
    }
    if (zone.shape === 'polygon' && zone.coordinates?.length) {
      setPolygonVerts(zone.coordinates);
      setPolygonClosed(true);
    } else {
      setPolygonVerts([]);
      setPolygonClosed(false);
    }

    // Load existing assignments for this zone
    const zoneAssignments = assignments.filter(a => a.geofence_id === zone.id);
    setAssignedVehicles(new Set(zoneAssignments.map(a => a.vehicle_id)));
    if (zoneAssignments.length > 0) {
      const first = zoneAssignments[0];
      setAlertOnEntry(first.alert_on_entry);
      setAlertOnExit(first.alert_on_exit);
      setAlertOnDwell(first.alert_on_dwell);
      setDwellMinutes(String(first.dwell_minutes));
      setCooldownMinutes(String(first.cooldown_minutes));
      setWhatsappAlert(first.alert_channels?.whatsapp ?? false);
    } else {
      setAlertOnEntry(true); setAlertOnExit(true); setAlertOnDwell(false);
      setDwellMinutes('30'); setCooldownMinutes('15'); setWhatsappAlert(false);
    }
    setDrawMode('none');
    setSaveMsg('');
    setShowForm(true);
  }

  // ── Drawing handlers ──────────────────────────────────────────────────────
  function handleCircleCenter(lat: number, lng: number) {
    setCircleCenter([lat, lng]);
    setDrawMode('none');
  }

  function handlePolygonVertex(lat: number, lng: number) {
    setPolygonVerts(prev => {
      const next = [...prev, [lat, lng] as [number, number]];
      // If this vertex == first vertex, polygon is closed
      if (prev.length >= 3 && lat === prev[0][0] && lng === prev[0][1]) {
        setPolygonClosed(true);
        setDrawMode('none');
        return prev; // don't add duplicate closing vertex
      }
      return next;
    });
  }

  function cancelDraw() {
    setDrawMode('none');
    if (form.shape === 'circle') setCircleCenter(null);
    else { setPolygonVerts([]); setPolygonClosed(false); }
  }

  // ── Save zone ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!form.name.trim()) { setSaveMsg('Zone name is required.'); return; }
    if (form.shape === 'circle' && !circleCenter) {
      setSaveMsg('Click the map to place the zone center first.'); return;
    }
    if (form.shape === 'polygon' && polygonVerts.length < 3) {
      setSaveMsg('Draw at least 3 vertices to define a polygon zone.'); return;
    }

    setSaving(true);
    setSaveMsg('');
    try {
      const zonePayload: any = {
        fleet_id:                fleetId,
        name:                    form.name.trim(),
        zone_type:               form.zone_type,
        shape:                   form.shape,
        color:                   form.color,
        time_restriction_start:  form.time_restriction_start || null,
        time_restriction_end:    form.time_restriction_end   || null,
        is_active:               true,
      };

      if (form.shape === 'circle' && circleCenter) {
        zonePayload.center_lat     = circleCenter[0];
        zonePayload.center_lng     = circleCenter[1];
        zonePayload.radius_metres  = parseFloat(form.radius_metres) || 500;
        zonePayload.coordinates    = null;
      } else {
        zonePayload.coordinates    = polygonVerts;
        zonePayload.center_lat     = null;
        zonePayload.center_lng     = null;
        zonePayload.radius_metres  = null;
      }

      let zoneId: string;
      if (selectedZone) {
        const { error } = await supabase
          .from('geofences').update(zonePayload).eq('id', selectedZone.id);
        if (error) throw error;
        zoneId = selectedZone.id;
      } else {
        const { data, error } = await supabase
          .from('geofences').insert(zonePayload).select('id').single();
        if (error) throw error;
        zoneId = data.id;
      }

      // Sync assignments: delete all existing, re-insert for selected vehicles
      await supabase.from('geofence_assignments')
        .delete().eq('geofence_id', zoneId);

      if (assignedVehicles.size > 0) {
        const assignRows = Array.from(assignedVehicles).map(vid => ({
          geofence_id:      zoneId,
          vehicle_id:       vid,
          alert_on_entry:   alertOnEntry,
          alert_on_exit:    alertOnExit,
          alert_on_dwell:   alertOnDwell,
          dwell_minutes:    parseInt(dwellMinutes)    || 30,
          cooldown_minutes: parseInt(cooldownMinutes) || 15,
          alert_channels:   { in_app: true, whatsapp: whatsappAlert },
          is_active:        true,
        }));
        const { error: aErr } = await supabase
          .from('geofence_assignments').insert(assignRows);
        if (aErr) throw aErr;
      }

      setSaveMsg('✓ Saved');
      await loadAll();
      setTimeout(() => setShowForm(false), 800);
    } catch (e: any) {
      setSaveMsg(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // ── Delete zone ───────────────────────────────────────────────────────────
  async function handleDelete(zoneId: string) {
    await supabase.from('geofences').delete().eq('id', zoneId);
    setDeleteConfirm(null);
    setShowForm(false);
    await loadAll();
  }

  // ── Toggle active ─────────────────────────────────────────────────────────
  async function toggleActive(zone: Geofence) {
    await supabase.from('geofences')
      .update({ is_active: !zone.is_active }).eq('id', zone.id);
    setZones(prev => prev.map(z => z.id === zone.id ? { ...z, is_active: !z.is_active } : z));
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeCount   = zones.filter(z => z.is_active).length;
  const atLimit       = activeCount >= planLimit;
  const mapCenter     = circleCenter ?? DEFAULT_CENTER;

  // Preview geometry for the form map
  const previewRadius  = parseFloat(form.radius_metres) || 500;
  const previewCircle  = form.shape === 'circle' && circleCenter
    ? circleCenter : null;
  const previewPolygon = form.shape === 'polygon' && polygonVerts.length >= 3
    ? polygonVerts : null;

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Geofences</h1>
          <p className="text-gray-400 mt-1">
            Define virtual boundaries and get alerts when vehicles enter or leave them.
          </p>
        </div>
        <button
          onClick={openCreate}
          disabled={atLimit}
          title={atLimit ? `Zone limit reached (${activeCount}/${planLimit === 999999 ? '∞' : planLimit}). Upgrade your plan to add more.` : undefined}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Zone
        </button>
      </div>

      {/* Usage bar */}
      <div className="flex items-center gap-3 text-sm text-gray-400">
        <Layers className="w-4 h-4" />
        <span>{activeCount} of {planLimit === 999999 ? 'unlimited' : planLimit} active zones used</span>
        {atLimit && (
          <span className="text-yellow-400 font-medium">— upgrade to add more</span>
        )}
      </div>

      <div className="flex gap-6">
        {/* ── Zone list ────────────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 space-y-2">
          {zones.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-500 text-sm">
              No zones yet. Click <strong className="text-gray-400">New Zone</strong> to draw your first boundary.
            </div>
          )}
          {zones.map(zone => {
            const vCount = assignments.filter(a => a.geofence_id === zone.id).length;
            return (
              <div
                key={zone.id}
                onClick={() => openEdit(zone)}
                className={`bg-gray-900 border rounded-lg p-3 cursor-pointer transition-colors hover:border-gray-600 ${
                  selectedZone?.id === zone.id && showForm
                    ? 'border-blue-500'
                    : 'border-gray-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: zone.color }}
                    />
                    <span className="text-white text-sm font-medium truncate">{zone.name}</span>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); toggleActive(zone); }}
                    title={zone.is_active ? 'Deactivate zone' : 'Activate zone'}
                  >
                    {zone.is_active
                      ? <ToggleRight className="w-5 h-5 text-blue-400" />
                      : <ToggleLeft  className="w-5 h-5 text-gray-600" />
                    }
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <ZoneBadge type={zone.zone_type} />
                  <span className="text-xs text-gray-500 capitalize">{zone.shape}</span>
                  <span className="text-xs text-gray-600 ml-auto">{vCount} vehicle{vCount !== 1 ? 's' : ''}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Detail panel / Map ───────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          {!showForm ? (
            /* Placeholder when nothing is selected */
            <div className="bg-gray-900 border border-gray-800 rounded-lg h-96 flex flex-col items-center justify-center text-gray-600 gap-3">
              <MapPin className="w-10 h-10" />
              <p className="text-sm">Select a zone to edit, or create a new one.</p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {/* Panel header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                <h2 className="text-white font-semibold">
                  {selectedZone ? 'Edit Zone' : 'New Zone'}
                </h2>
                <button onClick={() => setShowForm(false)}>
                  <X className="w-5 h-5 text-gray-400 hover:text-white" />
                </button>
              </div>

              <div className="flex">
                {/* Form fields */}
                <div className="w-72 flex-shrink-0 p-5 space-y-4 overflow-y-auto max-h-[640px] border-r border-gray-800">

                  {/* Name */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Zone Name</label>
                    <input
                      value={form.name}
                      onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Chennai Depot"
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* Zone type */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Zone Type</label>
                    <select
                      value={form.zone_type}
                      onChange={e => setForm(f => ({ ...f, zone_type: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                    >
                      {ZONE_TYPES.map(z => (
                        <option key={z.value} value={z.value}>{z.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Shape */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Shape</label>
                    <div className="flex gap-2">
                      {(['circle', 'polygon'] as const).map(s => (
                        <button
                          key={s}
                          onClick={() => {
                            setForm(f => ({ ...f, shape: s }));
                            setCircleCenter(null); setPolygonVerts([]); setPolygonClosed(false); setDrawMode('none');
                          }}
                          className={`flex-1 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
                            form.shape === s
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Circle radius */}
                  {form.shape === 'circle' && (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Radius (metres)</label>
                      <input
                        type="number" min={50} max={50000}
                        value={form.radius_metres}
                        onChange={e => setForm(f => ({ ...f, radius_metres: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  )}

                  {/* Polygon vertex count */}
                  {form.shape === 'polygon' && (
                    <div className="text-xs text-gray-400 flex items-center gap-1">
                      <span>{polygonVerts.length} / {MAX_POLYGON_VERTICES} vertices</span>
                      {polygonClosed && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
                    </div>
                  )}

                  {/* Drawing toolbar */}
                  <div className="flex gap-2">
                    {drawMode === 'none' ? (
                      <button
                        onClick={() => setDrawMode(form.shape === 'circle' ? 'circle-center' : 'polygon')}
                        className="flex-1 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                      >
                        {form.shape === 'circle'
                          ? circleCenter ? 'Move Center' : 'Click Map to Place Center'
                          : polygonClosed ? 'Redraw' : 'Click Map to Draw'
                        }
                      </button>
                    ) : (
                      <>
                        <span className="flex-1 py-1.5 text-xs text-yellow-400 text-center animate-pulse">
                          {drawMode === 'circle-center' ? 'Click map to set center…' : `Click to add vertex (${polygonVerts.length}/${MAX_POLYGON_VERTICES})`}
                        </span>
                        <button
                          onClick={cancelDraw}
                          className="px-2 py-1.5 text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 rounded-lg"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>

                  {/* Color */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Colour</label>
                    <div className="flex gap-2 flex-wrap">
                      {ZONE_COLORS.map(c => (
                        <button
                          key={c.value}
                          onClick={() => setForm(f => ({ ...f, color: c.value }))}
                          title={c.label}
                          className={`w-6 h-6 rounded-full border-2 transition-all ${
                            form.color === c.value ? 'border-white scale-110' : 'border-transparent'
                          }`}
                          style={{ background: c.value }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Time restriction */}
                  <div>
                    <label className="block text-xs text-gray-400 mb-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Night Movement (optional)
                    </label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="time" value={form.time_restriction_start}
                        onChange={e => setForm(f => ({ ...f, time_restriction_start: e.target.value }))}
                        className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
                      />
                      <span className="text-gray-500 text-xs">to</span>
                      <input
                        type="time" value={form.time_restriction_end}
                        onChange={e => setForm(f => ({ ...f, time_restriction_end: e.target.value }))}
                        className="flex-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                    <p className="text-[10px] text-gray-600 mt-1">Movement inside/outside this zone during these hours triggers a critical alert.</p>
                  </div>

                  {/* Alert settings */}
                  <div className="space-y-2 pt-1 border-t border-gray-800">
                    <p className="text-xs text-gray-400 font-semibold">Alert Settings</p>
                    {[
                      { label: 'Alert on Entry', value: alertOnEntry, set: setAlertOnEntry },
                      { label: 'Alert on Exit',  value: alertOnExit,  set: setAlertOnExit  },
                    ].map(({ label, value, set }) => (
                      <label key={label} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={value} onChange={e => set(e.target.checked)}
                          className="w-3.5 h-3.5 accent-blue-500" />
                        <span className="text-sm text-gray-300">{label}</span>
                      </label>
                    ))}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={alertOnDwell} onChange={e => setAlertOnDwell(e.target.checked)}
                        className="w-3.5 h-3.5 accent-blue-500" />
                      <span className="text-sm text-gray-300">Alert on Dwell</span>
                    </label>
                    {alertOnDwell && (
                      <div className="flex items-center gap-2 pl-5">
                        <input type="number" min={5} max={480} value={dwellMinutes}
                          onChange={e => setDwellMinutes(e.target.value)}
                          className="w-16 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1 focus:outline-none" />
                        <span className="text-xs text-gray-500">minutes inside</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Cooldown:</span>
                      <input type="number" min={1} max={120} value={cooldownMinutes}
                        onChange={e => setCooldownMinutes(e.target.value)}
                        className="w-16 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1 focus:outline-none" />
                      <span className="text-xs text-gray-500">min between alerts</span>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={whatsappAlert} onChange={e => setWhatsappAlert(e.target.checked)}
                        className="w-3.5 h-3.5 accent-green-500" />
                      <span className="text-sm text-gray-300">WhatsApp alert</span>
                    </label>
                  </div>

                  {/* Vehicle assignments */}
                  <div className="space-y-2 pt-1 border-t border-gray-800">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-400 font-semibold">Assigned Vehicles</p>
                      <div className="flex gap-2">
                        <button onClick={() => setAssignedVehicles(new Set(vehicles.map(v => v.id)))}
                          className="text-[10px] text-blue-400 hover:text-blue-300">All</button>
                        <button onClick={() => setAssignedVehicles(new Set())}
                          className="text-[10px] text-gray-500 hover:text-gray-400">None</button>
                      </div>
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {vehicles.map(v => (
                        <label key={v.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                          <input
                            type="checkbox"
                            checked={assignedVehicles.has(v.id)}
                            onChange={e => {
                              setAssignedVehicles(prev => {
                                const next = new Set(prev);
                                e.target.checked ? next.add(v.id) : next.delete(v.id);
                                return next;
                              });
                            }}
                            className="w-3.5 h-3.5 accent-blue-500"
                          />
                          <span className="text-sm text-gray-300 truncate">{v.name}</span>
                          <span className="text-xs text-gray-600 ml-auto flex-shrink-0">{v.vin?.slice(-6)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Save / Delete */}
                  <div className="pt-2 space-y-2">
                    {saveMsg && (
                      <p className={`text-xs flex items-center gap-1 ${saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                        {saveMsg.startsWith('✓')
                          ? <CheckCircle2 className="w-3.5 h-3.5" />
                          : <AlertCircle  className="w-3.5 h-3.5" />
                        }
                        {saveMsg}
                      </p>
                    )}
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {saving
                        ? <Loader className="w-4 h-4 animate-spin" />
                        : <Save className="w-4 h-4" />
                      }
                      {saving ? 'Saving…' : 'Save Zone'}
                    </button>
                    {selectedZone && (
                      deleteConfirm === selectedZone.id ? (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDelete(selectedZone.id)}
                            className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg"
                          >
                            Confirm Delete
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="flex-1 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(selectedZone.id)}
                          className="w-full py-1.5 text-red-400 hover:text-red-300 text-xs flex items-center justify-center gap-1 hover:bg-red-500/10 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete Zone
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Map panel */}
                <div className="flex-1 relative" style={{ height: 640 }}>
                  {drawMode !== 'none' && (
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-blue-600 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
                      {drawMode === 'circle-center'
                        ? 'Click to set zone centre'
                        : polygonVerts.length < 3
                          ? `Click to add vertices (${polygonVerts.length} so far)`
                          : 'Click the first point to close the polygon, or keep adding vertices'
                      }
                    </div>
                  )}
                  <MapContainer
                    center={mapCenter}
                    zoom={13}
                    style={{ height: '100%', width: '100%', cursor: drawMode !== 'none' ? 'crosshair' : 'grab' }}
                    className="rounded-r-xl"
                  >
                    <TileLayer
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    />
                    <DrawingLayer
                      drawMode={drawMode}
                      polygonVertices={polygonVerts}
                      onCircleCenter={handleCircleCenter}
                      onPolygonVertex={handlePolygonVertex}
                    />
                    {/* Preview circle */}
                    {previewCircle && (
                      <>
                        <Circle
                          center={previewCircle}
                          radius={previewRadius}
                          pathOptions={{ color: form.color, fillColor: form.color, fillOpacity: 0.15, weight: 2 }}
                        />
                        <Marker position={previewCircle} />
                      </>
                    )}
                    {/* Preview polygon */}
                    {previewPolygon && (
                      <Polygon
                        positions={previewPolygon}
                        pathOptions={{ color: form.color, fillColor: form.color, fillOpacity: 0.15, weight: 2 }}
                      />
                    )}
                    {/* In-progress polygon vertices */}
                    {form.shape === 'polygon' && !polygonClosed && polygonVerts.length > 0 &&
                      polygonVerts.map((v, i) => (
                        <Marker key={i} position={v} />
                      ))
                    }
                    {/* Existing saved zones as reference */}
                    {zones.filter(z => z.id !== selectedZone?.id && z.is_active).map(z => {
                      if (z.shape === 'circle' && z.center_lat != null && z.center_lng != null) {
                        return (
                          <Circle key={z.id}
                            center={[z.center_lat, z.center_lng]}
                            radius={z.radius_metres ?? 500}
                            pathOptions={{ color: z.color, fillColor: z.color, fillOpacity: 0.08, weight: 1, dashArray: '4 4' }}
                          />
                        );
                      }
                      if (z.shape === 'polygon' && z.coordinates?.length) {
                        return (
                          <Polygon key={z.id}
                            positions={z.coordinates}
                            pathOptions={{ color: z.color, fillColor: z.color, fillOpacity: 0.08, weight: 1, dashArray: '4 4' }}
                          />
                        );
                      }
                      return null;
                    })}
                  </MapContainer>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
