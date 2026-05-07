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
  ToggleLeft,
  ToggleRight,
  Globe,
  Bell,
  Copy,
  Link2,
  PauseCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { useSubscription } from '../hooks/useSubscription';
import { usePendingCheckout } from '../hooks/usePendingCheckout';
import { usePlanCatalog, type PlanCatalogEntry } from '../hooks/usePlanCatalog';
import ApiAccessTab from '../components/ApiAccessTab';
import PlanCheckoutModal, { type BillingDetails } from '../components/PlanCheckoutModal';
import InvoicesPanel from '../components/InvoicesPanel';
import TrialStatusCard from '../components/TrialStatusCard';
import CashbackCard from '../components/CashbackCard';
import AnnualUnlockCard from '../components/AnnualUnlockCard';
import CancelSubscriptionModal from '../components/CancelSubscriptionModal';
import SubscriptionHistoryCard from '../components/SubscriptionHistoryCard';
import BillingDetailsCard from '../components/BillingDetailsCard';
import PauseSubscriptionModal from '../components/PauseSubscriptionModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Subscription {
  id: string;
  fleet_id: string;
  // Active plans: essential/professional/business/enterprise (per-vehicle billing).
  // Legacy plan names kept in the union so existing DB rows still type-check.
  plan:
    | 'trial'
    | 'essential' | 'professional' | 'business' | 'enterprise'
    | 'starter'   | 'growth'       | 'pro';
  status: 'active' | 'inactive' | 'suspended' | 'trial' | 'expired' | 'paused';
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

type Tab = 'subscription' | 'drivers' | 'audit' | 'device-health' | 'api-access' | 'settings' | 'thresholds';

// ─── Threshold sensor config ──────────────────────────────────────────────────

type SensorDef = { key: string; label: string; unit: string; defaultMin: number | null; defaultMax: number | null };

const THRESHOLD_SENSOR_GROUPS: Array<{ category: string; sensors: SensorDef[] }> = [
  {
    category: 'Engine & Core',
    sensors: [
      { key: 'rpm',              label: 'Engine RPM',            unit: 'RPM',     defaultMin: null, defaultMax: 4500 },
      { key: 'coolantTemp',      label: 'Coolant Temperature',   unit: '°C',      defaultMin: null, defaultMax: 105  },
      { key: 'coolantTemp2',     label: 'Coolant Temp 2',        unit: '°C',      defaultMin: null, defaultMax: 105  },
      { key: 'engineLoad',       label: 'Engine Load',           unit: '%',       defaultMin: null, defaultMax: 85   },
      { key: 'engineOilTemp',    label: 'Engine Oil Temp',       unit: '°C',      defaultMin: null, defaultMax: 130  },
      { key: 'timingAdvance',    label: 'Timing Advance',        unit: '° BTDC',  defaultMin: -20,  defaultMax: 45   },
      { key: 'manifoldPressure', label: 'Manifold Pressure',     unit: 'kPa',     defaultMin: 20,   defaultMax: 105  },
      { key: 'exhaustGasTempBank1', label: 'Exhaust Gas Temp',   unit: '°C',      defaultMin: null, defaultMax: 850  },
      { key: 'actualEngineTorque',  label: 'Actual Engine Torque', unit: '%',     defaultMin: null, defaultMax: null },
      { key: 'enginePercentTorque', label: 'Engine Torque %',    unit: '%',       defaultMin: null, defaultMax: null },
      { key: 'absoluteLoad',     label: 'Absolute Load',         unit: '%',       defaultMin: null, defaultMax: 90   },
    ],
  },
  {
    category: 'Fuel & Emissions',
    sensors: [
      { key: 'fuelLevel',               label: 'Fuel Level',              unit: '%',    defaultMin: 15,   defaultMax: null },
      { key: 'fuelPressure',            label: 'Fuel Pressure',           unit: 'kPa',  defaultMin: 200,  defaultMax: 600  },
      { key: 'fuelRailAbsolutePressure',label: 'Fuel Rail Pressure',      unit: 'kPa',  defaultMin: null, defaultMax: 5000 },
      { key: 'engineFuelRate',          label: 'Engine Fuel Rate',        unit: 'L/h',  defaultMin: null, defaultMax: 30   },
      { key: 'cylinderFuelRate',        label: 'Cylinder Fuel Rate',      unit: 'mg/s', defaultMin: null, defaultMax: null },
      { key: 'shortFuelTrim',           label: 'Short-Term Fuel Trim',    unit: '%',    defaultMin: -15,  defaultMax: 15   },
      { key: 'longFuelTrim',            label: 'Long-Term Fuel Trim',     unit: '%',    defaultMin: -10,  defaultMax: 10   },
      { key: 'ethanolFuelPercent',      label: 'Ethanol Fuel %',          unit: '%',    defaultMin: null, defaultMax: 85   },
      { key: 'catalystTempBank1',       label: 'Catalyst Temp Bank 1',    unit: '°C',   defaultMin: null, defaultMax: 900  },
      { key: 'o2Sensor1Voltage',        label: 'O2 Sensor 1 Voltage',     unit: 'V',    defaultMin: 0.1,  defaultMax: 0.9  },
      { key: 'o2Sensor2Voltage',        label: 'O2 Sensor 2 Voltage',     unit: 'V',    defaultMin: 0.1,  defaultMax: 0.9  },
      { key: 'commandedEGR',            label: 'Commanded EGR',           unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'egrError',                label: 'EGR Error',               unit: '%',    defaultMin: -10,  defaultMax: 10   },
      { key: 'commandedEvapPurge',      label: 'Evap Purge',              unit: '%',    defaultMin: null, defaultMax: null },
    ],
  },
  {
    category: 'Speed & Movement',
    sensors: [
      { key: 'speed',                      label: 'Vehicle Speed',              unit: 'km/h', defaultMin: null, defaultMax: 120  },
      { key: 'throttlePosition',           label: 'Throttle Position',          unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'relativeThrottlePosition',   label: 'Relative Throttle Position', unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'absoluteThrottlePositionB',  label: 'Absolute Throttle B',        unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'commandedThrottleActuator',  label: 'Commanded Throttle',         unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'relativeAcceleratorPosition',label: 'Relative Accelerator Pos',   unit: '%',    defaultMin: null, defaultMax: null },
      { key: 'distanceSinceMIL',           label: 'Distance Since MIL On',      unit: 'km',   defaultMin: null, defaultMax: 0    },
    ],
  },
  {
    category: 'Air Intake',
    sensors: [
      { key: 'intakeAirTemp',      label: 'Intake Air Temperature', unit: '°C',  defaultMin: null, defaultMax: 65  },
      { key: 'maf',                label: 'Mass Air Flow',          unit: 'g/s', defaultMin: null, defaultMax: null },
      { key: 'barometricPressure', label: 'Barometric Pressure',    unit: 'kPa', defaultMin: 75,   defaultMax: 108 },
      { key: 'ambientTemp',        label: 'Ambient Temperature',    unit: '°C',  defaultMin: -40,  defaultMax: 60  },
    ],
  },
  {
    category: 'Electrical',
    sensors: [
      { key: 'batteryVoltage',       label: 'Battery Voltage',    unit: 'V', defaultMin: 11.5, defaultMax: 14.8 },
      { key: 'controlModuleVoltage', label: 'Module Voltage',     unit: 'V', defaultMin: 11.5, defaultMax: 14.8 },
    ],
  },
  {
    category: 'Transmission & Drivetrain',
    sensors: [
      { key: 'transmissionFluidTemp',  label: 'Transmission Fluid Temp', unit: '°C',  defaultMin: null, defaultMax: 120  },
      { key: 'transmissionTurbineSpeed',label: 'Turbine Speed',          unit: 'RPM', defaultMin: null, defaultMax: 4000 },
      { key: 'transmissionTorque',     label: 'Transmission Torque',     unit: '%',   defaultMin: null, defaultMax: null },
      { key: 'transmissionGear',       label: 'Current Gear',            unit: '',    defaultMin: null, defaultMax: null },
    ],
  },
  {
    category: 'CNG (Compressed Natural Gas)',
    sensors: [
      { key: 'cngCylinderPressure', label: 'CNG Cylinder Pressure', unit: 'bar', defaultMin: 20,  defaultMax: 250 },
      { key: 'cngFuelLevel',        label: 'CNG Fuel Level',        unit: '%',   defaultMin: 10,  defaultMax: null },
      { key: 'cngTemperature',      label: 'CNG Temperature',       unit: '°C',  defaultMin: null, defaultMax: 60  },
    ],
  },
  {
    category: 'Electric Vehicle (EV)',
    sensors: [
      { key: 'evBatteryLevel',   label: 'EV Battery Level',    unit: '%',   defaultMin: 20,  defaultMax: null },
      { key: 'evBatteryTemp',    label: 'EV Battery Temp',     unit: '°C',  defaultMin: null, defaultMax: 45   },
      { key: 'evBatteryVoltage', label: 'EV Battery Voltage',  unit: 'V',   defaultMin: 280, defaultMax: 420  },
      { key: 'evBatteryCurrent', label: 'EV Battery Current',  unit: 'A',   defaultMin: null, defaultMax: 200  },
      { key: 'evRangeEstimate',  label: 'EV Range Estimate',   unit: 'km',  defaultMin: 30,  defaultMax: null },
      { key: 'evMotorTemp',      label: 'EV Motor Temp',       unit: '°C',  defaultMin: null, defaultMax: 80   },
      { key: 'evMotorRpm',       label: 'EV Motor RPM',        unit: 'RPM', defaultMin: null, defaultMax: 15000 },
    ],
  },
];

