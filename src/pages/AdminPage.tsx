import { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  Users,
  CreditCard,
  Shield,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Eye,
  Trash2,
  Crown,
  Key,
  Fuel,
  Save,
  Loader,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSubscription } from '../hooks/useSubscription';
import ApiAccessTab from '../components/ApiAccessTab';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  fleet_id: string;
  plan: 'trial' | 'starter' | 'growth' | 'pro' | 'enterprise';
  status: 'active' | 'inactive' | 'suspended' | 'trial' | 'expired';
  max_vehicles: number;
  max_drivers: number;
  features: Record<string, unknown>;
  razorpay_subscription_id?: string;
  current_period_start?: string;
  current_period_end?: string;
  trial_ends_at?: string;
  grace_period_end?: string;
  created_at: string;
  updated_at: string;
}

interface DriverAccount {
  id: string;
  user_id: string;
  fleet_id: string;
  vehicle_id?: string;
  name?: string;
  phone?: string;
  email?: string;
  created_at: string;
  vehicles?: { id: string; name: string; vin: string; make: string; model: string } | null;
}

interface AuditLog {
  id: string;
  user_id?: string;
  fleet_id?: string;
  vehicle_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  old_values?: Record<string, unknown>;
  new_values?: Record<string, unknown>;
  ip_address?: string;
  created_at: string;
}

interface DeviceHealth {
  id: string;
  vehicle_id: string;
  device_type: 'obd2' | 'esp32' | 'gps' | 'sim';
  device_id?: string;
  firmware_version?: string;
  signal_strength?: number;
  battery_level?: number;
  last_ping_at: string;
  is_online: boolean;
  error_code?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
  vehicles?: { id: string; name: string; vin: string } | null;
}

type Tab = 'subscription' | 'drivers' | 'audit' | 'device-health' | 'api-access' | 'settings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ts?: string | null): string {
  if (!ts) return '—';
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const abs  = Math.abs(diff);
    const past = diff >= 0;
    const fmt  = (n: number, unit: string) =>
      past ? `${n} ${unit}${n !== 1 ? 's' : ''} ago` : `in ${n} ${unit}${n !== 1 ? 's' : ''}`;
    if (abs < 60_000)         return fmt(Math.round(abs / 1_000),         'second');
    if (abs < 3_600_000)      return fmt(Math.round(abs / 60_000),         'minute');
    if (abs < 86_400_000)     return fmt(Math.round(abs / 3_600_000),      'hour');
    if (abs < 2_592_000_000)  return fmt(Math.round(abs / 86_400_000),     'day');
    if (abs < 31_536_000_000) return fmt(Math.round(abs / 2_592_000_000),  'month');
    return fmt(Math.round(abs / 31_536_000_000), 'year');
  } catch {
    return ts;
  }
}

