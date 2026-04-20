import { useState, useEffect, useCallback } from 'react';
import {
  Wrench, AlertTriangle, CheckCircle, Clock, RefreshCw,
  MapPin, Phone, ChevronDown, ChevronUp, X, Save,
  History, Activity,
} from 'lucide-react';
import { supabase, type Vehicle } from '../lib/supabase';
import { useSubscription } from '../hooks/useSubscription';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MaintenancePrediction {
  id:              string;
  vehicle_id:      string;
  prediction_type: string;
  description:     string | null;
  due_at_km:       number | null;
  due_date:        string | null;
  urgency:         'low' | 'medium' | 'high' | 'critical';
  confidence:      number | null;
  status:          'upcoming' | 'due' | 'overdue' | 'completed';
  generated_at:    string;
}

interface MaintenanceLog {
  id:           string;
  vehicle_id:   string;
  service_type: string;
  service_date: string;
  odometer_km:  number | null;
  cost:         number | null;
  notes:        string | null;
  created_at:   string;
}

interface Garage {
  id:               string;
  name:             string;
  city:             string;
  state:            string | null;
  latitude:         number;
  longitude:        number;
  contact_number:   string | null;
  address:          string | null;
  services_offered: string[];
}

interface GarageWithDistance extends Garage {
  distance_km: number;
}

type Tab = 'predictions' | 'history';

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  oil_change:        'Oil Change',
  tire_rotation:     'Tyre Rotation',
  air_filter:        'Air Filter',
  brake_inspection:  'Brake Inspection',
  engine_check:      'Engine Check',
};

