import { ReactNode } from 'react';
import {
  Car, Activity, AlertTriangle, BarChart3, LogOut,
  Route, Fuel, Users, DollarSign, Wrench, Zap,
  Settings, Bug, Map,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Page } from '../App';

interface LayoutProps {
  children: ReactNode;
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const fleetNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'overview',  label: 'Fleet Overview', icon: Car },
  { id: 'vehicles',  label: 'Vehicles',        icon: Activity },
  { id: 'map',       label: 'Fleet Map',        icon: Map },
  { id: 'alerts',    label: 'Alerts & Events',  icon: AlertTriangle },
];

const intelligenceNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'analytics',      label: 'Driver Analytics',  icon: BarChart3 },
  { id: 'trips',          label: 'Trips',              icon: Route },
  { id: 'fuel',           label: 'Fuel Analytics',     icon: Fuel },
  { id: 'driver-scoring', label: 'Driver Scoring',     icon: Users },
  { id: 'cost',           label: 'Cost Analytics',     icon: DollarSign },
  { id: 'maintenance',    label: 'Maintenance',        icon: Wrench },
  { id: 'anomalies',      label: 'Anomaly Feed',       icon: Zap },
];

const systemNavItems: Array<{ id: Page; label: string; icon: typeof Car }> = [
  { id: 'admin', label: 'Admin',       icon: Settings },
  { id: 'debug', label: 'Debug Tools', icon: Bug },
];

export default function Layout({ children, currentPage, onNavigate }: LayoutProps) {
  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  const NavItem = ({ item }: { item: typeof fleetNavItems[0] }) => {
    const Icon = item.icon;
    const active = currentPage === item.id;
    return (
      <button
        onClick={() => onNavigate(item.id)}
        className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg transition-colors text-left ${
          active
            ? 'bg-blue-600 text-white'
            : 'text-gray-400 hover:text-white hover:bg-gray-800'
        }`}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <span className="text-sm font-medium truncate">{item.label}</span>
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 flex">
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-800 flex items-center space-x-3">
          <div className="p-1.5 bg-blue-600 rounded-lg">
            <Car className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-white font-bold text-sm leading-tight">Fleet</p>
            <p className="text-blue-400 text-xs">Telemetry</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          <div>
            <p className="px-3 mb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Fleet</p>
            <div className="space-y-1">
              {fleetNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className="px-3 mb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Intelligence</p>
            <div className="space-y-1">
              {intelligenceNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
          <div>
            <p className="px-3 mb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-widest">System</p>
            <div className="space-y-1">
              {systemNavItems.map(item => <NavItem key={item.id} item={item} />)}
            </div>
          </div>
        </nav>

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

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
