import { useState, useEffect, useCallback } from 'react';
import { QrCode, UserPlus, Trash2, RefreshCw, Users, Car } from 'lucide-react';
import { supabase, type Vehicle } from '../lib/supabase';
import VehicleCard from '../components/VehicleCard';
import InviteDriverModal from '../components/InviteDriverModal';
import CreateDriverModal from '../components/CreateDriverModal';

interface DriverAccount {
  id: string;
  user_id: string;
  fleet_id: string;
  vehicle_id: string | null;
  name: string;
  phone: string;
  email: string;
  created_at: string;
  vehicles?: { id: string; name: string; vin: string } | null;
}

interface VehiclesPageProps {
  onSelectVehicle: (vehicle: Vehicle) => void;
}

export default function VehiclesPage({ onSelectVehicle }: VehiclesPageProps) {
  const [vehicles,          setVehicles]          = useState<Vehicle[]>([]);
  const [drivers,           setDrivers]           = useState<DriverAccount[]>([]);
  const [fleetId,           setFleetId]           = useState<string | null>(null);
  const [loading,           setLoading]           = useState(true);
  const [refreshing,        setRefreshing]        = useState(false);
  const [showInviteModal,   setShowInviteModal]   = useState(false);
  const [showDriverModal,   setShowDriverModal]   = useState(false);
  const [deletingDriver,    setDeletingDriver]    = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Get fleet
      const { data: fleet, error: fleetErr } = await supabase
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id)
        .single();

      if (fleetErr) throw fleetErr;
      setFleetId(fleet.id);

      // Get vehicles
      const { data: vehiclesData, error: vehiclesErr } = await supabase
        .from('vehicles')
        .select('*')
        .eq('fleet_id', fleet.id)
        .order('created_at', { ascending: false });

      if (vehiclesErr) throw vehiclesErr;
      if (vehiclesData) setVehicles(vehiclesData);

      // Get driver accounts
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/driver-management?action=list`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
          }
        );
        if (res.ok) {
          const data = await res.json();
          setDrivers(data);
        }
      }
    } catch (e) {
      console.error('Error loading vehicles/drivers:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  const handleDeleteVehicle = async (id: string) => {
    if (!confirm('Delete this vehicle? This cannot be undone.')) return;
    const { error } = await supabase.from('vehicles').delete().eq('id', id);
    if (!error) setVehicles(v => v.filter(x => x.id !== id));
  };

  const handleDeleteDriver = async (driverId: string) => {
    if (!confirm('Delete this driver account? They will no longer be able to log in.')) return;
    setDeletingDriver(driverId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/driver-management`,
        {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            Authorization:   `Bearer ${session.access_token}`,
            apikey:          import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ action: 'delete', driver_id: driverId }),
        }
      );
      if (res.ok) setDrivers(d => d.filter(x => x.id !== driverId));
    } catch (e) {
      console.error('Error deleting driver:', e);
    } finally {
      setDeletingDriver(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1">Vehicles & Drivers</h1>
          <p className="text-gray-400 text-sm">
            Use <span className="text-blue-400 font-medium">QR Invite</span> when the driver knows the vehicle details,
            or <span className="text-green-400 font-medium">Create Driver</span> to set up persistent login credentials.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {fleetId && (
            <>
              <button
                onClick={() => setShowInviteModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm font-medium transition-colors"
              >
                <QrCode className="w-4 h-4" />
                QR Invite
              </button>
              <button
                onClick={() => setShowDriverModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white text-sm font-medium transition-colors"
              >
                <UserPlus className="w-4 h-4" />
                Create Driver
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Vehicles grid ─────────────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <Car className="w-5 h-5 text-blue-400" />
          Fleet Vehicles
          {vehicles.length > 0 && (
            <span className="text-sm font-normal text-gray-500">({vehicles.length})</span>
          )}
        </h2>

        {vehicles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/40 px-6 py-12 text-center">
            <QrCode className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-400 font-medium mb-1">No vehicles yet</p>
            <p className="text-gray-600 text-sm">
              Click <span className="text-blue-400">QR Invite</span> to add your first vehicle.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {vehicles.map(vehicle => (
              <VehicleCard
                key={vehicle.id}
                vehicle={vehicle}
                onClick={() => onSelectVehicle(vehicle)}
                onDelete={() => handleDeleteVehicle(vehicle.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Driver accounts ───────────────────────────────────────────── */}
      <div>
        <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
          <Users className="w-5 h-5 text-green-400" />
          Driver Accounts
          {drivers.length > 0 && (
            <span className="text-sm font-normal text-gray-500">({drivers.length})</span>
          )}
        </h2>

        {drivers.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-6 py-8 text-center">
            <p className="text-gray-500 text-sm">
              No driver accounts yet. Click <span className="text-green-400">Create Driver</span> to add one.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {drivers.map(driver => (
              <div
                key={driver.id}
                className="flex items-center justify-between px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-white font-medium truncate">{driver.name || '—'}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                    {driver.email && (
                      <span className="text-xs text-gray-400">{driver.email}</span>
                    )}
                    {driver.phone && (
                      <span className="text-xs text-gray-500">{driver.phone}</span>
                    )}
                    {driver.vehicles && (
                      <span className="text-xs text-blue-400">
                        {driver.vehicles.name}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteDriver(driver.id)}
                  disabled={deletingDriver === driver.id}
                  className="ml-3 flex-shrink-0 p-1.5 rounded-lg text-red-500 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                  title="Delete driver"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Modals ────────────────────────────────────────────────────── */}
      {showInviteModal && fleetId && (
        <InviteDriverModal
          fleetId={fleetId}
          onClose={() => setShowInviteModal(false)}
          onVehicleCreated={() => { loadAll(); setShowInviteModal(false); }}
        />
      )}

      {showDriverModal && fleetId && (
        <CreateDriverModal
          fleetId={fleetId}
          vehicles={vehicles}
          onClose={() => setShowDriverModal(false)}
          onDriverCreated={loadAll}
        />
      )}
    </div>
  );
}
