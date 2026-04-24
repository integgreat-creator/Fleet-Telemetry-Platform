import { useState } from 'react';
import { X, Car, Loader, Check, Lock, ArrowRight } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
  fleetId: string;
  onClose: () => void;
  onVehicleAdded: () => void;
  onNavigateToAdmin?: () => void; // called when user clicks "Upgrade Plan"
}

const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'ev'] as const;

// Returned by check_vehicle_limit()
interface LimitCheck {
  allowed: boolean;
  reason?: string;
  limit?: number;
  used?: number;
  plan?: string;
}

const PLAN_DISPLAY: Record<string, string> = {
  trial:        'Trial',
  essential:    'Essential',
  professional: 'Professional',
  business:     'Business',
  enterprise:   'Enterprise',
  // Legacy plan names retained as fallbacks for existing rows
  starter:      'Starter',
  growth:       'Growth',
  pro:          'Pro',
};

export default function AddVehicleModal({ fleetId, onClose, onVehicleAdded, onNavigateToAdmin }: Props) {
  const [name,         setName]         = useState('');
  const [vin,          setVin]          = useState('');
  const [make,         setMake]         = useState('');
  const [model,        setModel]        = useState('');
  const [year,         setYear]         = useState('');
  const [fuelType,     setFuelType]     = useState<string>('petrol');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [created,      setCreated]      = useState(false);
  const [limitBlocked, setLimitBlocked] = useState<LimitCheck | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setLimitBlocked(null);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // ── Check vehicle limit before attempting insert ──────────────────────
      const { data: limitData, error: limitErr } = await supabase
        .rpc('check_vehicle_limit', { p_fleet_id: fleetId });

      // If the RPC errors (not deployed yet) skip the limit check — the DB
      // constraint will still block over-quota inserts server-side.
      if (!limitErr && limitData) {
        const check = limitData as LimitCheck;
        // Only block on a real limit hit (has used/limit counts) — not on
        // "no subscription found" which just means the subscription trigger
        // hasn't run yet on this fresh fleet.
        const isRealLimit = !check.allowed && check.used != null && check.limit != null;
        if (isRealLimit) {
          setLimitBlocked(check);
          return;
        }
      }

      // ── Limit OK — proceed with insert ────────────────────────────────────
      const { error: insertErr } = await supabase.from('vehicles').insert({
        name:      name.trim(),
        vin:       vin.trim().toUpperCase() || null,
        make:      make.trim() || null,
        model:     model.trim() || null,
        year:      year ? parseInt(year) : null,
        fuel_type: fuelType,
        fleet_id:  fleetId,
        owner_id:  user.id,
        is_active: true,
      });

      if (insertErr) {
        if (insertErr.message.includes('unique') || insertErr.message.includes('duplicate')) {
          throw new Error('A vehicle with this VIN already exists in your fleet');
        }
        throw new Error(insertErr.message);
      }

      setCreated(true);
      onVehicleAdded();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to add vehicle');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 space-y-5 max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Pre-register Vehicle</h2>
            <p className="text-sm text-gray-400 mt-0.5">
              Vehicle will appear on the dashboard immediately
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Vehicle limit reached ── */}
        {limitBlocked ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="w-14 h-14 rounded-full bg-yellow-500/15 flex items-center justify-center">
              <Lock className="w-7 h-7 text-yellow-400" />
            </div>

            <div>
              <p className="text-white font-semibold text-base mb-1">Vehicle Limit Reached</p>
              <p className="text-gray-400 text-sm leading-relaxed">
                {limitBlocked.reason}
              </p>
            </div>

            {/* Usage bar */}
            {limitBlocked.limit != null && limitBlocked.used != null && (
              <div className="w-full bg-gray-800 rounded-xl p-4 space-y-2">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>Vehicles used</span>
                  <span className="text-red-400 font-semibold">
                    {limitBlocked.used} / {limitBlocked.limit}
                  </span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-2">
                  <div
                    className="h-2 rounded-full bg-red-500"
                    style={{ width: '100%' }}
                  />
                </div>
                {limitBlocked.plan && (
                  <p className="text-xs text-gray-500 pt-1">
                    Current plan:{' '}
                    <span className="text-gray-300 font-medium">
                      {PLAN_DISPLAY[limitBlocked.plan] ?? limitBlocked.plan}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="w-full space-y-2 pt-1">
              {/* Upgrade CTA */}
              <button
                onClick={() => {
                  onClose();
                  onNavigateToAdmin?.();
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
              >
                Upgrade Plan
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

        /* ── Success ── */
        ) : created ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
              <Check className="w-7 h-7 text-green-400" />
            </div>
            <p className="text-white font-semibold text-lg">Vehicle Added!</p>
            <p className="text-gray-400 text-sm text-center">
              <span className="text-white font-medium">{name}</span> is now visible on your fleet dashboard.
              It will link automatically when a driver connects their OBD adapter.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
            >
              Done
            </button>
          </div>

        /* ── Form ── */
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Vehicle Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">
                Vehicle Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Truck 04, Delivery Van"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-500">Friendly name shown on the dashboard</p>
            </div>

            {/* VIN */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-300">VIN (optional)</label>
              <input
                type="text"
                value={vin}
                onChange={e => setVin(e.target.value.toUpperCase())}
                placeholder="e.g. MA1AB2CD3EF456789"
                maxLength={17}
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-500">
                If provided, the OBD connection will automatically match this vehicle
              </p>
            </div>

            {/* Make + Model */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-300">Make</label>
                <input
                  type="text"
                  value={make}
                  onChange={e => setMake(e.target.value)}
                  placeholder="e.g. Tata"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-300">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder="e.g. Ace"
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* Year + Fuel */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-300">Year</label>
                <input
                  type="number"
                  value={year}
                  onChange={e => setYear(e.target.value)}
                  placeholder="e.g. 2022"
                  min={1990}
                  max={new Date().getFullYear() + 1}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-300">Fuel Type</label>
                <select
                  value={fuelType}
                  onChange={e => setFuelType(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
                >
                  {FUEL_TYPES.map(ft => (
                    <option key={ft} value={ft}>
                      {ft.charAt(0).toUpperCase() + ft.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-red-900/20 border border-red-700/40 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {loading ? <Loader className="w-4 h-4 animate-spin" /> : <Car className="w-4 h-4" />}
                {loading ? 'Checking…' : 'Add Vehicle'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
