import { ReactNode } from 'react';
import {
  Car, Activity, AlertTriangle, BarChart3, LogOut,
  Route, Fuel, Users, DollarSign, Wrench, Zap,
  Settings, Bug, Map, MapPin, Lock, FileText,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSubscription } from '../hooks/useSubscription';
import TrialBanner from './TrialBanner';
import LanguageSwitcher from './LanguageSwitcher';
import type { Page } from '../App';

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

const fleetNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'overview',   label: 'Fleet Overview', icon: Car },
  { id: 'vehicles',   label: 'Vehicles',        icon: Activity },
  { id: 'map',        label: 'Fleet Map',        icon: Map },
  { id: 'geofences',  label: 'Geofences',        icon: MapPin },
  { id: 'alerts',     label: 'Alerts & Events',  icon: AlertTriangle },
];

const intelligenceNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'analytics',      label: 'Driver Analytics',  icon: BarChart3 },
  { id: 'trips',          label: 'Trips',              icon: Route },
  { id: 'fuel',           label: 'Fuel Analytics',     icon: Fuel },
  { id: 'driver-scoring', label: 'Driver Scoring',     icon: Users },
  { id: 'cost',           label: 'Cost Analytics',     icon: DollarSign },
  { id: 'maintenance',    label: 'Maintenance',        icon: Wrench },
  { id: 'anomalies',      label: 'Anomaly Feed',       icon: Zap },
  { id: 'reports',        label: 'Reports',            icon: FileText },
];

const systemNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'admin', label: 'Admin',       icon: Settings },
  { id: 'debug', label: 'Debug Tools', icon: Bug },
];

export default function Layout({ children, currentPage, onNavigate }: LayoutProps) {
  const { feature, trialDaysLeft, planDisplayName, plan, status } =
    useSubscription();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  // ── Nav item ───────────────────────────────────────────────────────────────

  const NavItem = ({
    item,
    muted = false,
  }: {
    item: typeof fleetNavItems[0];
    muted?: boolean;
  }) => {
    const Icon     = item.icon;
    const active   = currentPage === item.id;
    const featKey  = PAGE_FEATURE[item.id];
    const locked   = featKey ? feature(featKey) === 'none' : false;

    return (
      <button
        onClick={() => onNavigate(item.id)}
        title={locked ? `Upgrade to unlock ${item.label}` : undefined}
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
          {item.label}
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
                  · {trialDaysLeft}d left
                </span>
              )}
            </span>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              fleetNavItems.some(i => i.id === currentPage) ? 'text-blue-400' : 'text-gray-500'
            }`}>Fleet</p>
            <div className="space-y-1">
              {fleetNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              intelligenceNavItems.some(i => i.id === currentPage) ? 'text-blue-400' : 'text-gray-500'
            }`}>Intelligence</p>
            <div className="space-y-1">
              {intelligenceNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest transition-colors ${
              systemNavItems.some(i => i.id === currentPage) ? 'text-blue-400' : 'text-gray-500'
            }`}>System</p>
            <div className="space-y-1">
              <NavItem item={systemNavItems[0]} />
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
            <span className="text-sm font-medium">Logout</span>
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
