import { ReactNode, useEffect, useState } from 'react';
import {
  Car, Activity, AlertTriangle, BarChart3, LogOut,
  Route, Fuel, Users, DollarSign, Wrench, Zap,
  Settings, Bug, Map, MapPin, Lock, FileText, TrendingUp,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import { useSubscription } from '../hooks/useSubscription';
import TrialBanner from './TrialBanner';
import LanguageSwitcher from './LanguageSwitcher';
import type { Page } from '../App';

/// Comma-separated list of operator email addresses — when the logged-in
/// user matches, the Insights nav item appears in the System group.
/// Cosmetic gate only; the analytics-api endpoint is admin-secret-protected
/// server-side, so a missing email check doesn't expose data.
/// Phase 2.1.
const OPERATOR_EMAILS: ReadonlySet<string> = new Set(
  (import.meta.env.VITE_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean),
);

interface LayoutProps {
  children: ReactNode;
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

// Map nav item → feature key (undefined = always accessible)
const PAGE_FEATURE: Partial<Record<Page, string>> = {
  fuel:             'fuel_monitoring',
  'driver-scoring': 'driver_behavior',
  cost:             'cost_analytics',
  maintenance:      'maintenance_alerts',
  anomalies:        'ai_prediction',
  reports:          'custom_reports',
};

// Nav items now use a translation-key field (`labelKey`) instead of a baked-in
// label. Translation happens at render time so language switches reflect
// immediately. Layout-shape stays a static module-level constant — only the
// label text varies per locale.
interface NavItemDef {
  id:       Page;
  labelKey: string;
  icon:     typeof Car;
}

const fleetNavItems: NavItemDef[] = [
  { id: 'overview',   labelKey: 'layout.navOverview',   icon: Car },
  { id: 'vehicles',   labelKey: 'layout.navVehicles',   icon: Activity },
  { id: 'map',        labelKey: 'layout.navMap',        icon: Map },
  { id: 'geofences',  labelKey: 'layout.navGeofences',  icon: MapPin },
  { id: 'alerts',     labelKey: 'layout.navAlerts',     icon: AlertTriangle },
];

const intelligenceNavItems: NavItemDef[] = [
  { id: 'analytics',      labelKey: 'layout.navAnalytics',     icon: BarChart3 },
  { id: 'trips',          labelKey: 'layout.navTrips',         icon: Route },
  { id: 'fuel',           labelKey: 'layout.navFuel',          icon: Fuel },
  { id: 'driver-scoring', labelKey: 'layout.navDriverScoring', icon: Users },
  { id: 'cost',           labelKey: 'layout.navCost',          icon: DollarSign },
  { id: 'maintenance',    labelKey: 'layout.navMaintenance',   icon: Wrench },
  { id: 'anomalies',      labelKey: 'layout.navAnomalies',     icon: Zap },
  { id: 'reports',        labelKey: 'layout.navReports',       icon: FileText },
];

const systemNavItems: NavItemDef[] = [
  { id: 'admin', labelKey: 'layout.navAdmin', icon: Settings },
  { id: 'debug', labelKey: 'layout.navDebug', icon: Bug },
];

export default function Layout({ children, currentPage, onNavigate }: LayoutProps) {
  const { t } = useTranslation();
  const { feature, trialDaysLeft, planDisplayName, plan, status } =
    useSubscription();

  // Phase 2.1 — show the Insights nav item only when the logged-in user's
  // email is in VITE_OPERATOR_EMAILS. Refreshes once on mount; the auth
  // listener that already exists in App.tsx triggers a remount via state
  // changes, so we don't need to subscribe here.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      const email = user?.email?.toLowerCase() ?? '';
      setIsOperator(!!email && OPERATOR_EMAILS.has(email));
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  // ── Nav item ───────────────────────────────────────────────────────────────

  const NavItem = ({
    item,
    muted = false,
  }: {
    item: NavItemDef;
    muted?: boolean;
  }) => {
    const Icon     = item.icon;
    const active   = currentPage === item.id;
    const featKey  = PAGE_FEATURE[item.id];
    const locked   = featKey ? feature(featKey) === 'none' : false;
    const label    = t(item.labelKey);

    return (
      <button
        onClick={() => onNavigate(item.id)}
        title={locked ? t('layout.lockTooltip', { label }) : undefined}
        className={`w-full flex items-center space-x-3 py-2.5 rounded-lg transition-colors text-left relative ${
          active
            ? 'bg-blue-600/20 text-white pl-[10px] pr-3 border-l-2 border-blue-400'
            : locked
            ? 'text-gray-600 hover:text-gray-500 hover:bg-gray-800/50 px-3 cursor-pointer'
            : muted
            ? 'text-gray-600 hover:text-gray-400 hover:bg-gray-800 px-3 opacity-70'
            : 'text-gray-400 hover:text-white hover:bg-gray-800 px-3'
        }`}
      >
        <Icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-blue-400' : locked ? 'text-gray-600' : ''}`} />
        <span className={`text-sm font-medium truncate flex-1 ${muted ? 'text-xs' : ''} ${locked ? 'text-gray-600' : ''}`}>
          {label}
        </span>
        {locked && (
          <Lock className="w-3 h-3 text-gray-600 flex-shrink-0" />
        )}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 flex">
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Logo */}
        <div className="px-4 py-5 border-b border-gray-800 flex items-center space-x-3">
          <div className="p-1.5 bg-blue-600 rounded-lg">
            <Car className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">FTPGo</p>
            <p className="text-blue-400 text-xs">Fleet Management</p>
          </div>
        </div>

        {/* Plan pill */}
        {plan && (
          <div className="px-4 pt-3 pb-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-gray-800 text-gray-400 border border-gray-700">
              {planDisplayName || plan}
              {status === 'trial' && trialDaysLeft !== null && (
                <span className={`font-bold ${trialDaysLeft <= 3 ? 'text-red-400' : 'text-yellow-400'}`}>
                  · {t('layout.planPillTrialCountdown', { count: trialDaysLeft })}
                </span>
              )}
            </span>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              fleetNavItems.some(i => i.id === currentPage) ? 'text-blue-400' : 'text-gray-500'
            }`}>{t('layout.navGroupFleet')}</p>
            <div className="space-y-1">
              {fleetNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              intelligenceNavItems.some(i => i.id === currentPage) ? 'text-blue-400' : 'text-gray-500'
            }`}>{t('layout.navGroupIntelligence')}</p>
            <div className="space-y-1">
              {intelligenceNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              (systemNavItems.some(i => i.id === currentPage) || currentPage === 'insights')
                ? 'text-blue-400' : 'text-gray-500'
            }`}>{t('layout.navGroupSystem')}</p>
            <div className="space-y-1">
              <NavItem item={systemNavItems[0]} />
              {/* Operator-only Insights link. Hidden for non-operator
                  users — the page itself is admin-secret-gated server-side
                  so visibility here is purely UX. */}
              {isOperator && (
                <NavItem item={{
                  id:       'insights',
                  labelKey: 'layout.navInsights',
                  icon:     TrendingUp,
                }} />
              )}
              <NavItem item={systemNavItems[1]} muted />
            </div>
          </div>
        </nav>

        {/* ── Language switcher (Phase 1.5.1) ─────────────────────────────── */}
        {/* Sits above Logout so the bottom of the sidebar tells a small story:
            "switch language → sign out". Logout is the more destructive action
            and stays last; language switch is a routine preference, surfaced
            here because every page needs it. */}
        <LanguageSwitcher />

        <div className="px-3 py-4 border-t border-gray-800">
          <button
            onClick={handleLogout}
            className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            <span className="text-sm font-medium">{t('layout.logout')}</span>
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* ── Trial / grace / expired / suspended banner (Phase 1.4) ──────── */}
        {/* All banner severity + copy logic lives in useTrialBannerState; this
            component just routes the CTA back to AdminPage. Returns null
            when there is nothing to say. */}
        <TrialBanner onNavigateToAdmin={() => onNavigate('admin')} />

        {/* ── Page content ──────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