// Flat list derived from groups — used by buildDefaultRows and saveThresholds
const THRESHOLD_SENSORS = THRESHOLD_SENSOR_GROUPS.flatMap(g => g.sensors);

interface ThresholdRow {
  sensor_type:   string;
  min_value:     string;
  max_value:     string;
  alert_enabled: boolean;
  dirty:         boolean;
}

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
    trial:        'bg-gray-700 text-gray-300',
    essential:    'bg-blue-900 text-blue-300',
    professional: 'bg-teal-900 text-teal-300',
    business:     'bg-purple-900 text-purple-300',
    enterprise:   'bg-yellow-900 text-yellow-300',
    // Legacy rows get a neutral style so they remain readable until migrated.
    starter:      'bg-gray-800 text-gray-300',
    growth:       'bg-gray-800 text-gray-300',
    pro:          'bg-gray-800 text-gray-300',
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
  // Inline `useTranslation` so the badge re-renders on language switch. The
  // `cfg` map keys stay English (they index by the canonical status enum
  // value) — only the displayed label flips per locale.
  const { t } = useTranslation();
  const cfg: Record<Subscription['status'], { cls: string; icon: React.ReactNode; labelKey: string }> = {
    active:    { cls: 'bg-green-900 text-green-300',   icon: <CheckCircle size={11} />,    labelKey: 'admin.subscription.statusActive' },
    trial:     { cls: 'bg-yellow-900 text-yellow-300', icon: <Clock size={11} />,          labelKey: 'admin.subscription.statusTrial' },
    suspended: { cls: 'bg-red-900 text-red-300',       icon: <XCircle size={11} />,        labelKey: 'admin.subscription.statusSuspended' },
    inactive:  { cls: 'bg-gray-700 text-gray-400',     icon: <XCircle size={11} />,        labelKey: 'admin.subscription.statusInactive' },
    expired:   { cls: 'bg-orange-900 text-orange-300', icon: <AlertTriangle size={11} />,  labelKey: 'admin.subscription.statusExpired' },
    paused:    { cls: 'bg-blue-900 text-blue-300',     icon: <PauseCircle size={11} />,    labelKey: 'admin.subscription.statusPaused' },
  };
  const { cls, icon, labelKey } = cfg[status] ?? cfg.inactive;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {icon}
      {t(labelKey)}
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
//
// Pricing and min_vehicles come from `plan_definitions` via `usePlanCatalog`.
// Only the marketing copy (feature bullets, highlight flag) lives here.

interface PlanCard {
  plan:      Subscription['plan'];
  label:     string;
  price:     string;   // already-formatted, e.g. "₹300" or "Custom"
  period:    string;   // e.g. "/vehicle/mo" or "30 days"
  vehicles:  string;   // e.g. "From 5 vehicles"
  drivers:   string;   // e.g. "Unlimited drivers"
  features:  string[];
  cta:       string | null;
  highlight: boolean;
}

// Per-plan i18n key for the feature-bullet array. Keeps the planName→key
// mapping in one place so adding a new plan is a one-line addition here +
// one new array in en.json (and ta.json).
const FEATURE_KEY_BY_PLAN: Record<string, string> = {
  essential:    'pricing.essentialFeatures',
  professional: 'pricing.professionalFeatures',
  business:     'pricing.businessFeatures',
  enterprise:   'pricing.enterpriseFeatures',
};

const HIGHLIGHTED_PLANS: ReadonlySet<string> = new Set(['professional']);

/// Translation-aware variant of the old TRIAL_CARD constant. Called inside
/// AdminPage so the strings flip when the user toggles language.
function buildTrialCard(t: (k: string, opts?: Record<string, unknown>) => string): PlanCard {
  return {
    plan:      'trial',
    label:     t('pricing.trialCardLabel'),
    price:     t('pricing.trialCardPrice'),
    period:    t('pricing.trialCardPeriod'),
    vehicles:  t('pricing.trialCardVehicles'),
    drivers:   t('pricing.trialCardDrivers'),
    features:  (t('pricing.trialFeatures', { returnObjects: true }) as unknown as string[]) ?? [],
    cta:       null,
    highlight: false,
  };
}