function truncateId(id?: string | null): string {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function summariseChanges(obj?: Record<string, unknown> | null): string {
  if (!obj) return '—';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '—';
  return keys
    .slice(0, 3)
    .map(k => `${k}: ${String(obj[k]).slice(0, 20)}`)
    .join(', ') + (keys.length > 3 ? ` +${keys.length - 3} more` : '');
}

// ─── Plan Badge ───────────────────────────────────────────────────────────────

function PlanBadge({ plan }: { plan: Subscription['plan'] }) {
  const styles: Record<Subscription['plan'], string> = {
    trial:      'bg-gray-700 text-gray-300',
    starter:    'bg-blue-900 text-blue-300',
    growth:     'bg-teal-900 text-teal-300',
    pro:        'bg-purple-900 text-purple-300',
    enterprise: 'bg-yellow-900 text-yellow-300',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${styles[plan]}`}>
      {plan === 'enterprise' && <Crown size={11} />}
      {plan}
    </span>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Subscription['status'] }) {
  const cfg: Record<Subscription['status'], { cls: string; icon: React.ReactNode }> = {
    active:    { cls: 'bg-green-900 text-green-300',   icon: <CheckCircle size={11} /> },
    trial:     { cls: 'bg-yellow-900 text-yellow-300', icon: <Clock size={11} /> },
    suspended: { cls: 'bg-red-900 text-red-300',       icon: <XCircle size={11} /> },
    inactive:  { cls: 'bg-gray-700 text-gray-400',     icon: <XCircle size={11} /> },
    expired:   { cls: 'bg-orange-900 text-orange-300', icon: <AlertTriangle size={11} /> },
  };
  const { cls, icon } = cfg[status] ?? cfg.inactive;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {icon}
      {status}
    </span>
  );
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

function UsageBar({ current, max, label }: { current: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  const color =
    pct >= 90 ? 'bg-red-500' :
    pct >= 70 ? 'bg-yellow-500' :
    'bg-blue-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{label}</span>
        <span className={pct >= 90 ? 'text-red-400 font-semibold' : ''}>
          {current} / {max === 9999 ? '∞' : max}
        </span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Signal Strength Bar ──────────────────────────────────────────────────────

function SignalBar({ dBm }: { dBm?: number | null }) {
  if (dBm == null) return <span className="text-gray-500 text-xs">N/A</span>;
  const normalized = Math.max(0, Math.min(100, ((dBm + 100) / 100) * 100));
  const color = dBm > -70 ? 'bg-green-500' : dBm > -85 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="space-y-0.5">
      <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${normalized}%` }} />
      </div>
      <span className="text-xs text-gray-400">{dBm} dBm</span>
    </div>
  );
}

// ─── Battery Bar ──────────────────────────────────────────────────────────────

function BatteryBar({ level }: { level?: number | null }) {
  if (level == null) return <span className="text-gray-500 text-xs">N/A</span>;
  const color = level > 50 ? 'bg-green-500' : level > 20 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="space-y-0.5">
      <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${level}%` }} />
      </div>
      <span className="text-xs text-gray-400">{level.toFixed(0)}%</span>
    </div>
  );
}

// ─── Device Type Badge ────────────────────────────────────────────────────────

function DeviceTypeBadge({ type }: { type: DeviceHealth['device_type'] }) {
  const styles: Record<DeviceHealth['device_type'], string> = {
    obd2:  'bg-blue-900 text-blue-300',
    esp32: 'bg-teal-900 text-teal-300',
    gps:   'bg-indigo-900 text-indigo-300',
    sim:   'bg-violet-900 text-violet-300',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${styles[type]}`}>
      {type}
    </span>
  );
}

// ─── WhatsApp Number Field ────────────────────────────────────────────────────