const STATUS_STYLE: Record<string, { label: string; badge: string; text: string }> = {
  overdue:  { label: 'Overdue',  badge: 'bg-red-500/20 text-red-400 border border-red-500/30',      text: 'text-red-400'    },
  due:      { label: 'Due Soon', badge: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30', text: 'text-yellow-400' },
  upcoming: { label: 'Upcoming', badge: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',    text: 'text-blue-400'   },
  completed:{ label: 'Completed',badge: 'bg-green-500/20 text-green-400 border border-green-500/30', text: 'text-green-400'  },
};

const BORDER_STYLE: Record<string, string> = {
  overdue:   'border-l-4 border-l-red-500',
  due:       'border-l-4 border-l-yellow-500',
  upcoming:  'border-l-4 border-l-blue-500',
  completed: 'border-l-4 border-l-green-500',
};

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Mark-as-Serviced modal ────────────────────────────────────────────────────

interface ServiceModalProps {
  prediction:  MaintenancePrediction;
  vehicle:     Vehicle | undefined;
  fleetId:     string | null;
  onClose:     () => void;
  onSaved:     () => void;
}

function ServiceModal({ prediction, vehicle, fleetId, onClose, onSaved }: ServiceModalProps) {
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [odometerKm,  setOdometerKm]  = useState('');
  const [cost,        setCost]        = useState('');
  const [notes,       setNotes]       = useState('');
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState('');

  const handleSave = async () => {
    if (!fleetId) { setError('Fleet ID not found — please refresh.'); return; }
    setSaving(true);
    setError('');
    try {
      // 1. Insert service log
      const { error: logErr } = await supabase.from('maintenance_logs').insert({
        vehicle_id:   prediction.vehicle_id,
        fleet_id:     fleetId,
        service_type: prediction.prediction_type,
        service_date: serviceDate,
        odometer_km:  odometerKm  ? parseFloat(odometerKm)  : null,
        cost:         cost        ? parseFloat(cost)         : null,
        notes:        notes.trim() || null,
      });
      if (logErr) throw logErr;

      // 2. Mark prediction as completed
      const { error: predErr } = await supabase
        .from('maintenance_predictions')
        .update({ status: 'completed' })
        .eq('id', prediction.id);
      if (predErr) throw predErr;

      onSaved();
    } catch (e: any) {
      setError(e.message ?? 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const serviceLabel = SERVICE_LABELS[prediction.prediction_type] ?? prediction.prediction_type;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="text-white font-bold text-lg">Mark as Serviced</h2>
            <p className="text-gray-400 text-sm mt-0.5">
              {serviceLabel} — {vehicle?.name ?? 'Vehicle'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1">Service Date *</label>
            <input
              type="date"
              value={serviceDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => setServiceDate(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1">Odometer at Service (km)</label>
            <input
              type="number"
              placeholder="e.g. 45000"
              value={odometerKm}
              min="0"
              onChange={e => setOdometerKm(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1">Cost (₹)</label>
            <input
              type="number"
              placeholder="e.g. 1200"
              value={cost}
              min="0"
              onChange={e => setCost(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1">Notes</label>
            <textarea
              placeholder="e.g. Replaced with synthetic oil, new filter fitted…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 pb-5">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-400 hover:text-white hover:border-gray-600 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !serviceDate}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
          >
            {saving ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving…' : 'Save Service'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Garage suggestions panel ──────────────────────────────────────────────────

function GaragePanel({
  serviceType,
  vehicleLat,
  vehicleLng,
}: {
  serviceType: string;
  vehicleLat:  number | null;
  vehicleLng:  number | null;
}) {
  const [garages,  setGarages]  = useState<GarageWithDistance[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loaded,   setLoaded]   = useState(false);

  const loadGarages = useCallback(async () => {
    if (loaded) return;
    const { data } = await supabase
      .from('garages')
      .select('*')
      .eq('is_active', true);

    if (!data) return;

    const withDist: GarageWithDistance[] = (data as Garage[])
      .filter(g => {
        const offered = Array.isArray(g.services_offered) ? g.services_offered : [];
        return offered.includes(serviceType) || offered.length === 0;
      })
      .map(g => ({
        ...g,
        distance_km:
          vehicleLat != null && vehicleLng != null
            ? haversineKm(vehicleLat, vehicleLng, g.latitude, g.longitude)
            : Infinity,
      }))
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, 5);

    setGarages(withDist);
    setLoaded(true);
  }, [loaded, serviceType, vehicleLat, vehicleLng]);

  const toggle = () => {
    setExpanded(v => !v);
    if (!expanded) loadGarages();
  };

  return (
    <div className="mt-3 border-t border-gray-800 pt-3">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        <MapPin className="w-3.5 h-3.5" />
        Nearby garages
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {garages.length === 0 ? (
            <p className="text-xs text-gray-500">No garages found for this service type.</p>
          ) : (
            garages.map(g => (
              <div key={g.id} className="bg-gray-800/60 rounded-lg px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-white truncate">{g.name}</p>
                    <p className="text-xs text-gray-400 truncate">{g.city}{g.state ? `, ${g.state}` : ''}</p>
                    {g.address && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">{g.address}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {g.distance_km !== Infinity && (
                      <p className="text-xs font-semibold text-blue-400">
                        {g.distance_km < 1
                          ? `${Math.round(g.distance_km * 1000)} m`
                          : `${g.distance_km.toFixed(1)} km`}
                      </p>
                    )}
                    {g.contact_number && (
                      <a
                        href={`tel:${g.contact_number}`}
                        className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 mt-0.5"
                      >
                        <Phone className="w-3 h-3" />
                        {g.contact_number}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MaintenancePage() {
  const { fleetId } = useSubscription();

  const [tab,           setTab]           = useState<Tab>('predictions');
  const [predictions,   setPredictions]   = useState<MaintenancePrediction[]>([]);
  const [logs,          setLogs]          = useState<MaintenanceLog[]>([]);
  const [vehicles,      setVehicles]      = useState<Vehicle[]>([]);
  const [vehicleLocs,   setVehicleLocs]   = useState<Record<string, { lat: number; lng: number }>>({});
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [modalPred,     setModalPred]     = useState<MaintenancePrediction | null>(null);

  const loadData = useCallback(async () => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const [predsRes, vehiclesRes, logsRes] = await Promise.all([
        supabase
          .from('maintenance_predictions')
          .select('*')
          .neq('status', 'completed')
          .order('status', { ascending: false })    // overdue first
          .order('due_date',  { ascending: true })
          .limit(500),
        supabase.from('vehicles').select('*'),
        supabase
          .from('maintenance_logs')
          .select('*')
          .order('service_date', { ascending: false })
          .limit(500),
      ]);

      if (predsRes.data)   setPredictions(predsRes.data   as MaintenancePrediction[]);
      if (vehiclesRes.data) setVehicles(vehiclesRes.data  as Vehicle[]);
      if (logsRes.data)    setLogs(logsRes.data           as MaintenanceLog[]);

      // Fetch last known location for each vehicle (for garage distance calc)
      if (vehiclesRes.data && vehiclesRes.data.length > 0) {
        const locMap: Record<string, { lat: number; lng: number }> = {};
        await Promise.all(
          (vehiclesRes.data as Vehicle[]).map(async v => {
            const { data: loc } = await supabase
              .from('vehicle_logs')
              .select('latitude, longitude')
              .eq('vehicle_id', v.id)
              .not('latitude', 'is', null)
              .order('timestamp', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (loc?.latitude && loc?.longitude) {
              locMap[v.id] = { lat: Number(loc.latitude), lng: Number(loc.longitude) };
            }
          }),
        );
        setVehicleLocs(locMap);
      }
    } catch (err) {
      console.error('Maintenance loadData error:', err);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        const { data: { user } } = await supabase.auth.getUser();
        const supabaseUrl = (supabase as any).supabaseUrl as string;
        await fetch(`${supabaseUrl}/functions/v1/generate-predictions`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
        });
      }
    } catch (e) {
      console.error('Refresh predictions error:', e);
    }
    await loadData();
    setRefreshing(false);
  };

  const handleServiceSaved = async () => {
    setModalPred(null);
    await loadData();
  };

  const vehicleMap = vehicles.reduce<Record<string, Vehicle>>((acc, v) => {
    acc[v.id] = v;
    return acc;
  }, {});

  // Stats
  const overdueCount  = predictions.filter(p => p.status === 'overdue').length;
  const dueCount      = predictions.filter(p => p.status === 'due').length;
  const upcomingCount = predictions.filter(p => p.status === 'upcoming').length;
  const totalCount    = predictions.length;

  const formatDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

  const formatKm = (km: number | null) =>
    km != null ? `${km.toLocaleString('en-IN')} km` : '—';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Modal */}
      {modalPred && (
        <ServiceModal
          prediction={modalPred}
          vehicle={vehicleMap[modalPred.vehicle_id]}
          fleetId={fleetId}
          onClose={() => setModalPred(null)}
          onSaved={handleServiceSaved}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1">Maintenance</h1>
          <p className="text-gray-400 text-sm">
            Service predictions based on mileage and time intervals
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl text-sm text-gray-300 font-medium transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh Predictions'}
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total',    value: totalCount,    icon: Wrench,        color: 'text-blue-400',   bg: 'bg-blue-500/10'   },
          { label: 'Overdue',  value: overdueCount,  icon: AlertTriangle, color: 'text-red-400',    bg: 'bg-red-500/10'    },
          { label: 'Due Soon', value: dueCount,      icon: Clock,         color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
          { label: 'Upcoming', value: upcomingCount, icon: CheckCircle,   color: 'text-green-400',  bg: 'bg-green-500/10'  },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 rounded-xl p-5 border border-gray-800">
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{s.value}</p>
            <p className="text-sm text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {([
          { id: 'predictions', label: 'Service Schedule', icon: Activity },
          { id: 'history',     label: 'Service History',  icon: History  },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── PREDICTIONS TAB ── */}
      {tab === 'predictions' && (
        <>
          {predictions.length === 0 ? (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-16 text-center">
              <Wrench className="w-14 h-14 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-400 text-lg font-medium">No active service predictions</p>
              <p className="text-gray-600 text-sm mt-2 max-w-sm mx-auto">
                Click "Refresh Predictions" to generate upcoming service schedules based on
                your vehicles' mileage and service history.
              </p>
            </div>
          ) : (
            <>
              {/* Cards grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {predictions.map(pred => {
                  const vehicle = vehicleMap[pred.vehicle_id];
                  const style   = STATUS_STYLE[pred.status] ?? STATUS_STYLE.upcoming;
                  const border  = BORDER_STYLE[pred.status] ?? BORDER_STYLE.upcoming;
                  const loc     = vehicleLocs[pred.vehicle_id] ?? null;
                  const label   = SERVICE_LABELS[pred.prediction_type] ?? pred.prediction_type;
                  const confPct = Math.round((pred.confidence ?? 0) * 100);

                  return (
                    <div
                      key={pred.id}
                      className={`bg-gray-900 rounded-xl border border-gray-800 p-5 ${border}`}
                    >
                      {/* Title row */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div>
                          <h3 className="text-white font-semibold">{label}</h3>
                          {pred.description && (
                            <p className="text-xs text-gray-500 mt-0.5">{pred.description}</p>
                          )}
                        </div>
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${style.badge}`}>
                          {style.label}
                        </span>
                      </div>

                      {/* Vehicle */}
                      <p className="text-sm text-gray-400 mb-3">
                        {vehicle?.name ?? 'Unknown Vehicle'}
                        {vehicle && (
                          <span className="text-gray-600"> · {vehicle.make} {vehicle.model}</span>
                        )}
                      </p>

                      {/* Due info */}
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        <div>
                          <p className="text-xs text-gray-500">Due at</p>
                          <p className={`text-sm font-semibold ${style.text}`}>
                            {formatKm(pred.due_at_km)}
                          </p>
                        </div>
                        {pred.due_date && (
                          <div>
                            <p className="text-xs text-gray-500">By date</p>
                            <p className={`text-sm font-semibold ${style.text}`}>
                              {formatDate(pred.due_date)}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Confidence bar */}
                      <div className="mb-3">
                        <div className="flex justify-between mb-1">
                          <span className="text-xs text-gray-500">Interval elapsed</span>
                          <span className="text-xs text-gray-400">{confPct}%</span>
                        </div>
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              confPct >= 90 ? 'bg-red-500' : confPct >= 70 ? 'bg-yellow-500' : 'bg-blue-500'
                            }`}
                            style={{ width: `${confPct}%` }}
                          />
                        </div>
                      </div>

                      {/* Action + garage */}
                      <div className="pt-3 border-t border-gray-800">
                        <button
                          onClick={() => setModalPred(pred)}
                          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-green-600/20 hover:bg-green-600/30 border border-green-600/30 text-green-400 text-sm font-medium transition-colors"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Mark as Serviced
                        </button>

                        {(pred.status === 'due' || pred.status === 'overdue') && (
                          <GaragePanel
                            serviceType={pred.prediction_type}
                            vehicleLat={loc?.lat ?? null}
                            vehicleLng={loc?.lng ?? null}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Schedule table */}
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-800">
                  <h2 className="text-lg font-bold text-white">Full Schedule</h2>
                  <p className="text-sm text-gray-400">All active service predictions sorted by status and due date</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {['Vehicle', 'Service', 'Status', 'Due at (km)', 'Due by Date', 'Elapsed', 'Action'].map(col => (
                          <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {predictions.map(pred => {
                        const vehicle = vehicleMap[pred.vehicle_id];
                        const style   = STATUS_STYLE[pred.status] ?? STATUS_STYLE.upcoming;
                        const confPct = Math.round((pred.confidence ?? 0) * 100);
                        const label   = SERVICE_LABELS[pred.prediction_type] ?? pred.prediction_type;

                        return (
                          <tr key={pred.id} className="hover:bg-gray-800/40 transition-colors">
                            <td className="px-4 py-3">
                              <p className="text-white text-sm font-medium">{vehicle?.name ?? '—'}</p>
                              {vehicle && (
                                <p className="text-gray-600 text-xs">{vehicle.make} {vehicle.model}</p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-300">{label}</td>
                            <td className="px-4 py-3">
                              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${style.badge}`}>
                                {style.label}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-300">{formatKm(pred.due_at_km)}</td>
                            <td className="px-4 py-3 text-sm text-gray-300">{formatDate(pred.due_date)}</td>
                            <td className="px-4 py-3 text-sm text-gray-300">{confPct}%</td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => setModalPred(pred)}
                                className="text-xs text-green-400 hover:text-green-300 font-medium transition-colors whitespace-nowrap"
                              >
                                ✓ Serviced
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === 'history' && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">Service History</h2>
            <p className="text-sm text-gray-400">All logged maintenance events across your fleet</p>
          </div>
          {logs.length === 0 ? (
            <div className="p-16 text-center">
              <History className="w-12 h-12 text-gray-700 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No service history yet</p>
              <p className="text-gray-600 text-sm mt-1">
                Mark a prediction as serviced to begin building your maintenance log.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800">
                    {['Vehicle', 'Service', 'Date', 'Odometer', 'Cost (₹)', 'Notes'].map(col => (
                      <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {logs.map(log => {
                    const vehicle = vehicleMap[log.vehicle_id];
                    const label   = SERVICE_LABELS[log.service_type] ?? log.service_type;
                    return (
                      <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-white text-sm font-medium">{vehicle?.name ?? '—'}</p>
                          {vehicle && (
                            <p className="text-gray-600 text-xs">{vehicle.make} {vehicle.model}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{label}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{formatDate(log.service_date)}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">{formatKm(log.odometer_km)}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">
                          {log.cost != null ? `₹${log.cost.toLocaleString('en-IN')}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                          {log.notes ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
