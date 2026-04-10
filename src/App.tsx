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
import DebugToolsPage from './pages/DebugToolsPage';
import FleetMapPage from './pages/FleetMapPage';
import { realtimeService } from './services/realtimeService';

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
  | 'admin'
  | 'debug';

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState<Page>('overview');
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
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

  return (
    <Layout currentPage={currentPage} onNavigate={handleNavigate}>
      {selectedVehicle ? (
        <VehicleDetail vehicle={selectedVehicle} onBack={handleBackFromVehicle} />
      ) : (
        <>
          {currentPage === 'overview'       && <FleetOverview />}
          {currentPage === 'vehicles'       && <VehiclesPage onSelectVehicle={handleSelectVehicle} />}
          {currentPage === 'map'            && <FleetMapPage />}
          {currentPage === 'alerts'         && <AlertsPage />}
          {currentPage === 'analytics'      && <AnalyticsPage />}
          {currentPage === 'trips'          && <TripsPage />}
          {currentPage === 'fuel'           && <FuelAnalyticsPage />}
          {currentPage === 'driver-scoring' && <DriverScoringPage />}
          {currentPage === 'cost'           && <CostAnalyticsPage />}
          {currentPage === 'maintenance'    && <MaintenancePage />}
          {currentPage === 'anomalies'      && <AnomalyFeedPage />}
          {currentPage === 'admin'          && <AdminPage />}
          {currentPage === 'debug'          && <DebugToolsPage />}
        </>
      )}
    </Layout>
  );
}

export default App;
