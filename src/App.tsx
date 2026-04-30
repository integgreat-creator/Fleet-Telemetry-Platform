import { useState, useEffect, lazy, Suspense } from 'react';
import { supabase, type Vehicle } from './lib/supabase';
import Auth from './components/Auth';
import Layout from './components/Layout';
import { realtimeService } from './services/realtimeService';
import { SubscriptionProvider, useSubscription } from './hooks/useSubscription';
import { PendingCheckoutProvider } from './hooks/usePendingCheckout';
import FeatureGate from './components/FeatureGate';

// ─── Lazy page imports ────────────────────────────────────────────────────────
// Each page becomes its own JS chunk loaded only when first navigated to.
// This cuts the initial bundle from ~500 KB down to ~120 KB, dramatically
// improving Time-to-Interactive on the login/overview screens.
const FleetOverview     = lazy(() => import('./pages/FleetOverview'));
const VehiclesPage      = lazy(() => import('./pages/VehiclesPage'));
const VehicleDetail     = lazy(() => import('./pages/VehicleDetail'));
const AlertsPage        = lazy(() => import('./pages/AlertsPage'));
const AnalyticsPage     = lazy(() => import('./pages/AnalyticsPage'));
const TripsPage         = lazy(() => import('./pages/TripsPage'));
const FuelAnalyticsPage = lazy(() => import('./pages/FuelAnalyticsPage'));
const DriverScoringPage = lazy(() => import('./pages/DriverScoringPage'));
const CostAnalyticsPage = lazy(() => import('./pages/CostAnalyticsPage'));
const MaintenancePage   = lazy(() => import('./pages/MaintenancePage'));
const AnomalyFeedPage   = lazy(() => import('./pages/AnomalyFeedPage'));
const AdminPage         = lazy(() => import('./pages/AdminPage'));
const ReportsPage       = lazy(() => import('./pages/ReportsPage'));
const DebugToolsPage    = lazy(() => import('./pages/DebugToolsPage'));
const FleetMapPage      = lazy(() => import('./pages/FleetMapPage'));
const GeofencesPage     = lazy(() => import('./pages/GeofencesPage'));
// Operator-only — admin-secret gated server-side, hidden from the sidebar
// for non-operator users (Phase 2.1).
const InsightsPage      = lazy(() => import('./pages/InsightsPage'));

// Shown while a lazy page chunk is downloading (first visit to that page only)
function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

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
  | 'insights'
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

// ─── No-Fleet Screen ──────────────────────────────────────────────────────────
// Shown when a manager is authenticated but has no fleet (e.g. after deletion).

function NoFleetScreen() {
  const [signingOut, setSigningOut] = useState(false);

  const handleSignUp = async () => {
    setSigningOut(true);
    await supabase.auth.signOut({ scope: 'global' });
    window.location.href = '/';
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">

        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-amber-600/20 border border-amber-500/30 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3 9.75L12 3l9 6.75V21a.75.75 0 01-.75.75H15v-6H9v6H3.75A.75.75 0 013 21V9.75z" />
          </svg>
        </div>

        {/* Heading */}
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">No Fleet Found</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Your account is not linked to any fleet. This happens when a fleet has been
            deleted or was never set up for this account.
          </p>
        </div>

        {/* Instruction card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-left space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">What to do</p>
          <p className="text-sm text-gray-300">
            Sign up to create a new fleet. You will need to register with a fleet name and
            your credentials to get started again.
          </p>
        </div>

        {/* CTA */}
        <button
          onClick={handleSignUp}
          disabled={signingOut}
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2"
        >
          {signingOut
            ? <><span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Signing out…</>
            : 'Sign Out & Sign Up'}
        </button>

      </div>
    </div>
  );
}

// ─── App Inner ────────────────────────────────────────────────────────────────

function AppInner() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isDriver, setIsDriver] = useState(false);

  // Subscription context — used to detect "no fleet" for authenticated managers.
  const { fleetId, loading: subLoading } = useSubscription();
  const [currentPage, setCurrentPage] = useState<Page>('overview');
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);

  useEffect(() => {
    // Safety net: unblock the UI if getSession() hangs (e.g. stale token).
    // 3 s is enough for any reasonable network; 5 s was unnecessarily long.
    const timeout = setTimeout(() => setLoading(false), 3000);

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null;
      if (u) {
        // Run token refresh and driver-role check in parallel.
        // The user ID never changes between refresh cycles so both queries
        // can use the pre-refresh ID safely — saves one sequential round-trip.
        const [refreshResult, driverResult] = await Promise.all([
          supabase.auth.refreshSession(),
          supabase.from('driver_accounts').select('id').eq('user_id', u.id).limit(1),
        ]);
        setUser(refreshResult.data.session?.user ?? u);
        setIsDriver((driverResult.data ?? []).length > 0);
      } else {
        setUser(null);
      }
      clearTimeout(timeout);
      setLoading(false);
    }).catch(() => {
      clearTimeout(timeout);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      // INITIAL_SESSION is already handled by getSession() above — skip it
      // to avoid a duplicate driver_accounts query on every page load.
      if (event === 'INITIAL_SESSION') return;

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

  // Show spinner while auth OR subscription data is still loading
  if (loading || (user && !isDriver && subLoading)) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!user) return <Auth />;
  if (isDriver) return <DriverBlockedScreen />;

  // Authenticated manager with no fleet — show signup prompt instead of broken dashboard
  if (!fleetId) return <NoFleetScreen />;

  // Shorthand so each FeatureGate can redirect to Admin for upgrade
  const toAdmin = () => handleNavigate('admin');

  return (
    <Layout currentPage={currentPage} onNavigate={handleNavigate}>
      {/* Suspense catches lazy chunks downloading on first navigation.
          The Layout shell (sidebar/header) stays visible; only the content
          area shows the spinner while the page chunk loads. */}
      <Suspense fallback={<PageLoader />}>
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

            {currentPage === 'admin'    && <AdminPage />}
            {currentPage === 'insights' && <InsightsPage />}
            {currentPage === 'debug'    && <DebugToolsPage />}
          </>
        )}
      </Suspense>
    </Layout>
  );
}

function App() {
  // Provider order matters: PendingCheckoutProvider has no dependencies on
  // subscription state, but consumers (TrialBanner) read both — so any
  // ordering works. Putting subscription outermost matches existing
  // assumptions in components that read useSubscription before mount.
  return (
    <SubscriptionProvider>
      <PendingCheckoutProvider>
        <AppInner />
      </PendingCheckoutProvider>
    </SubscriptionProvider>
  );
}

export default App;
