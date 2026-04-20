import { useState, useEffect, useCallback, useRef } from 'react';
import { UserPlus, Trash2, RefreshCw, Users, Car, PlusCircle, CheckCircle,
         Clock, QrCode, Copy, Check, Download, Share2, RefreshCcw, X, AlertTriangle } from 'lucide-react';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { supabase, type Vehicle } from '../lib/supabase';
import VehicleCard from '../components/VehicleCard';
import CreateDriverModal from '../components/CreateDriverModal';
import PendingInvitationsPanel from '../components/PendingInvitationsPanel';
import AddVehicleModal from '../components/AddVehicleModal';
import { useSubscription } from '../hooks/useSubscription';

interface DriverAccount {
  id: string;
  user_id: string;
  fleet_id: string;
  vehicle_id: string | null;
  name: string;
  phone: string;
  email: string;
  created_at: string;
  first_login_at:           string | null;
  one_time_login_token:     string | null;
  one_time_login_token_exp: string | null;
  vehicles?: { id: string; name: string; vin: string } | null;
}

interface VehiclesPageProps {
  onSelectVehicle: (vehicle: Vehicle) => void;
  onNavigate?: (page: import('../App').Page) => void;
}

export default function VehiclesPage({ onSelectVehicle, onNavigate }: VehiclesPageProps) {
  const { driverLimit } = useSubscription();

  const [vehicles,          setVehicles]          = useState<Vehicle[]>([]);
  const [drivers,           setDrivers]           = useState<DriverAccount[]>([]);
  const [fleetId,           setFleetId]           = useState<string | null>(null);
  const [loading,           setLoading]           = useState(true);
  const [refreshing,        setRefreshing]        = useState(false);
  const [showDriverModal,   setShowDriverModal]   = useState(false);
  const [showAddVehicle,    setShowAddVehicle]    = useState(false);   // WEB-1
  const [deletingDriver,    setDeletingDriver]    = useState<string | null>(null);
  const [resendToken,       setResendToken]       = useState<string | null>(null);
  const [credDriver,        setCredDriver]        = useState<DriverAccount | null>(null);
  const [regenLoading,      setRegenLoading]      = useState(false);
  const [copiedCredLink,    setCopiedCredLink]    = useState(false);
  const [deleteError,       setDeleteError]       = useState('');
  const credQrRef = useRef<HTMLCanvasElement>(null);

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

      // List drivers directly via DB — no edge function, no JWT issues
      const { data: driversData } = await supabase
        .from('driver_accounts')
        .select('*, vehicles(id, name, vin, make, model)')
        .eq('fleet_id', fleet.id)
        .order('created_at', { ascending: false });
      if (driversData) setDrivers(driversData);
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
    try {
      const { error } = await supabase.from('vehicles').delete().eq('id', id);
      if (error) { setDeleteError(`Failed to delete vehicle: ${error.message}`); return; }
      setVehicles(v => v.filter(x => x.id !== id));
      setDeleteError('');
    } catch (e: any) {
      setDeleteError(`Unexpected error: ${e?.message ?? 'please try again'}`);
    }
  };

  const handleDeleteDriver = async (driverId: string) => {
    if (!confirm('Delete this driver account? They will no longer be able to log in.')) return;
    setDeletingDriver(driverId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token ?? null;
      if (!accessToken) return;
      const { error: fnErr } = await supabase.functions.invoke('driver-management', {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: { action: 'delete', driver_id: driverId },
      });
      if (!fnErr) setDrivers(d => d.filter(x => x.id !== driverId));
    } catch (e) {
      console.error('Error deleting driver:', e);
    } finally {
      setDeletingDriver(null);
    }
  };

  const handleRegenerateToken = async (driver: DriverAccount) => {
    setRegenLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token ?? null;
      if (!accessToken) return;
      const { data, error: fnErr } = await supabase.functions.invoke('driver-management', {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: { action: 'regenerate_token', driver_id: driver.id },
      });
      if (fnErr) { console.error('Regenerate token error', fnErr); return; }
      // Update driver in local state + refresh credentials modal
      const updated = { ...driver, one_time_login_token: data.one_time_token,
        one_time_login_token_exp: new Date(Date.now() + 7*24*60*60*1000).toISOString() };
      setDrivers(prev => prev.map(d => d.id === driver.id ? updated : d));
      setCredDriver(updated);
    } finally {
      setRegenLoading(false);
    }
  };

  const downloadCredQr = (driverName: string) => {
    const canvas = credQrRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `vehiclesense-qr-${driverName.replace(/\s+/g, '-').toLowerCase()}.png`;
    a.click();
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

      {/* Delete error banner */}
      {deleteError && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {deleteError}
        </div>
      )}

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
        <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2 flex-wrap">
          <Users className="w-5 h-5 text-green-400" />
          Driver Accounts
          {drivers.length > 0 && (
            <span className="text-sm font-normal text-gray-500">({drivers.length})</span>
          )}
          {/* Driver usage vs. plan limit */}
          {driverLimit > 0 && (
            <span className={`ml-auto text-xs font-medium px-2.5 py-1 rounded-full ${
              drivers.length >= driverLimit
                ? 'bg-red-900/40 text-red-400 border border-red-800/50'
                : drivers.length >= driverLimit * 0.8
                ? 'bg-yellow-900/40 text-yellow-400 border border-yellow-800/50'
                : 'bg-gray-800 text-gray-400 border border-gray-700'
            }`}>
              {drivers.length} / {driverLimit} drivers
            </span>
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
                <div className="ml-3 flex-shrink-0 flex items-center gap-1">
                  {/* Show credentials button — only for drivers awaiting first login */}
                  {!driver.first_login_at && (
                    <button
                      onClick={() => setCredDriver(driver)}
                      className="p-1.5 rounded-lg text-yellow-400 hover:bg-yellow-900/30 transition-colors"
                      title="View credentials & QR code"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteDriver(driver.id)}
                    disabled={deletingDriver === driver.id}
                    className="p-1.5 rounded-lg text-red-500 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                    title="Delete driver"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
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
          onNavigateToAdmin={() => onNavigate?.('admin')}
        />
      )}

      {showDriverModal && fleetId && (
        <CreateDriverModal
          fleetId={fleetId}
          onClose={() => setShowDriverModal(false)}
          onDriverCreated={loadAll}
          onNavigateToAdmin={() => onNavigate?.('admin')}
        />
      )}

      {/* ── Driver Credentials & QR modal ────────────────────────────── */}
      {credDriver && (() => {
        const token     = credDriver.one_time_login_token;
        const expiry    = credDriver.one_time_login_token_exp;
        const isExpired = !token || (expiry ? new Date(expiry) < new Date() : true);
        const deepLink  = token ? `vehiclesense://auth?token=${token}` : '';
        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-6 space-y-4">

              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">Driver Credentials</h2>
                  <p className="text-sm text-gray-400 mt-0.5">{credDriver.name}</p>
                </div>
                <button onClick={() => { setCredDriver(null); setCopiedCredLink(false); }}
                  className="text-gray-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Email */}
              <div className="bg-gray-800 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-500 mb-0.5">Email</p>
                <p className="text-white text-sm font-mono">{credDriver.email}</p>
              </div>

              {/* QR section */}
              {isExpired ? (
                <div className="bg-gray-800 rounded-xl p-4 text-center space-y-3">
                  <p className="text-yellow-400 text-sm font-medium">QR code has expired or been used</p>
                  <p className="text-gray-500 text-xs">Generate a new one-time login QR for this driver.</p>
                  <button
                    onClick={() => handleRegenerateToken(credDriver)}
                    disabled={regenLoading}
                    className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    <RefreshCcw className={`w-4 h-4 ${regenLoading ? 'animate-spin' : ''}`} />
                    {regenLoading ? 'Generating…' : 'Generate New QR'}
                  </button>
                </div>
              ) : (
                <div className="bg-gray-800 rounded-xl p-4 space-y-3">
                  <div>
                    <p className="text-sm font-medium text-white">Login QR Code</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Valid until {new Date(expiry!).toLocaleDateString()} · one-time use
                    </p>
                  </div>
                  {/* QR code */}
                  <div className="flex justify-center">
                    <div className="bg-white p-3 rounded-xl inline-block">
                      <QRCodeCanvas
                        ref={credQrRef}
                        value={deepLink}
                        size={180}
                        bgColor="#ffffff"
                        fgColor="#000000"
                        level="M"
                      />
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(deepLink);
                        setCopiedCredLink(true);
                        setTimeout(() => setCopiedCredLink(false), 2000);
                      }}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium transition-colors"
                    >
                      {copiedCredLink
                        ? <><Check className="w-3.5 h-3.5 text-green-400" /> Copied</>
                        : <><Share2 className="w-3.5 h-3.5" /> Copy Link</>}
                    </button>
                    <button
                      onClick={() => downloadCredQr(credDriver.name)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" /> Download QR
                    </button>
                  </div>
                  {/* Regenerate option */}
                  <button
                    onClick={() => handleRegenerateToken(credDriver)}
                    disabled={regenLoading}
                    className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-gray-500 hover:text-gray-300 text-xs transition-colors disabled:opacity-50"
                  >
                    <RefreshCcw className={`w-3 h-3 ${regenLoading ? 'animate-spin' : ''}`} />
                    Regenerate QR
                  </button>
                </div>
              )}

              <button
                onClick={() => { setCredDriver(null); setCopiedCredLink(false); }}
                className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        );
      })()}

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