/// Translation-aware variant of the old buildCardFromCatalog. Takes `t` as
/// an explicit dependency — keeps the function pure and testable instead of
/// reaching for a context.
function buildCardFromCatalog(
  p:    PlanCatalogEntry,
  t:    (k: string, opts?: Record<string, unknown>) => string,
): PlanCard {
  const featureKey = FEATURE_KEY_BY_PLAN[p.planName];
  const features   = featureKey
    ? ((t(featureKey, { returnObjects: true }) as unknown as string[]) ?? [])
    : [];

  const vehicleLabel = t('pricing.fromVehicles', { count: p.minVehicles });
  const isCustom     = p.billingModel === 'custom' || p.pricePerVehicleInr == null;

  return {
    plan:      p.planName as Subscription['plan'],
    label:     p.displayName,
    price:     isCustom ? t('pricing.customPrice') : `₹${p.pricePerVehicleInr}`,
    period:    isCustom
      ? (p.minVehicles >= 50 ? t('pricing.fromVehicles', { count: p.minVehicles }) : '')
      : t('pricing.perVehiclePerMonth'),
    vehicles:  isCustom ? t('pricing.unlimitedVehicles') : vehicleLabel,
    drivers:   t('pricing.unlimitedDrivers'),
    features,
    cta:       p.planName === 'enterprise'
      ? t('pricing.ctaContactSales')
      : t('pricing.ctaSelect', { plan: p.displayName }),
    highlight: HIGHLIGHTED_PLANS.has(p.planName),
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AdminPage() {
  const { t } = useTranslation();

  // useSubscription is the app-wide source of truth for billing + fleet ids.
  // We pull `fleetId` (renamed `subFleetId` here) as a fallback in case the
  // local manager-by-id fetch misses (race / RLS hiccup), plus `vehiclesUsed`
  // and `annualUnlockedAt` for the Phase 1.2 checkout flow.
  const {
    feature,
    fleetId:          subFleetId,
    vehiclesUsed,
    annualUnlockedAt,
  } = useSubscription();
  const hasApiAccess = feature('api_access') === 'full';

  // Live plan catalog from `plan_definitions` — single source of truth for
  // prices and minimum-vehicle floors shown on the pricing grid.
  const { plans: catalogPlans, loading: catalogLoading } = usePlanCatalog();

  // Cross-page deep-link channel (Phase 1.4.2). When TrialBanner queues
  // pendingPlan + navigates here, we consume the request below in a
  // useEffect that runs once the catalog is loaded.
  const pendingCheckout = usePendingCheckout();

  // Currently-open checkout modal (null = closed). Holds the full catalog
  // entry so the modal has prices, min_vehicles, and (later) Razorpay plan IDs.
  const [checkoutPlan, setCheckoutPlan] = useState<PlanCatalogEntry | null>(null);

  // Customer billing identity (GSTIN + address + state code), fetched once
  // and refreshed after each save. Pre-fills the GSTIN form in the checkout
  // modal so returning customers don't retype. Phase 1.3.1.
  const [billingDetails, setBillingDetails] = useState<BillingDetails | null>(null);

  // Self-serve cancellation modal (Phase 3.2). Open by clicking the
  // "Cancel subscription" link in the current-plan card footer; only
  // visible when the subscription is currently active. Closing the modal
  // doesn't refresh — the realtime channel on subscriptions picks up the
  // status flip when Razorpay's webhook fires at cycle end.
  const [showCancelModal, setShowCancelModal] = useState(false);

  // Self-serve pause / resume modal (Phase 3.4). Single state, two actions —
  // null = closed, 'pause' / 'resume' = open with the matching copy. The
  // action is bound at click time so the trigger sites pick the right
  // mode based on subscription.status.
  const [pauseModalAction, setPauseModalAction] = useState<'pause' | 'resume' | null>(null);

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

  // Threshold state
  const [threshVehicles,    setThreshVehicles]    = useState<{ id: string; name: string }[]>([]);
  const [threshVehicleId,   setThreshVehicleId]   = useState<string>('__fleet__');
  const [thresholdRows,     setThresholdRows]     = useState<Map<string, ThresholdRow>>(new Map());
  const [threshLoading,     setThreshLoading]     = useState(false);
  const [threshSaving,      setThreshSaving]      = useState(false);
  const [threshSaveOk,      setThreshSaveOk]      = useState(false);
  const [threshError,       setThreshError]       = useState<string | null>(null);

  // Fleet context
  // fleetId — set by fetchFleet; subFleetId is the authoritative fallback from
  // useSubscription which loads app-wide before any page renders.
  const [fleetId,        setFleetId]        = useState<string | null>(null);
  const [fleetName,      setFleetName]      = useState<string>('');
  const [fleetJoinCode,  setFleetJoinCode]  = useState<string>('');
  const [joinCodeCopied, setJoinCodeCopied] = useState(false);
  // Captured at mount so the Enterprise WhatsApp prefill (Phase 1.2.5) doesn't
  // have to do its own auth round-trip on click.
  const [userEmail,      setUserEmail]      = useState<string | null>(null);

  // The first non-null source wins: local fetch → subscription context
  const effectiveFleetId = fleetId ?? subFleetId ?? null;

  // ── Delete fleet state ──────────────────────────────────────────────────────
  const [showDeleteModal,    setShowDeleteModal]    = useState(false);
  const [deleteConfirmName,  setDeleteConfirmName]  = useState('');
  const [deleting,           setDeleting]           = useState(false);
  const [deleteError,        setDeleteError]        = useState<string | null>(null);
  // Fleet name resolved at modal-open time (independent of effectiveFleetId)
  const [modalFleetName,     setModalFleetName]     = useState<string>('');
  const [modalFleetId,       setModalFleetId]       = useState<string | null>(null);
  const [modalLoading,       setModalLoading]       = useState(false);

  // ── Fetch fleet on mount ────────────────────────────────────────────────────
  // Loads fleetName + joinCode.  If the manager query finds nothing (race or
  // RLS hiccup), fall back to querying by the subscription context's fleetId.

  useEffect(() => {
    const fetchFleet = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      // Cache email up front so handleEnterpriseContact doesn't need its own
      // auth round-trip when the user clicks "Contact Sales".
      setUserEmail(user.email ?? null);

      // Primary: find by manager_id (most reliable for fleet managers)
      let data: { id: string; name: string | null; join_code: string | null } | null = null;
      const { data: byManager } = await supabase
        .from('fleets')
        .select('id, name, join_code')
        .eq('manager_id', user.id)
        .maybeSingle();

      data = byManager;

      // Fallback: if manager query returned nothing but subscription already
      // resolved a fleet ID, load by that ID directly
      if (!data && subFleetId) {
        const { data: byId } = await supabase
          .from('fleets')
          .select('id, name, join_code')
          .eq('id', subFleetId)
          .maybeSingle();
        data = byId;
      }

      if (data) {
        setFleetId(data.id);
        setFleetName(data.name ?? '');
        setFleetJoinCode(data.join_code ?? '');
      }
    };
    fetchFleet();
  // Re-run once subFleetId resolves so the fallback path is exercised
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subFleetId]);

  const handleCopyJoinCode = () => {
    if (!fleetJoinCode) return;
    navigator.clipboard.writeText(fleetJoinCode);
    setJoinCodeCopied(true);
    setTimeout(() => setJoinCodeCopied(false), 2000);
  };

  // Opens the modal and resolves the fleet record fresh from the DB.
  // Never depends on pre-loaded state — works even if effectiveFleetId is null.
  const openDeleteModal = async () => {
    setDeleteConfirmName('');
    setDeleteError(null);
    setModalFleetName('');
    setModalFleetId(null);
    setShowDeleteModal(true);
    setModalLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setDeleteError('Not authenticated.'); return; }

      const { data, error } = await supabase
        .from('fleets')
        .select('id, name')
        .eq('manager_id', user.id)
        .maybeSingle();

      if (error) { setDeleteError(error.message); return; }
      if (!data)  { setDeleteError('No fleet found for your account.'); return; }

      setModalFleetId(data.id);
      setModalFleetName(data.name ?? '');
    } finally {
      setModalLoading(false);
    }
  };

  const handleDeleteFleet = async () => {
    if (!modalFleetId) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // ── Step 1: Snapshot driver user_ids before deletion ─────────────────────
      const { data: driverRows } = await supabase
        .from('driver_accounts')
        .select('user_id')
        .eq('fleet_id', modalFleetId);

      const driverUserIds: string[] = (driverRows ?? [])
        .map((d: { user_id: string }) => d.user_id)
        .filter(Boolean);

      // ── Step 2: Delete the fleet ──────────────────────────────────────────────
      // RLS policy "Fleet managers can delete their own fleets" allows this.
      // ON DELETE CASCADE removes: vehicles, sensor_data, trips, alerts,
      // thresholds, device_health, driver_accounts, subscriptions, invitations.
      const { error: deleteErr } = await supabase
        .from('fleets')
        .delete()
        .eq('id', modalFleetId);

      if (deleteErr) throw new Error(deleteErr.message);

      // ── Step 3: Best-effort driver auth.users cleanup via edge function ───────
      // Fleet is already gone; pass driver_user_ids directly. Silently ignored
      // if the function hasn't been deployed yet.
      if (driverUserIds.length > 0) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            await fetch(
              `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/fleet-delete`,
              {
                method:  'POST',
                headers: {
                  'Content-Type':  'application/json',
                  'Authorization': `Bearer ${session.access_token}`,
                  'apikey':        import.meta.env.VITE_SUPABASE_ANON_KEY as string,
                },
                body: JSON.stringify({ cleanup_only: true, driver_user_ids: driverUserIds }),
              },
            );
          }
        } catch {
          // Best-effort — don't block the user if this fails
        }
      }

      // ── Step 4: Sign out and redirect ────────────────────────────────────────
      await supabase.auth.signOut({ scope: 'global' });
      window.location.href = '/';
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : 'Fleet deletion failed');
      setDeleting(false);
    }
  };

  // ── Billing details (1.3.1) — fetched once per fleet, refreshed on save ───
  // Drives both the GSTIN pre-fill in PlanCheckoutModal and the customer
  // block on past invoices. Reads via admin-api so the route stays the only
  // place enforcing the cross-field GSTIN/state-code consistency rule.
  const loadBillingDetails = useCallback(async () => {
    if (!fleetId) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) return;
      const { data, error } = await supabase.functions.invoke(
        'admin-api?action=billing-details',
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (error) {
        console.warn('[admin] billing-details load failed', error);
        return;
      }
      setBillingDetails({
        gstin:          (data?.gstin           as string | null) ?? null,
        billingAddress: (data?.billing_address as string | null) ?? null,
        stateCode:      (data?.state_code      as string | null) ?? null,
        billingEmail:   (data?.billing_email   as string | null) ?? null,
      });
    } catch (e) {
      console.warn('[admin] billing-details load threw', e);
    }
  }, [fleetId]);

  /// Persists customer GSTIN + billing address + state code via admin-api,
  /// then refreshes local state so future PlanCheckoutModal opens pre-fill.
  /// Errors are surfaced as thrown Errors — PlanCheckoutModal's handleContinue
  /// catches them and shows the message inline without losing the user's input.
  const handleSaveBillingDetails = async (details: BillingDetails) => {
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) throw new Error('Please log in again to save billing details.');

    const { error } = await supabase.functions.invoke('admin-api', {
      headers: { Authorization: `Bearer ${accessToken}` },
      body: {
        action:           'update-billing-details',
        gstin:            details.gstin,
        billing_address:  details.billingAddress,
        state_code:       details.stateCode,
        billing_email:    details.billingEmail,
      },
    });
    if (error) {
      let msg = error.message ?? 'Failed to save billing details';
      try {
        const errBody = await (error as unknown as { context?: { json?: () => Promise<{ error?: string }> } })
          .context?.json?.();
        msg = errBody?.error ?? msg;
      } catch { /* fall back to error.message */ }
      throw new Error(msg);
    }
    setBillingDetails(details);
  };

  // ── Load tab data when fleet or tab changes ─────────────────────────────────

  const loadSubscription = useCallback(async () => {
    if (!effectiveFleetId) return;
    setSubLoading(true);
    setSubError(null);
    try {
      const [subRes, vehicleRes, driverRes] = await Promise.all([
        supabase.from('subscriptions').select('*').eq('fleet_id', effectiveFleetId).single(),
        supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('fleet_id', effectiveFleetId),
        supabase.from('driver_accounts').select('id', { count: 'exact', head: true }).eq('fleet_id', effectiveFleetId),
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
  }, [effectiveFleetId]);

  const loadDrivers = useCallback(async () => {
    if (!effectiveFleetId) return;
    setDriversLoading(true);
    setDriversError(null);
    try {
      const { data, error } = await supabase
        .from('driver_accounts')
        .select('*, vehicles(id, name, vin, make, model)')
        .eq('fleet_id', effectiveFleetId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setDrivers(data ?? []);
    } catch (e: any) {
      setDriversError(e.message ?? 'Failed to load drivers');
    } finally {
      setDriversLoading(false);
    }
  }, [effectiveFleetId]);

  const loadAuditLogs = useCallback(async () => {
    if (!effectiveFleetId) return;
    setAuditLoading(true);
    setAuditError(null);
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('fleet_id', effectiveFleetId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setAuditLogs(data ?? []);
    } catch (e: any) {
      setAuditError(e.message ?? 'Failed to load audit logs');
    } finally {
      setAuditLoading(false);
    }
  }, [effectiveFleetId]);

  const loadDeviceHealth = useCallback(async () => {
    if (!effectiveFleetId) return;
    setDeviceLoading(true);
    setDeviceError(null);
    try {
      const { data: vehicles } = await supabase
        .from('vehicles')
        .select('id')
        .eq('fleet_id', effectiveFleetId);
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
  }, [effectiveFleetId]);

  // Builds a Map seeded with sensor defaults — always call this first so rows
  // are never blank even if the DB query fails.
  const buildDefaultRows = (): Map<string, ThresholdRow> => {
    const m = new Map<string, ThresholdRow>();
    THRESHOLD_SENSORS.forEach(s => {
      m.set(s.key, {
        sensor_type:   s.key,
        min_value:     s.defaultMin != null ? String(s.defaultMin) : '',
        max_value:     s.defaultMax != null ? String(s.defaultMax) : '',
        alert_enabled: true,
        dirty:         false,
      });
    });
    return m;
  };

  // Merges saved DB rows into a default-seeded map and returns it.
  const mergeDbRows = (defaults: Map<string, ThresholdRow>, dbRows: any[]): Map<string, ThresholdRow> => {
    const m = new Map(defaults);
    for (const row of dbRows) {
      if (m.has(row.sensor_type)) {
        m.set(row.sensor_type, {
          sensor_type:   row.sensor_type,
          min_value:     row.min_value != null ? String(row.min_value) : '',
          max_value:     row.max_value != null ? String(row.max_value) : '',
          alert_enabled: row.alert_enabled ?? true,
          dirty:         false,
        });
      }
    }
    return m;
  };

  // Called when Thresholds tab first opens — loads vehicles + thresholds for
  // the first vehicle. Defaults are shown immediately so the form is never blank.
  const initThresholds = useCallback(async () => {
    if (!effectiveFleetId) return;
    setThreshLoading(true);
    setThreshError(null);
    setThresholdRows(buildDefaultRows());

    try {
      const { data: vehicleData } = await supabase
        .from('vehicles').select('id, name').order('name');
      const vehicles = vehicleData ?? [];
      setThreshVehicles(vehicles);

      const pickId = vehicles.length > 0 ? vehicles[0].id : '__fleet__';
      setThreshVehicleId(pickId);

      if (pickId === '__fleet__') {
        // Fleet-level requires the migration — skip the load and keep defaults
        setThreshError('Select a specific vehicle to configure thresholds, or run migration 20260521000000_thresholds_fleet_scope.sql to enable fleet-wide defaults.');
        return;
      }

      const { data, error } = await supabase
        .from('thresholds').select('*').eq('vehicle_id', pickId);
      if (error) throw error;
      setThresholdRows(mergeDbRows(buildDefaultRows(), data ?? []));
    } catch (e: any) {
      setThreshError(e?.message ?? 'Failed to load thresholds');
    } finally {
      setThreshLoading(false);
    }
  }, [effectiveFleetId]);

  // Called from the vehicle-selector dropdown onChange.
  const loadThresholds = useCallback(async (vehicleId: string) => {
    if (!effectiveFleetId) return;
    setThreshLoading(true);
    setThreshError(null);
    setThresholdRows(buildDefaultRows()); // show defaults immediately

    try {
      const isFleet = vehicleId === '__fleet__';
      const { data, error } = isFleet
        ? await supabase.from('thresholds').select('*').eq('fleet_id', effectiveFleetId).is('vehicle_id', null)
        : await supabase.from('thresholds').select('*').eq('vehicle_id', vehicleId);
      if (error) {
        if (error.message?.includes('fleet_id')) {
          setThreshError('Run migration 20260521000000_thresholds_fleet_scope.sql in Supabase Studio to enable fleet-wide thresholds.');
        } else {
          setThreshError(error.message);
        }
        return;
      }
      setThresholdRows(mergeDbRows(buildDefaultRows(), data ?? []));
    } catch (e: any) {
      setThreshError(e?.message ?? 'Failed to load thresholds');
    } finally {
      setThreshLoading(false);
    }
  }, [effectiveFleetId]);

  const saveThresholds = async () => {
    if (!effectiveFleetId) return;
    setThreshSaving(true);
    setThreshSaveOk(false);
    setThreshError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session — please log in again');
      const headers = {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey':        import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      };
      const baseUrl = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/threshold-api`;
      const isFleet = threshVehicleId === '__fleet__';

      for (const row of Array.from(thresholdRows.values())) {
        const payload: Record<string, unknown> = {
          sensor_type:   row.sensor_type,
          min_value:     row.min_value !== '' ? parseFloat(row.min_value) : null,
          max_value:     row.max_value !== '' ? parseFloat(row.max_value) : null,
          alert_enabled: row.alert_enabled,
          ...(isFleet ? { fleet_id: effectiveFleetId } : { vehicle_id: threshVehicleId }),
        };
        const res = await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error ?? `Save failed (${res.status})`);
        }
      }
      setThreshSaveOk(true);
      setThresholdRows(prev => {
        const m = new Map(prev);
        m.forEach((v, k) => m.set(k, { ...v, dirty: false }));
        return m;
      });
    } catch (e: any) {
      setThreshError(e?.message ?? 'Unexpected error');
    } finally {
      setThreshSaving(false);
    }
  };

  const updateThreshRow = (key: string, field: keyof ThresholdRow, value: string | boolean) => {
    setThresholdRows(prev => {
      const m = new Map(prev);
      const row = m.get(key);
      if (row) m.set(key, { ...row, [field]: value, dirty: true });
      return m;
    });
    setThreshSaveOk(false);
  };

  useEffect(() => {
    if (!effectiveFleetId) return;
    if (activeTab === 'subscription')  loadSubscription();
    if (activeTab === 'drivers')       loadDrivers();
    if (activeTab === 'audit')         loadAuditLogs();
    if (activeTab === 'device-health') loadDeviceHealth();
    if (activeTab === 'settings')      loadFuelPrice();
    if (activeTab === 'thresholds')    initThresholds();
  }, [activeTab, effectiveFleetId, loadSubscription, loadDrivers, loadAuditLogs, loadDeviceHealth, loadFuelPrice, initThresholds]);

  // Billing details are needed both inside the checkout modal (GSTIN
  // pre-fill) and on the soon-to-arrive Invoices section, so we fetch them
  // once per fleet rather than gating on activeTab.
  useEffect(() => {
    if (!fleetId) return;
    loadBillingDetails();
  }, [fleetId, loadBillingDetails]);

  // ── Consume pending checkout request (Phase 1.4.2) ────────────────────────
  // TrialBanner sets pendingCheckout.pendingPlan and navigates here. We wait
  // until the live plan catalog has loaded — opening the modal with a stale
  // entry would silently use the wrong price. Once consumed, we clear the
  // request so re-mounting AdminPage doesn't re-open the modal in a loop.
  useEffect(() => {
    if (catalogLoading)              return;
    if (!pendingCheckout.pendingPlan) return;

    const entry = catalogPlans.find(p => p.planName === pendingCheckout.pendingPlan);
    if (entry) {
      // Switch to the Subscription tab so the user can see their existing
      // plan + pricing context behind the modal.
      setActiveTab('subscription');
      setCheckoutPlan(entry);
    }
    pendingCheckout.clear();
  }, [catalogLoading, catalogPlans, pendingCheckout]);

  // ── Delete driver ───────────────────────────────────────────────────────────

  const handleDeleteDriver = async (driver: DriverAccount) => {
    if (!confirm(`Delete driver "${driver.name || driver.email}"? This cannot be undone.`)) return;
    setDeletingDriverId(driver.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No active session — please log in again');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/driver-management`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey':       import.meta.env.VITE_SUPABASE_ANON_KEY as string,
            Authorization:  `Bearer ${session.access_token}`,
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

  // ── Enterprise contact-sales (1.2.5) ────────────────────────────────────────
  // Opens https://wa.me/<number>?text=<message> in a new tab, with a payload
  // that gives sales enough context to qualify and follow up:
  //   - Fleet name + current vehicle count → enterprise threshold check
  //   - Manager email                       → callback channel
  //   - "via app" tag                       → distinguishes from cold inbound
  //
  // Falls back to the email path if VITE_SALES_WHATSAPP_NUMBER is unset, so
  // dev environments and pre-launch tenants don't hit a broken link.
  const handleEnterpriseContact = () => {
    const rawNumber  = (import.meta.env.VITE_SALES_WHATSAPP_NUMBER ?? '').trim();
    const salesEmail = 'sales@vehiclesense.in';

    // Audit so we can measure enterprise-lead intent without instrumenting the
    // landing page on the sales side. Best-effort — the redirect happens
    // regardless of audit success.
    if (fleetId) {
      void supabase.from('audit_logs').insert({
        fleet_id:      fleetId,
        action:        'subscription.enterprise_contact_initiated',
        resource_type: 'subscription',
        new_values: {
          channel:        rawNumber ? 'whatsapp' : 'email_fallback',
          fleet_name:     fleetName,
          vehicles_used:  vehiclesUsed,
        },
      });
    }

    // Both message variants below render via the active i18n locale. When a
    // Tamil-preferring customer clicks "Contact Sales", the WhatsApp message
    // arrives at the sales rep already in Tamil — saves a back-and-forth on
    // language preference.
    const fleetForCopy = fleetName || t('enterpriseContact.fallbackFleetPlaceholder');

    if (!rawNumber) {
      alert(
        t('enterpriseContact.fallbackAlertLine1', { email: salesEmail }) +
        '\n\n' +
        t('enterpriseContact.fallbackAlertLine2', {
          fleet:    fleetForCopy,
          vehicles: vehiclesUsed,
        }),
      );
      return;
    }

    // Strip everything except digits — wa.me wants country-code + number with
    // no plus sign or punctuation.
    const number = rawNumber.replace(/\D/g, '');

    const namedFleet = fleetName || t('enterpriseContact.namePlaceholder');
    const lines = [
      t('enterpriseContact.messageGreeting'),
      '',
      t('enterpriseContact.messageIntro'),
      t('enterpriseContact.messageFleetLine',    { fleet:    namedFleet }),
      t('enterpriseContact.messageVehiclesLine', { vehicles: vehiclesUsed }),
      userEmail ? t('enterpriseContact.messageEmailLine', { email: userEmail }) : null,
      '',
      t('enterpriseContact.messageFooter'),
    ].filter(Boolean) as string[];
    const url = `https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`;

    // Use noopener so the new tab can't navigate us back via window.opener.
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // ── Upgrade CTA ─────────────────────────────────────────────────────────────

  const handleUpgrade = (plan: string) => {
    // Enterprise → WhatsApp click-to-chat (Phase 1.2.5).
    // Self-serve checkout doesn't apply: enterprise is custom-priced and the
    // sales conversation needs to happen first. We deep-link to a wa.me URL
    // pre-filled with the qualifying signals sales actually needs (fleet
    // name, current vehicle count, manager email) so the rep doesn't have to
    // open a discovery thread cold.
    if (plan === 'enterprise') {
      handleEnterpriseContact();
      return;
    }
    // Trial isn't purchasable — its CTA is null in the pricing grid, but guard
    // here in case something else calls handleUpgrade with it.
    if (plan === 'trial') return;

    // Open the checkout modal with the matching catalog entry. If the plan
    // isn't in the catalog (shouldn't happen — buttons only render for
    // catalog rows), fall back to the legacy alert for visibility.
    const entry = catalogPlans.find(p => p.planName === plan);
    if (!entry) {
      alert(t('pricing.planNotInCatalog', { plan }));
      return;
    }
    setCheckoutPlan(entry);
  };

  // ── Razorpay checkout handoff (Phase 1.2.4) ───────────────────────────────
  // Two-step flow:
  //   1. Call razorpay-create-subscription edge fn → get subscription_id + key_id
  //   2. Open window.Razorpay(...) → embedded checkout collects payment
  // The webhook (razorpay-webhook) is what actually flips subscriptions.status
  // to 'active' once Razorpay confirms the first charge — we never write that
  // here, otherwise a card-failure on Razorpay's side would leave us claiming
  // an active subscription that doesn't exist.
  //
  // Errors are thrown back to PlanCheckoutModal which surfaces them inline; on
  // success we close the modal so the Razorpay overlay owns the screen.
  const handleCheckoutContinue = async (
    vehicleCount: number,
    billingCycle: 'monthly' | 'annual',
  ) => {
    const p = checkoutPlan;
    if (!p) return;

    // ── Auth ────────────────────────────────────────────────────────────────
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) throw new Error('Please log in again to continue.');

    // ── Create Razorpay subscription server-side ────────────────────────────
    const { data, error } = await supabase.functions.invoke(
      'razorpay-create-subscription',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          plan:          p.planName,
          vehicle_count: vehicleCount,
          billing_cycle: billingCycle,
        },
      },
    );

    if (error) {
      // Drill into the FunctionsHttpError to surface the server's friendly
      // message (e.g. "Razorpay not configured" → 503 detail copy).
      let msg = error.message ?? 'Failed to start checkout';
      try {
        const errBody = await (error as unknown as { context?: { json?: () => Promise<{ error?: string; detail?: string }> } })
          .context?.json?.();
        msg = errBody?.detail ?? errBody?.error ?? msg;
      } catch { /* context not parseable — fall back to error.message */ }
      throw new Error(msg);
    }

    const subscriptionId = data?.razorpay_subscription_id as string | undefined;
    const keyId          = data?.key_id as string | undefined;
    if (!subscriptionId || !keyId) {
      throw new Error('Checkout response was missing subscription details.');
    }

    // ── Open embedded Razorpay Checkout ─────────────────────────────────────
    if (typeof window === 'undefined' || !window.Razorpay) {
      throw new Error(
        'Payment SDK failed to load. Please refresh and try again.',
      );
    }

    const { data: { user } } = await supabase.auth.getUser();
    const checkout = new window.Razorpay({
      key:             keyId,
      subscription_id: subscriptionId,
      name:            'Fleet Telemetry Platform',
      description:     `${p.displayName} plan · ${vehicleCount} vehicle${vehicleCount === 1 ? '' : 's'} · ${billingCycle}`,
      currency:        'INR',
      prefill: {
        email: user?.email ?? undefined,
        name:  (user?.user_metadata?.full_name as string | undefined) ?? undefined,
      },
      theme: { color: '#2563eb' },
      modal: {
        // If the customer dismisses without paying, just leave the upgrade
        // modal closed — they can re-open from the pricing grid.
        ondismiss: () => {
          console.info('[checkout] Razorpay modal dismissed');
        },
      },
      handler: response => {
        // Razorpay will fire the webhook server-side; this handler runs
        // client-side purely for UX. We refresh the subscription view so the
        // newly-active plan shows up without a manual reload.
        console.info('[checkout] Razorpay handler', response);
        loadSubscription();
      },
    });
    checkout.open();
    // PlanCheckoutModal closes itself once this promise resolves — Razorpay's
    // overlay is now in front, so we don't want our own modal stacked behind it.
  };

  // ── Unique audit actions for filter ────────────────────────────────────────

  const uniqueActions = Array.from(new Set(auditLogs.map(l => l.action))).sort();
  const filteredLogs = auditActionFilter
    ? auditLogs.filter(l => l.action === auditActionFilter)
    : auditLogs;

  // ─── Tabs config ─────────────────────────────────────────────────────────────

  const tabs: { id: Tab; label: string; icon: React.ReactNode; locked?: boolean }[] = [
    { id: 'subscription',  label: t('admin.tabSubscription'), icon: <CreditCard size={15} /> },
    { id: 'drivers',       label: t('admin.tabDrivers'),       icon: <Users size={15} /> },
    { id: 'thresholds',    label: t('admin.tabThresholds'),    icon: <Bell size={15} /> },
    { id: 'audit',         label: t('admin.tabAuditLog'),      icon: <Shield size={15} /> },
    { id: 'device-health', label: t('admin.tabDeviceHealth'),  icon: <Settings size={15} /> },
    { id: 'api-access',    label: t('admin.tabApiAccess'),     icon: <Key size={15} />, locked: !hasApiAccess },
    { id: 'settings',      label: t('admin.tabSettings'),      icon: <Settings size={15} /> },
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
          <h1 className="text-2xl font-bold text-white">{t('admin.pageHeading')}</h1>
        </div>
        <p className="text-gray-400 text-sm ml-11">{t('admin.pageDescription')}</p>
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
              {/* Trial / grace / suspended status card (Phase 1.4.3) — sits
                  above the current-plan card so the most urgent state is the
                  first thing the customer sees on this tab. Returns null when
                  the customer is on a healthy paid plan. */}
              <TrialStatusCard />

              {/* Cashback balance card (Phase 1.6.1) — also conditionally
                  shown; renders only when there's an unredeemed credit on
                  file. Sits with the trial card so anything financial is
                  grouped at the top of the tab. */}
              <CashbackCard fleetId={effectiveFleetId} />

              {/* Annual-unlock countdown (Phase 3.1) — conditional on the
                  monthly customer being inside the 3-month qualification
                  window with the flag not yet flipped. Renders null
                  otherwise; the card is silent for the steady state of
                  every other customer. */}
              <AnnualUnlockCard
                subscriptionCreatedAt={subscription?.created_at ?? null}
              />

              {/* Current plan overview */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">{t('admin.subscription.currentPlanHeading')}</h2>
                {subscription ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <PlanBadge plan={subscription.plan} />
                      <StatusBadge status={subscription.status} />
                      {subscription.trial_ends_at && subscription.status === 'trial' && (
                        <span className="text-xs text-yellow-400 flex items-center gap-1">
                          <Clock size={12} /> {t('admin.subscription.labelTrialEnds')} {relativeTime(subscription.trial_ends_at)}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <UsageBar current={vehicleCount} max={subscription.max_vehicles} label={t('admin.subscription.usageVehicles')} />
                      <UsageBar current={driverCount}  max={subscription.max_drivers}  label={t('admin.subscription.usageDrivers')} />
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
                    {/* Pause + Cancel footer links. Visible when sub is
                        currently active (Phase 3.2 cancel + Phase 3.4 pause).
                        Muted styling — these aren't primary actions. */}
                    {subscription.status === 'active' && subscription.razorpay_subscription_id && (
                      <div className="pt-3 border-t border-gray-800 flex items-center gap-4">
                        <button
                          onClick={() => setPauseModalAction('pause')}
                          className="text-xs text-gray-500 hover:text-blue-400 transition-colors underline-offset-2 hover:underline"
                        >
                          {t('pauseSubscription.footerTrigger')}
                        </button>
                        <button
                          onClick={() => setShowCancelModal(true)}
                          className="text-xs text-gray-500 hover:text-red-400 transition-colors underline-offset-2 hover:underline"
                        >
                          {t('cancelSubscription.footerTrigger')}
                        </button>
                      </div>
                    )}

                    {/* Paused-state banner (Phase 3.4). Replaces the
                        action footer when the sub is paused — primary
                        offer is "resume", cancel is folded in for
                        completeness. */}
                    {subscription.status === 'paused' && subscription.razorpay_subscription_id && (
                      <div className="pt-3 border-t border-gray-800">
                        <div className="bg-blue-950/30 border border-blue-900/60 rounded-lg p-4 space-y-2">
                          <div className="flex items-center gap-2">
                            <PauseCircle size={14} className="text-blue-300" />
                            <span className="text-sm font-semibold text-white">
                              {t('resumeSubscription.pausedHeading')}
                            </span>
                          </div>
                          <p className="text-xs text-blue-200/90 leading-relaxed">
                            {t('resumeSubscription.pausedBody')}
                          </p>
                          <div className="flex items-center gap-3 pt-1">
                            <button
                              onClick={() => setPauseModalAction('resume')}
                              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors"
                            >
                              {t('resumeSubscription.footerTrigger')}
                            </button>
                            <button
                              onClick={() => setShowCancelModal(true)}
                              className="text-xs text-gray-500 hover:text-red-400 transition-colors underline-offset-2 hover:underline"
                            >
                              {t('cancelSubscription.footerTrigger')}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">No subscription found for this fleet.</p>
                )}
              </div>

              {/* Subscription history timeline (Phase 3.3). Reads recent
                  audit_logs scoped to this fleet, filters to billing-
                  relevant actions. Hides itself when there's nothing to
                  show — fresh fleets see no empty state. */}
              <SubscriptionHistoryCard hasFleet={!!fleetId} />

              {/* Billing-details editor (Phase 3.8). Customers can update
                  GSTIN / address / state code / invoice email after
                  signup without re-doing checkout. Reuses the same
                  admin-api action and i18n strings as PlanCheckoutModal. */}
              <BillingDetailsCard
                details={billingDetails}
                onSave={handleSaveBillingDetails}
              />

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
                <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">{t('admin.subscription.availablePlansHeading')}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
                  {catalogLoading && (
                    // Skeleton row while plan_definitions loads
                    Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={`skeleton-${i}`}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-5 animate-pulse h-64"
                      />
                    ))
                  )}
                  {!catalogLoading && [
                    buildTrialCard(t),
                    ...catalogPlans.map(p => buildCardFromCatalog(p, t)),
                  ].map(card => {
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
                            {t('admin.subscription.labelPopular')}
                          </span>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-white">{card.label}</span>
                          {isCurrent && (
                            <span className="text-xs text-blue-400 font-medium bg-blue-500/15 px-2 py-0.5 rounded-full">{t('admin.subscription.labelCurrent')}</span>
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
                                : card.plan === 'professional'
                                ? 'bg-teal-600 hover:bg-teal-500 text-white'
                                : card.plan === 'business'
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

              {/* ── Invoices (Phase 1.3.3) ──────────────────────────────── */}
              {/* Lives inside the Subscription tab so customers don't need a
                  whole new top-level tab for the (initially empty) invoice
                  list. Hidden if the fleet has never been on a paid plan,
                  to keep the trial-stage UI simple. */}
              {subscription && subscription.status !== 'trial' && (
                <InvoicesPanel />
              )}
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

      {/* ── Tab: Thresholds ───────────────────────────────────────────────────── */}
      {activeTab === 'thresholds' && (
        <div className="space-y-5 max-w-3xl">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">

            {/* Scope selector */}
            <div className="flex flex-wrap items-center gap-3 mb-5">
              <div className="flex items-center gap-2">
                <Globe size={15} className="text-gray-400" />
                <label className="text-sm text-gray-400 whitespace-nowrap">Apply to:</label>
              </div>
              <select
                value={threshVehicleId}
                onChange={e => {
                  setThreshVehicleId(e.target.value);
                  setThreshSaveOk(false);
                  loadThresholds(e.target.value);
                }}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="__fleet__">All fleet vehicles (fleet default)</option>
                {threshVehicles.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {threshVehicleId === '__fleet__' && (
                <span className="text-xs text-purple-400 bg-purple-900/30 border border-purple-700/40 px-2 py-1 rounded-lg">
                  Fleet-wide default — overridden by per-vehicle settings
                </span>
              )}
            </div>

            {threshLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader className="w-5 h-5 text-blue-400 animate-spin" />
              </div>
            ) : (
              <div className="space-y-5">
                {THRESHOLD_SENSOR_GROUPS.map(group => {
                  const visibleSensors = group.sensors.filter(s => thresholdRows.has(s.key));
                  if (visibleSensors.length === 0) return null;
                  return (
                    <div key={group.category}>
                      {/* Category header */}
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">{group.category}</p>
                        <div className="flex-1 h-px bg-gray-800" />
                        {/* Column labels — only shown on first group to save space */}
                      </div>
                      {/* Column labels */}
                      <div className="grid grid-cols-[1fr_88px_88px_40px] gap-2 px-2 mb-1.5">
                        <span className="text-[10px] text-gray-600 uppercase tracking-wide">Sensor</span>
                        <span className="text-[10px] text-gray-600 uppercase tracking-wide text-center">Min</span>
                        <span className="text-[10px] text-gray-600 uppercase tracking-wide text-center">Max</span>
                        <span className="text-[10px] text-gray-600 uppercase tracking-wide text-center">On</span>
                      </div>
                      <div className="space-y-1.5">
                        {group.sensors.map(sensor => {
                          const row = thresholdRows.get(sensor.key);
                          if (!row) return null;
                          return (
                            <div
                              key={sensor.key}
                              className={`grid grid-cols-[1fr_88px_88px_40px] gap-2 items-center px-3 py-2.5 rounded-xl border ${
                                row.dirty ? 'border-blue-700/50 bg-blue-900/10' : 'border-gray-800 bg-gray-800/30'
                              }`}
                            >
                              <div>
                                <p className="text-sm text-white font-medium">{sensor.label}</p>
                                {sensor.unit && <p className="text-xs text-gray-500">{sensor.unit}</p>}
                              </div>
                              <input
                                type="number"
                                value={row.min_value}
                                onChange={e => updateThreshRow(sensor.key, 'min_value', e.target.value)}
                                placeholder="—"
                                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:border-blue-500"
                              />
                              <input
                                type="number"
                                value={row.max_value}
                                onChange={e => updateThreshRow(sensor.key, 'max_value', e.target.value)}
                                placeholder="—"
                                className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm text-center focus:outline-none focus:border-blue-500"
                              />
                              <button
                                onClick={() => updateThreshRow(sensor.key, 'alert_enabled', !row.alert_enabled)}
                                className="flex justify-center"
                                title={row.alert_enabled ? 'Alerts enabled' : 'Alerts disabled'}
                              >
                                {row.alert_enabled
                                  ? <ToggleRight className="w-6 h-6 text-green-400" />
                                  : <ToggleLeft  className="w-6 h-6 text-gray-600" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {threshError && (
              <p className="text-xs text-red-400 text-center mt-3">{threshError}</p>
            )}

            <button
              onClick={saveThresholds}
              disabled={threshSaving || threshLoading}
              className="mt-5 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium text-sm transition-colors"
            >
              {threshSaving
                ? <Loader className="w-4 h-4 animate-spin" />
                : threshSaveOk
                  ? <CheckCircle className="w-4 h-4 text-green-300" />
                  : <Save className="w-4 h-4" />}
              {threshSaving ? 'Saving…' : threshSaveOk
                ? (threshVehicleId === '__fleet__' ? 'Applied to fleet!' : 'Saved!')
                : 'Save Thresholds'}
            </button>
          </div>
        </div>
      )}

      {/* ── Tab: Settings ─────────────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        <div className="max-w-lg space-y-6">

          {/* Fleet join code card */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/15 rounded-lg">
                <Link2 className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <p className="text-white font-semibold">Fleet Join Code</p>
                <p className="text-gray-400 text-xs">
                  Share this code with drivers so they can join your fleet from the mobile app — no invite needed.
                </p>
              </div>
            </div>

            {fleetName && (
              <p className="text-xs text-gray-500">
                Fleet: <span className="text-gray-300 font-medium">{fleetName}</span>
              </p>
            )}

            <div className="flex items-center gap-3">
              <div className="flex-1 flex items-center justify-center bg-gray-800 border border-gray-700 rounded-xl py-4">
                <span className="text-3xl font-mono font-bold tracking-[0.3em] text-white">
                  {fleetJoinCode || '——'}
                </span>
              </div>
              <button
                onClick={handleCopyJoinCode}
                disabled={!fleetJoinCode}
                className="flex flex-col items-center gap-1 px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl transition-colors disabled:opacity-40"
                title="Copy join code"
              >
                {joinCodeCopied
                  ? <CheckCircle className="w-5 h-5 text-green-400" />
                  : <Copy className="w-5 h-5 text-gray-400" />}
                <span className="text-[10px] text-gray-500">{joinCodeCopied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>

            <p className="text-xs text-gray-600">
              Drivers open the FTPGo mobile app → tap <span className="text-gray-400">Join Fleet</span> → enter this code to be added to your fleet automatically.
            </p>
          </div>

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

          {/* ── Danger Zone ─────────────────────────────────────────────────── */}
          <div className="bg-gray-900 rounded-xl border border-red-800/60 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-500/15 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <p className="text-red-400 font-semibold">Danger Zone</p>
                <p className="text-gray-400 text-xs">
                  Irreversible actions that permanently destroy data.
                </p>
              </div>
            </div>

            <div className="border border-red-900/50 rounded-xl p-4 space-y-3 bg-red-950/20">
              <p className="text-white font-medium text-sm">Delete Fleet &amp; All Data</p>
              <p className="text-gray-400 text-xs leading-relaxed">
                Permanently removes your fleet and every piece of data linked to it:
              </p>
              <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
                <li>All vehicles and their sensor history</li>
                <li>All trips, alerts, and cost predictions</li>
                <li>All driver accounts and their credentials</li>
                <li>Subscription, invite codes, and audit logs</li>
                <li>OBD device health records and thresholds</li>
              </ul>
              <p className="text-xs text-red-400 font-medium pt-1">
                This action cannot be undone. Your manager account will be signed out immediately.
              </p>
              <button
                onClick={openDeleteModal}
                className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete Fleet and All Data…
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Fleet Confirmation Modal ────────────────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-red-800/70 rounded-2xl w-full max-w-md p-6 space-y-5">

            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-red-500/15 rounded-xl">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <div>
                <h2 className="text-white font-bold text-lg">Delete Fleet</h2>
                <p className="text-gray-400 text-xs">This is permanent and cannot be reversed.</p>
              </div>
            </div>

            {/* Loading state while fleet is fetched */}
            {modalLoading ? (
              <div className="flex items-center justify-center gap-3 py-6 text-gray-400 text-sm">
                <Loader className="w-5 h-5 animate-spin" />
                Looking up your fleet…
              </div>
            ) : (
              <>
                {/* What will be deleted */}
                <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-4 space-y-2">
                  <p className="text-red-300 text-xs font-semibold uppercase tracking-wide">
                    The following will be permanently deleted:
                  </p>
                  <ul className="text-xs text-gray-400 space-y-1 list-disc list-inside">
                    <li>
                      Fleet:{' '}
                      <span className="text-white font-medium">
                        {modalFleetName || '—'}
                      </span>
                    </li>
                    <li>All vehicles, sensor data, trips &amp; alerts</li>
                    <li>All driver accounts and credentials</li>
                    <li>Subscription, billing history &amp; audit logs</li>
                  </ul>
                </div>

                {/* Confirm by typing fleet name — only shown when name resolved */}
                {modalFleetName && (
                  <div className="space-y-2">
                    <label className="text-sm text-gray-300">
                      Type{' '}
                      <span className="text-white font-mono font-semibold">
                        {modalFleetName}
                      </span>{' '}
                      to confirm:
                    </label>
                    <input
                      type="text"
                      value={deleteConfirmName}
                      onChange={e => { setDeleteConfirmName(e.target.value); setDeleteError(null); }}
                      placeholder={modalFleetName}
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-red-500 text-sm"
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                )}

                {deleteError && (
                  <div className="flex items-start gap-2 px-3 py-2.5 bg-red-900/20 border border-red-700/40 rounded-lg text-red-400 text-xs">
                    <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    {deleteError}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-3 pt-1">
                  <button
                    onClick={() => setShowDeleteModal(false)}
                    disabled={deleting}
                    className="flex-1 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteFleet}
                    disabled={
                      deleting ||
                      !modalFleetId ||
                      (modalFleetName
                        ? deleteConfirmName.trim() !== modalFleetName.trim()
                        : true)
                    }
                    className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    {deleting
                      ? <><Loader className="w-4 h-4 animate-spin" /> Deleting…</>
                      : <><Trash2 className="w-4 h-4" /> Permanently Delete</>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Plan checkout modal (1.2.2 + 1.2.3 + 1.3.1) ─────────────────────── */}
      {checkoutPlan && (
        <PlanCheckoutModal
          plan={checkoutPlan}
          vehiclesUsed={vehiclesUsed}
          annualUnlocked={annualUnlockedAt != null}
          initialBilling={billingDetails ?? undefined}
          onClose={() => setCheckoutPlan(null)}
          onSaveBilling={handleSaveBillingDetails}
          onContinue={handleCheckoutContinue}
        />
      )}

      {/* ── Cancel-subscription modal (Phase 3.2) ─────────────────────────── */}
      {showCancelModal && (
        <CancelSubscriptionModal
          onClose={() => setShowCancelModal(false)}
          /* Save flow (Phase 3.14): when the customer picks
             `temporary_pause` as their reason, the modal offers a
             "Pause instead" CTA. We hand it through only when the
             current sub state actually allows pausing — same gate as
             the Subscription tab's pause-link footer. Mirroring that
             gate here keeps us from offering an option the customer
             can't take. */
          onPauseInstead={
            subscription?.status === 'active' && subscription.razorpay_subscription_id
              ? () => {
                  setShowCancelModal(false);
                  setPauseModalAction('pause');
                }
              : undefined
          }
        />
      )}

      {/* ── Pause / resume modal (Phase 3.4) ─────────────────────────────── */}
      {pauseModalAction && (
        <PauseSubscriptionModal
          action={pauseModalAction}
          onClose={() => setPauseModalAction(null)}
        />
      )}
    </div>
  );
}