function WhatsAppNumberField({ fleetId }: { fleetId: string | null }) {
  const [number, setNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  useEffect(() => {
    if (!fleetId) return;
    supabase.from('fleets').select('whatsapp_number').eq('id', fleetId).single()
      .then(({ data }) => { if (data?.whatsapp_number) setNumber(data.whatsapp_number); });
  }, [fleetId]);

  const handleSave = async () => {
    if (!fleetId) return;
    setSaving(true);
    await supabase.from('fleets').update({ whatsapp_number: number }).eq('id', fleetId);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="flex gap-2">
      <input
        type="tel"
        value={number}
        onChange={e => setNumber(e.target.value)}
        placeholder="+919876543210"
        className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-teal-500 placeholder-gray-500"
      />
      <button
        onClick={handleSave}
        disabled={saving || !number.trim()}
        className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors font-medium"
      >
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
      </button>
    </div>
  );
}

// ─── Plan Cards ───────────────────────────────────────────────────────────────

const PLAN_CARDS = [
  {
    plan: 'trial' as const,
    label: 'Trial',
    price: '₹0',
    period: '',
    vehicles: '2 vehicles',
    drivers: '3 drivers',
    features: ['Live tracking', 'Basic alerts', 'Trip history', '7-day history'],
    cta: null,
    highlight: false,
  },
  {
    plan: 'starter' as const,
    label: 'Starter',
    price: '₹999',
    period: '/mo',
    vehicles: '10 vehicles',
    drivers: '15 drivers',
    features: ['Everything in Trial', 'Fuel monitoring', 'Idle detection', '90-day history'],
    cta: 'Upgrade to Starter',
    highlight: false,
  },
  {
    plan: 'growth' as const,
    label: 'Growth',
    price: '₹1,999',
    period: '/mo',
    vehicles: '25 vehicles',
    drivers: '50 drivers',
    features: ['Everything in Starter', 'Driver behaviour', 'Cost analytics', 'Maintenance alerts', 'Multi-user access'],
    cta: 'Upgrade to Growth',
    highlight: true,
  },
  {
    plan: 'pro' as const,
    label: 'Pro',
    price: '₹3,999',
    period: '/mo',
    vehicles: '100 vehicles',
    drivers: 'Unlimited drivers',
    features: ['Everything in Growth', 'AI anomaly detection', 'Fuel theft alerts', 'API access', 'Custom reports'],
    cta: 'Upgrade to Pro',
    highlight: false,
  },
  {
    plan: 'enterprise' as const,
    label: 'Enterprise',
    price: 'Custom',
    period: '',
    vehicles: 'Unlimited vehicles',
    drivers: 'Unlimited drivers',
    features: ['Everything in Pro', 'Dedicated support', 'Custom integrations', 'SLA guarantee', 'On-premise option'],
    cta: 'Contact Sales',
    highlight: false,
  },
];

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminPage() {
  const { feature } = useSubscription();
  const hasApiAccess = feature('api_access') === 'full';

  const [activeTab, setActiveTab] = useState<Tab>('subscription');

  // ── Fuel price settings state ────────────────────────────────────────────
  const [fuelPriceInr,   setFuelPriceInr]   = useState('103.00');
  const [usdToInr,       setUsdToInr]       = useState('83.00');
  const [fuelSaving,     setFuelSaving]     = useState(false);
  const [fuelSavedMsg,   setFuelSavedMsg]   = useState('');
  const [fuelLoading,    setFuelLoading]    = useState(false);

  const loadFuelPrice = useCallback(async () => {
    setFuelLoading(true);
    try {
      const { data } = await supabase
        .from('fuel_price_config')
        .select('price_inr, usd_to_inr_rate')
        .eq('id', 1)
        .maybeSingle();
      if (data) {
        setFuelPriceInr(String(data.price_inr));
        setUsdToInr(String(data.usd_to_inr_rate));
      }
    } finally {
      setFuelLoading(false);
    }
  }, []);

  const saveFuelPrice = async () => {
    const inr  = parseFloat(fuelPriceInr);
    const rate = parseFloat(usdToInr);
    if (isNaN(inr) || isNaN(rate) || inr <= 0 || rate <= 0) return;
    setFuelSaving(true);
    setFuelSavedMsg('');
    try {
      await supabase
        .from('fuel_price_config')
        .update({
          price_inr:       inr,
          price_usd:       parseFloat((inr / rate).toFixed(4)),
          usd_to_inr_rate: rate,
          source:          'manual',
          updated_at:      new Date().toISOString(),
        })
        .eq('id', 1);
      setFuelSavedMsg('Fuel price updated — next predictions run will use this value.');
    } finally {
      setFuelSaving(false);
    }
  };

  // Subscription state
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [driverCount, setDriverCount] = useState(0);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  // Drivers state
  const [drivers, setDrivers] = useState<DriverAccount[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [deletingDriverId, setDeletingDriverId] = useState<string | null>(null);

  // Audit log state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState('');

  // Device health state
  const [deviceHealth, setDeviceHealth] = useState<DeviceHealth[]>([]);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Fleet context
  const [fleetId, setFleetId] = useState<string | null>(null);

  // ── Fetch fleet on mount ────────────────────────────────────────────────────

  useEffect(() => {
    const fetchFleet = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id)
        .single();
      if (data) setFleetId(data.id);
    };
    fetchFleet();
  }, []);

  // ── Load tab data when fleet or tab changes ─────────────────────────────────

  const loadSubscription = useCallback(async () => {
    if (!fleetId) return;
    setSubLoading(true);
    setSubError(null);
    try {
      const [subRes, vehicleRes, driverRes] = await Promise.all([
        supabase.from('subscriptions').select('*').eq('fleet_id', fleetId).single(),
        supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
        supabase.from('driver_accounts').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
      ]);
      if (subRes.error && subRes.error.code !== 'PGRST116') throw subRes.error;
      setSubscription(subRes.data ?? null);
      setVehicleCount(vehicleRes.count ?? 0);
      setDriverCount(driverRes.count ?? 0);
    } catch (e: any) {
      setSubError(e.message ?? 'Failed to load subscription');
    } finally {
      setSubLoading(false);
    }
  }, [fleetId]);

  const loadDrivers = useCallback(async () => {
    if (!fleetId) return;
    setDriversLoading(true);
    setDriversError(null);
    try {
      const { data, error } = await supabase
        .from('driver_accounts')
        .select('*, vehicles(id, name, vin, make, model)')
        .eq('fleet_id', fleetId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setDrivers(data ?? []);
    } catch (e: any) {
      setDriversError(e.message ?? 'Failed to load drivers');
    } finally {
      setDriversLoading(false);
    }
  }, [fleetId]);

  const loadAuditLogs = useCallback(async () => {
    if (!fleetId) return;
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('fleet_id', fleetId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setAuditLogs(data ?? []);
    } catch (e: any) {
      setAuditError(e.message ?? 'Failed to load audit logs');
    } finally {
      setAuditLoading(false);
    }
  }, [fleetId]);

  const loadDeviceHealth = useCallback(async () => {
    if (!fleetId) return;
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const { data: vehicles } = await supabase
        .from('vehicles')
        .select('id')
        .eq('fleet_id', fleetId);
      const vehicleIds = (vehicles ?? []).map((v: { id: string }) => v.id);
      if (vehicleIds.length === 0) {
        setDeviceHealth([]);
        return;
      }
      const { data, error } = await supabase
        .from('device_health')
        .select('*, vehicles(id, name, vin)')
        .in('vehicle_id', vehicleIds)
        .order('last_ping_at', { ascending: false });
      if (error) throw error;
      setDeviceHealth(data ?? []);
    } catch (e: any) {
      setDeviceError(e.message ?? 'Failed to load device health');
    } finally {
      setDeviceLoading(false);
    }
  }, [fleetId]);

  useEffect(() => {
    if (!fleetId) return;
    if (activeTab === 'subscription')  loadSubscription();
    if (activeTab === 'drivers')       loadDrivers();
    if (activeTab === 'audit')         loadAuditLogs();
    if (activeTab === 'device-health') loadDeviceHealth();
    if (activeTab === 'settings')      loadFuelPrice();
  }, [activeTab, fleetId, loadSubscription, loadDrivers, loadAuditLogs, loadDeviceHealth, loadFuelPrice]);

  // ── Delete driver ───────────────────────────────────────────────────────────

  const handleDeleteDriver = async (driver: DriverAccount) => {
    if (!confirm(`Delete driver "${driver.name || driver.email}"? This cannot be undone.`)) return;
    setDeletingDriverId(driver.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/driver-management`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ action: 'delete', driver_id: driver.id }),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Delete failed');
      setDrivers(prev => prev.filter(d => d.id !== driver.id));
    } catch (e: any) {
      alert(`Failed to delete driver: ${e.message}`);
    } finally {
      setDeletingDriverId(null);
    }
  };

  // ── Upgrade CTA ─────────────────────────────────────────────────────────────

  const handleUpgrade = (plan: string) => {
    if (plan === 'enterprise') {
      alert('Contact us at sales@vehiclesense.in to upgrade to Enterprise.');
    } else {
      alert(`Razorpay payment for ${plan} plan — contact sales@vehiclesense.in or integrate Razorpay Checkout to proceed.`);
    }
  };

  // ── Unique audit actions for filter ────────────────────────────────────────

  const uniqueActions = Array.from(new Set(auditLogs.map(l => l.action))).sort();
  const filteredLogs = auditActionFilter
    ? auditLogs.filter(l => l.action === auditActionFilter)
    : auditLogs;

  // ─── Tabs config ─────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: React.ReactNode; locked?: boolean }[] = [
    { id: 'subscription',  label: 'Subscription',   icon: <CreditCard size={15} /> },
    { id: 'drivers',       label: 'Drivers',         icon: <Users size={15} /> },
    { id: 'audit',         label: 'Audit Log',       icon: <Shield size={15} /> },
    { id: 'device-health', label: 'Device Health',   icon: <Settings size={15} /> },
    { id: 'api-access',    label: 'API Access',      icon: <Key size={15} />, locked: !hasApiAccess },
    { id: 'settings',      label: 'Settings',         icon: <Settings size={15} /> },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-lg bg-blue-500/20">
            <Settings className="text-blue-400" size={20} />
          </div>
          <h1 className="text-2xl font-bold text-white">Fleet Admin</h1>
        </div>
        <p className="text-gray-400 text-sm ml-11">Manage your fleet subscription, drivers, and compliance.</p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 mb-6 bg-gray-900 rounded-xl p-1 border border-gray-800 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => !tab.locked && setActiveTab(tab.id)}
            title={tab.locked ? 'Upgrade to Pro to unlock API Access' : undefined}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab.locked
                ? 'text-gray-600 cursor-not-allowed'
                : activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.locked && <Eye size={12} className="text-gray-600" />}
          </button>
        ))}
      </div>

      {/* ── Tab: Subscription ─────────────────────────────────────────────────── */}
      {activeTab === 'subscription' && (
        <div className="space-y-6">
          {subLoading && (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
            </div>
          )}
          {subError && (
            <div className="flex items-center gap-2 p-4 rounded-lg bg-red-900/30 border border-red-800 text-red-300">
              <AlertTriangle size={16} /> {subError}
            </div>
          )}

          {!subLoading && !subError && (
            <>
              {/* Current plan overview */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Current Plan</h2>
                {subscription ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <PlanBadge plan={subscription.plan} />
                      <StatusBadge status={subscription.status} />
                      {subscription.trial_ends_at && subscription.status === 'trial' && (
                        <span className="text-xs text-yellow-400 flex items-center gap-1">
                          <Clock size={12} /> Trial ends {relativeTime(subscription.trial_ends_at)}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <UsageBar current={vehicleCount} max={subscription.max_vehicles} label="Vehicles" />
                      <UsageBar current={driverCount}  max={subscription.max_drivers}  label="Drivers" />
                    </div>

                    {subscription.current_period_start && subscription.current_period_end && (
                      <div className="grid grid-cols-2 gap-4 pt-2 text-sm text-gray-400">
                        <div>
                          <span className="block text-xs text-gray-500 mb-0.5">Period start</span>
                          {new Date(subscription.current_period_start).toLocaleDateString()}
                        </div>
                        <div>
                          <span className="block text-xs text-gray-500 mb-0.5">Period end</span>
                          {new Date(subscription.current_period_end).toLocaleDateString()}
                        </div>
                      </div>
                    )}

                    {subscription.razorpay_subscription_id && (
                      <p className="text-xs text-gray-500 pt-1">
                        Razorpay ID: <span className="font-mono text-gray-400">{subscription.razorpay_subscription_id}</span>
                      </p>
                    )}

                    {/* Features / factors JSON */}
                    {subscription.features && Object.keys(subscription.features).length > 0 && (
                      <div className="pt-2 border-t border-gray-800">
                        <h3 className="text-xs text-gray-500 uppercase tracking-wide mb-2">Plan Features</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {Object.entries(subscription.features).map(([k, v]) => (
                            <div key={k} className="bg-gray-800 rounded-lg px-3 py-2">
                              <span className="block text-xs text-gray-400 mb-0.5 capitalize">{k.replace(/_/g, ' ')}</span>
                              <span className="text-sm text-white font-medium">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">No subscription found for this fleet.</p>
                )}
              </div>

              {/* WhatsApp Notification Number */}
              <div className="bg-gray-800 rounded-xl p-5">
                <h3 className="text-white font-semibold mb-1 flex items-center gap-2">
                  <span>📱</span> WhatsApp Alerts
                </h3>
                <p className="text-gray-400 text-sm mb-4">
                  Receive real-time alerts for device offline, unauthorized movement, and tampering events.
                </p>
                <WhatsAppNumberField fleetId={fleetId} />
              </div>

              {/* Plan cards */}
              <div>
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Available Plans</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                  {PLAN_CARDS.map(card => {
                    const isCurrent = subscription?.plan === card.plan;
                    return (
                      <div
                        key={card.plan}
                        className={`bg-gray-900 border rounded-xl p-5 flex flex-col gap-3 transition-all relative ${
                          isCurrent
                            ? 'border-blue-500 ring-1 ring-blue-500/40'
                            : card.highlight
                            ? 'border-teal-600/60 ring-1 ring-teal-600/20 hover:border-teal-500'
                            : 'border-gray-800 hover:border-gray-700'
                        }`}
                      >
                        {card.highlight && !isCurrent && (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 bg-teal-600 text-white text-[10px] font-bold rounded-full uppercase tracking-wide">
                            Popular
                          </span>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-white">{card.label}</span>
                          {isCurrent && (
                            <span className="text-xs text-blue-400 font-medium bg-blue-500/15 px-2 py-0.5 rounded-full">Current</span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-bold text-white">{card.price}</span>
                          {card.period && <span className="text-gray-400 text-sm">{card.period}</span>}
                        </div>
                        <div className="text-xs text-gray-400 space-y-0.5">
                          <p>{card.vehicles}</p>
                          <p>{card.drivers}</p>
                        </div>
                        <ul className="space-y-1 flex-1">
                          {card.features.map(f => (
                            <li key={f} className="flex items-center gap-1.5 text-xs text-gray-300">
                              <CheckCircle size={11} className="text-green-500 shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                        {card.cta && !isCurrent && (
                          <button
                            onClick={() => handleUpgrade(card.plan)}
                            className={`w-full py-2 rounded-lg text-sm font-medium transition-colors ${
                              card.plan === 'enterprise'
                                ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                                : card.plan === 'growth'
                                ? 'bg-teal-600 hover:bg-teal-500 text-white'
                                : card.plan === 'pro'
                                ? 'bg-purple-600 hover:bg-purple-500 text-white'
                                : 'bg-blue-600 hover:bg-blue-500 text-white'
                            }`}
                          >
                            {card.cta}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Drivers ──────────────────────────────────────────────────────── */}
      {activeTab === 'drivers' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Header row */}
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Drivers</h2>
              {subscription && (
                <p className="text-xs text-gray-400 mt-0.5">
                  {driverCount} / {subscription.max_drivers === 9999 ? '∞' : subscription.max_drivers} drivers used
                </p>
              )}
            </div>
            {driversLoading && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500" />
            )}
          </div>

          {driversError && (
            <div className="flex items-center gap-2 m-4 p-4 rounded-lg bg-red-900/30 border border-red-800 text-red-300">
              <AlertTriangle size={16} /> {driversError}
            </div>
          )}

          {!driversLoading && !driversError && drivers.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <Users size={40} className="mb-3 opacity-40" />
              <p className="font-medium">No drivers yet</p>
              <p className="text-sm mt-1">Create a driver or send an invite from the Drivers page.</p>
            </div>
          )}

          {!driversLoading && drivers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-800">
                    <th className="text-left px-6 py-3 font-medium">Name</th>
                    <th className="text-left px-6 py-3 font-medium">Email</th>
                    <th className="text-left px-6 py-3 font-medium">Phone</th>
                    <th className="text-left px-6 py-3 font-medium">Assigned Vehicle</th>
                    <th className="text-left px-6 py-3 font-medium">Created</th>
                    <th className="text-left px-6 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {drivers.map(driver => (
                    <tr key={driver.id} className="hover:bg-gray-800/40 transition-colors">
                      <td className="px-6 py-3 font-medium text-white">
                        {driver.name || <span className="text-gray-500 italic">—</span>}
                      </td>
                      <td className="px-6 py-3 text-gray-300">
                        {driver.email || <span className="text-gray-500">—</span>}
                      </td>
                      <td className="px-6 py-3 text-gray-300">
                        {driver.phone || <span className="text-gray-500">—</span>}
                      </td>
                      <td className="px-6 py-3 text-gray-300">
                        {driver.vehicles
                          ? <span>{driver.vehicles.name} <span className="text-gray-500 text-xs">({driver.vehicles.vin})</span></span>
                          : <span className="text-gray-500">Unassigned</span>}
                      </td>
                      <td className="px-6 py-3 text-gray-400 text-xs">
                        {relativeTime(driver.created_at)}
                      </td>
                      <td className="px-6 py-3">
                        <button
                          onClick={() => handleDeleteDriver(driver)}
                          disabled={deletingDriverId === driver.id}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                          title="Delete driver"
                        >
                          {deletingDriverId === driver.id
                            ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-400" />
                            : <Trash2 size={15} />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Audit Log ────────────────────────────────────────────────────── */}
      {activeTab === 'audit' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-wrap gap-3">
            <h2 className="font-semibold text-white">Audit Log</h2>
            <div className="flex items-center gap-3">
              {auditLoading && (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500" />
              )}
              <select
                value={auditActionFilter}
                onChange={e => setAuditActionFilter(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-blue-500"
              >
                <option value="">All actions</option>
                {uniqueActions.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          {auditError && (
            <div className="flex items-center gap-2 m-4 p-4 rounded-lg bg-red-900/30 border border-red-800 text-red-300">
              <AlertTriangle size={16} /> {auditError}
            </div>
          )}

          {!auditLoading && !auditError && filteredLogs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <Shield size={40} className="mb-3 opacity-40" />
              <p className="font-medium">No audit records found</p>
              <p className="text-sm mt-1">Actions taken in this fleet will appear here.</p>
            </div>
          )}

          {!auditLoading && filteredLogs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-800">
                    <th className="text-left px-6 py-3 font-medium">Time</th>
                    <th className="text-left px-6 py-3 font-medium">Action</th>
                    <th className="text-left px-6 py-3 font-medium">Resource Type</th>
                    <th className="text-left px-6 py-3 font-medium">Resource ID</th>
                    <th className="text-left px-6 py-3 font-medium">Changes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {filteredLogs.map(log => (
                    <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                      <td className="px-6 py-3 text-gray-400 text-xs whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Clock size={11} className="shrink-0" />
                          {relativeTime(log.created_at)}
                        </div>
                      </td>
                      <td className="px-6 py-3">
                        <span className="font-mono text-xs bg-gray-800 px-2 py-0.5 rounded text-blue-300">
                          {log.action}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-300 capitalize">
                        {log.resource_type}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-gray-400">
                        {truncateId(log.resource_id)}
                      </td>
                      <td className="px-6 py-3 text-xs text-gray-400 max-w-xs truncate" title={summariseChanges(log.new_values)}>
                        {summariseChanges(log.new_values)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Device Health ────────────────────────────────────────────────── */}
      {activeTab === 'device-health' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-white">Device Health</h2>
            {deviceLoading && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500" />
            )}
          </div>

          {deviceError && (
            <div className="flex items-center gap-2 p-4 rounded-lg bg-red-900/30 border border-red-800 text-red-300 mb-4">
              <AlertTriangle size={16} /> {deviceError}
            </div>
          )}

          {!deviceLoading && !deviceError && deviceHealth.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500 bg-gray-900 rounded-xl border border-gray-800">
              <Eye size={40} className="mb-3 opacity-40" />
              <p className="font-medium">No devices found</p>
              <p className="text-sm mt-1">Device telemetry from your fleet will appear here.</p>
            </div>
          )}

          {!deviceLoading && deviceHealth.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
              {deviceHealth.map(device => (
                <div
                  key={device.id}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4"
                >
                  {/* Vehicle + status header */}
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold text-white text-sm">
                        {device.vehicles?.name ?? 'Unknown Vehicle'}
                      </p>
                      {device.vehicles?.vin && (
                        <p className="text-xs text-gray-500 font-mono">{device.vehicles.vin}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                          device.is_online ? 'bg-green-500 shadow-[0_0_6px_1px_rgba(34,197,94,0.5)]' : 'bg-gray-600'
                        }`}
                      />
                      <span className={`text-xs font-medium ${device.is_online ? 'text-green-400' : 'text-gray-500'}`}>
                        {device.is_online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>

                  {/* Device type + firmware */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <DeviceTypeBadge type={device.device_type} />
                    {device.firmware_version && (
                      <span className="text-xs text-gray-500 font-mono">v{device.firmware_version}</span>
                    )}
                  </div>

                  {/* Last ping */}
                  <div className="text-xs text-gray-400 flex items-center gap-1">
                    <Clock size={11} className="shrink-0" />
                    Last ping: {relativeTime(device.last_ping_at)}
                  </div>

                  {/* Signal + battery */}
                  <div className="space-y-2 pt-1 border-t border-gray-800">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Signal strength</p>
                      <SignalBar dBm={device.signal_strength} />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 mb-1">Battery</p>
                      <BatteryBar level={device.battery_level !== undefined ? Number(device.battery_level) : null} />
                    </div>
                  </div>

                  {/* Error message if present */}
                  {device.error_message && (
                    <div className="flex items-start gap-1.5 text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>{device.error_code ? `[${device.error_code}] ` : ''}{device.error_message}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: API Access ────────────────────────────────────────────────────── */}
      {activeTab === 'api-access' && fleetId && (
        <ApiAccessTab fleetId={fleetId} />
      )}

      {/* ── Tab: Settings ─────────────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        <div className="max-w-lg space-y-6">

          {/* Fuel price card */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-orange-500/15 rounded-lg">
                <Fuel className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <p className="text-white font-semibold">Fuel Price</p>
                <p className="text-gray-400 text-xs">
                  Used by the cost-prediction engine. Update whenever the retail price changes.
                </p>
              </div>
            </div>

            {fuelLoading ? (
              <div className="flex items-center gap-2 text-gray-500 text-sm">
                <Loader className="w-4 h-4 animate-spin" /> Loading current price…
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-gray-400">
                      Retail Price (₹ / litre)
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      value={fuelPriceInr}
                      onChange={e => { setFuelPriceInr(e.target.value); setFuelSavedMsg(''); }}
                      className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-orange-500"
                      placeholder="103.00"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-gray-400">
                      USD → INR rate
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      value={usdToInr}
                      onChange={e => { setUsdToInr(e.target.value); setFuelSavedMsg(''); }}
                      className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-orange-500"
                      placeholder="83.00"
                    />
                  </div>
                </div>

                {/* Derived USD price preview */}
                {fuelPriceInr && usdToInr && !isNaN(parseFloat(fuelPriceInr)) && !isNaN(parseFloat(usdToInr)) && (
                  <p className="text-xs text-gray-500">
                    Effective rate used by engine:{' '}
                    <span className="text-gray-300 font-medium">
                      ${(parseFloat(fuelPriceInr) / parseFloat(usdToInr)).toFixed(4)} USD/L
                    </span>
                  </p>
                )}

                <button
                  onClick={saveFuelPrice}
                  disabled={fuelSaving}
                  className="flex items-center gap-2 px-4 py-2.5 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {fuelSaving ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Fuel Price
                </button>

                {fuelSavedMsg && (
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-xs">
                    <CheckCircle size={14} className="flex-shrink-0" />
                    {fuelSavedMsg}
                  </div>
                )}

                <p className="text-xs text-gray-600 border-t border-gray-800 pt-3">
                  Tip: India retail petrol prices are regulated and typically update on the 1st of each month.
                  Check <span className="text-gray-500">iocl.com</span> for the latest Chennai / TN price.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
