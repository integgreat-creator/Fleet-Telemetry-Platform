import { useState, useEffect } from 'react';
import { supabase, type Vehicle } from './lib/supabase';
import Auth from './components/Auth';
import Layout from './components/Layout';
import FleetOverview from './pages/FleetOverview';
import VehiclesPage from './pages/VehiclesPage';
import VehicleDetail from './pages/VehicleDetail';
import AlertsPage from './pages/AlertsPage';
import AnalyticsPage from './pages/AnalyticsPage';
import TripsPage from './pages/TripsPage';
import FuelAnalyticsPage from './pages/FuelAnalyticsPage';
import DriverScoringPage from './pages/DriverScoringPage';
import CostAnalyticsPage from './pages/CostAnalyticsPage';
import MaintenancePage from './pages/MaintenancePage';
import AnomalyFeedPage from './pages/AnomalyFeedPage';
import AdminPage from './pages/AdminPage';
import ReportsPage from './pages/ReportsPage';
import DebugToolsPage from './pages/DebugToolsPage';
import FleetMapPage from './pages/FleetMapPage';
import GeofencesPage from './pages/GeofencesPage';
import { realtimeService } from './services/realtimeService';
import { SubscriptionProvider } from './hooks/useSubscription';
import FeatureGate from './components/FeatureGate';

export type Page =
  | 'overview'
  | 'vehicles'
  | 'map'
  | 'alerts'
  | 'analytics'
  | 'trips'
  | 'fuel'
  | 'driver-scoring'
  | 'cost'
  | 'maintenance'
  | 'anomalies'
  | 'reports'
  | 'geofences'
  | 'admin'
  | 'debug';

function DriverBlockedScreen() {
  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8.5 7.5A3.5 3.5 0 0115.5 7.5M7 10a5 5 0 0110 0M5 19h14a2 2 0 002-2v-1a7 7 0 00-14 0v1a2 2 0 002 2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">Driver Portal</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            This web dashboard is for fleet managers only. Drivers access FTPGo through the mobile app.
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-left space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Get the mobile app</p>
          <p className="text-sm text-gray-300">Search <span className="text-blue-400 font-medium">FTPGo</span> on the Google Play Store or App Store to access your driver dashboard.</p>
        </div>
        <button
          onClick={handleLogout}
          className="w-full py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function AppInner() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isDriver, setIsDriver] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('overview');
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        const { data } = await supabase
          .from('driver_accounts')
          .select('id')
          .eq('user_id', u.id)
          .limit(1);
        setIsDriver((data ?? []).length > 0);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) {
        const { data } = await supabase
          .from('driver_accounts')
          .select('id')
          .eq('user_id', u.id)
          .limit(1);
        setIsDriver((data ?? []).length > 0);
      } else {
        setIsDriver(false);
      }
    });

    return () => {
      subscription.unsubscribe();
      realtimeService.stopAllSimulations();
    };
  }, []);

  const handleNavigate = (page: Page) => {
    setCurrentPage(page);
    setSelectedVehicle(null);
  };

  const handleSelectVehicle = (vehicle: Vehicle) => {
    setSelectedVehicle(vehicle);
  };

  const handleBackFromVehicle = () => {
    setSelectedVehicle(null);
    setCurrentPage('vehicles');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!user) return <Auth />;
  if (isDriver) return <DriverBlockedScreen />;

  // Shorthand so each FeatureGate can redirect to Admin for upgrade
  const toAdmin = () => handleNavigate('admin');

  return (
    <Layout currentPage={currentPage} onNavigate={handleNavigate}>
      {selectedVehicle ? (
        <VehicleDetail vehicle={selectedVehicle} onBack={handleBackFromVehicle} />
      ) : (
        <>
          {currentPage === 'overview'  && <FleetOverview onNavigate={handleNavigate} />}
          {currentPage === 'vehicles'  && (
            <VehiclesPage
              onSelectVehicle={handleSelectVehicle}
              onNavigate={handleNavigate}
            />
          )}
          {currentPage === 'map'       && <FleetMapPage />}
          {currentPage === 'alerts'    && <AlertsPage />}
          {currentPage === 'analytics' && <AnalyticsPage />}
          {currentPage === 'trips'     && <TripsPage />}

          {currentPage === 'fuel' && (
            <FeatureGate feature="fuel_monitoring" onNavigateToAdmin={toAdmin}>
              <FuelAnalyticsPage />
            </FeatureGate>
          )}

          {currentPage === 'driver-scoring' && (
            <FeatureGate feature="driver_behavior" onNavigateToAdmin={toAdmin}>
              <DriverScoringPage />
            </FeatureGate>
          )}

          {currentPage === 'cost' && (
            <FeatureGate feature="cost_analytics" onNavigateToAdmin={toAdmin}>
              <CostAnalyticsPage />
            </FeatureGate>
          )}

          {currentPage === 'maintenance' && (
            <FeatureGate feature="maintenance_alerts" onNavigateToAdmin={toAdmin}>
              <MaintenancePage />
            </FeatureGate>
          )}

          {currentPage === 'anomalies' && (
            <FeatureGate feature="ai_prediction" onNavigateToAdmin={toAdmin}>
              <AnomalyFeedPage />
            </FeatureGate>
          )}

          {currentPage === 'reports' && (
            <FeatureGate feature="custom_reports" onNavigateToAdmin={toAdmin}>
              <ReportsPage />
            </FeatureGate>
          )}

          {currentPage === 'geofences' && <GeofencesPage />}

          {currentPage === 'admin' && <AdminPage />}
          {currentPage === 'debug' && <DebugToolsPage />}
        </>
      )}
    </Layout>
  );
}

function App() {
  return (
    <SubscriptionProvider>
      <AppInner />
    </SubscriptionProvider>
  );
}

export default App;
