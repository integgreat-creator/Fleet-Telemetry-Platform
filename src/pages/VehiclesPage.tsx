import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Trash2, RefreshCw, Users, Car, PlusCircle, CheckCircle, Clock } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase, type Vehicle } from '../lib/supabase';
import VehicleCard from '../components/VehicleCard';
import CreateDriverModal from '../components/CreateDriverModal';
import PendingInvitationsPanel from '../components/PendingInvitationsPanel';
import AddVehicleModal from '../components/AddVehicleModal';

interface DriverAccount {
  id: string;
  user_id: string;
  fleet_id: string;
  vehicle_id: string | null;
  name: string;
  phone: string;
  email: string;
  created_at: string;
  first_login_at: string | null;   // WEB-2: null = never logged in
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
  const [showDriverModal,   setShowDriverModal]   = useState(false);
  const [showAddVehicle,    setShowAddVehicle]    = useState(false);   // WEB-1
  const [deletingDriver,    setDeletingDriver]    = useState<string | null>(null);
  const [resendToken,       setResendToken]       = useState<string | null>(null);

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

      // Get driver accounts via invoke() — handles auth internally, no stale JWT
      const { data: driversData } = await supabase.functions.invoke('driver-management', {
        method: 'GET',
      });
      if (Array.isArray(driversData)) setDrivers(driversData);
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
      const { error: fnErr } = await supabase.functions.invoke('driver-management', {
        body: { action: 'delete', driver_id: driverId },
      });
      if (!fnErr) setDrivers(d => d.filter(x => x.id !== driverId));
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
            Use <span className="text-green-400 font-medium">Create Driver</span> to set up login credentials —
            the driver will receive a welcome email with their credentials and a one-time QR code.
            Vehicles are registered automatically when a driver connects their OBD adapter.
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
              {/* WEB-1: Pre-register a vehicle without waiting for a driver */}
              <button
                onClick={() => setShowAddVehicle(true)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-lg text-gray-200 text-sm font-medium transition-colors"
              >
                <PlusCircle className="w-4 h-4" />
                Add Vehicle
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

      {/* ── Pending Invitations ───────────────────────────────────────── */}
      {fleetId && (
        <PendingInvitationsPanel
          fleetId={fleetId}
          onResendQR={(token, _vehicleName, _driverPhone) => {
            setResendToken(token);
          }}
        />
      )}

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
            <Car className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-400 font-medium mb-1">No vehicles yet</p>
            <p className="text-gray-600 text-sm max-w-sm mx-auto">
              Click <span className="text-gray-300 font-medium">Add Vehicle</span> to pre-register a vehicle,
              or click <span className="text-green-400 font-medium">Create Driver</span> to add a driver —
              vehicles appear automatically once a driver connects their OBD adapter.
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-white font-medium truncate">{driver.name || '—'}</p>
                    {/* WEB-2: Onboarding status badge */}
                    {driver.first_login_at ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/40 text-green-400 border border-green-800/50">
                        <CheckCircle className="w-3 h-3" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-900/40 text-yellow-400 border border-yellow-800/50">
                        <Clock className="w-3 h-3" />
                        Awaiting first login
                      </span>
                    )}
                  </div>
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
      {/* WEB-1: Vehicle pre-registration modal */}
      {showAddVehicle && fleetId && (
        <AddVehicleModal
          fleetId={fleetId}
          onClose={() => setShowAddVehicle(false)}
          onVehicleAdded={() => { loadAll(); setShowAddVehicle(false); }}
        />
      )}

      {showDriverModal && fleetId && (
        <CreateDriverModal
          fleetId={fleetId}
          onClose={() => setShowDriverModal(false)}
          onDriverCreated={loadAll}
        />
      )}

      {/* ── Resend QR modal ───────────────────────────────────────────── */}
      {resendToken && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="bg-gray-800 rounded-xl p-8 max-w-sm w-full mx-4">
            <h3 className="text-white font-bold text-lg mb-4 text-center">Resend Invite QR</h3>
            <div className="flex justify-center mb-4">
              <QRCodeSVG value={`vehiclesense://join?token=${resendToken}`} size={200} />
            </div>
            <p className="text-gray-400 text-sm text-center mb-4 break-all">
              vehiclesense://join?token={resendToken}
            </p>
            <button
              onClick={() => { navigator.clipboard.writeText(`vehiclesense://join?token=${resendToken}`); }}
              className="w-full bg-teal-600 hover:bg-teal-500 text-white py-2 rounded-lg mb-2"
            >
              Copy Link
            </button>
            <button
              onClick={() => setResendToken(null)}
              className="w-full bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
