import {
  createContext, useContext, useState,
  useEffect, useCallback, useRef,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanName    = 'trial' | 'starter' | 'growth' | 'pro' | 'enterprise';
export type PlanStatus  = 'trial' | 'active'  | 'expired' | 'suspended' | 'inactive';
export type FeatureLevel = 'full'  | 'limited' | 'none';

export interface SubscriptionState {
  // Identity
  plan:            PlanName | null;
  planDisplayName: string;
  status:          PlanStatus | null;
  priceInr:        number;
  fleetId:         string | null;

  // Limits
  vehicleLimit:  number;   // -1 = unlimited
  driverLimit:   number;
  vehiclesUsed:  number;
  driversUsed:   number;
  canAddVehicle: boolean;

  // Trial timing
  trialEndsAt:    Date | null;
  trialDaysLeft:  number | null;  // null when not on trial
  gracePeriodEnd: Date | null;
  isExpired:      boolean;
  isInGrace:      boolean;        // expired but within 7-day grace window

  // Feature access
  feature: (name: string) => FeatureLevel;

  // Meta
  loading: boolean;
  refresh: () => void;
}

// ─── Defaults (used while loading or when unauthenticated) ───────────────────

const noop = () => {};

const DEFAULT_STATE: SubscriptionState = {
  plan:            null,
  planDisplayName: '',
  status:          null,
  priceInr:        0,
  fleetId:         null,
  vehicleLimit:    2,
  driverLimit:     3,
  vehiclesUsed:    0,
  driversUsed:     0,
  canAddVehicle:   true,
  trialEndsAt:     null,
  trialDaysLeft:   null,
  gracePeriodEnd:  null,
  isExpired:       false,
  isInGrace:       false,
  // While loading, default every feature to 'full' so pages render normally
  // and don't flash the upgrade prompt before data arrives.
  feature:  () => 'full',
  loading:  true,
  refresh:  noop,
};

// ─── Context ─────────────────────────────────────────────────────────────────

const SubscriptionContext = createContext<SubscriptionState>(DEFAULT_STATE);

// ─── Provider ────────────────────────────────────────────────────────────────

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SubscriptionState>({ ...DEFAULT_STATE });
  const [tick, setTick]   = useState(0);
  const channelRef        = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  // Re-load whenever the user signs in or out.
  // SubscriptionProvider sits above AppInner so it doesn't automatically
  // re-run when AppInner's auth state changes — we must listen ourselves.
  // INITIAL_SESSION is intentionally excluded: tick=0 already covers the
  // initial load, and including it would cause a redundant second fetch.
  useEffect(() => {
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange(
      (event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          setTick(t => t + 1);
        }
      },
    );
    return () => authSub.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user || cancelled) { setState(s => ({ ...s, loading: false })); return; }

        // ── Fleet ────────────────────────────────────────────────────────────
        // maybeSingle() returns null on 0 rows instead of throwing PGRST116.
        // .single() was silently crashing here and leaving fleetId = null for
        // the entire session, disabling every fleet-dependent feature.
        const { data: fleet, error: fleetErr } = await supabase
          .from('fleets')
          .select('id')
          .eq('manager_id', user.id)
          .maybeSingle();

        if (fleetErr) throw fleetErr;
        if (!fleet || cancelled) { setState(s => ({ ...s, loading: false })); return; }
        const fleetId = fleet.id as string;

        // ── Parallel fetch ────────────────────────────────────────────────────
        const [subRes, vehicleRes, driverRes] = await Promise.all([
          supabase.from('subscriptions').select('*').eq('fleet_id', fleetId).single(),
          supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
          supabase.from('driver_accounts').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
        ]);

        if (cancelled) return;
        const sub = subRes.data;
        if (!sub) { setState(s => ({ ...s, loading: false, fleetId })); return; }

        // ── Plan definition ───────────────────────────────────────────────────
        const { data: planDef } = await supabase
          .from('plan_definitions')
          .select('*')
          .eq('plan_name', sub.plan)
          .single();

        if (cancelled) return;

        // ── Merge feature flags (custom enterprise overrides take priority) ───
        const planFlags: Record<string, unknown>   = (planDef?.feature_flags   as Record<string, unknown>) ?? {};
        const customFlags: Record<string, unknown> = (sub.features             as Record<string, unknown>) ?? {};
        const mergedFlags = { ...planFlags, ...customFlags };

        const feature = (name: string): FeatureLevel => {
          if (sub.status === 'suspended') return 'none';
          // Expired beyond grace → deny everything
          const gracePeriodEnd = sub.grace_period_end ? new Date(sub.grace_period_end as string) : null;
          if (sub.status === 'expired' && (!gracePeriodEnd || gracePeriodEnd < new Date())) {
            return 'none';
          }
          const flag = mergedFlags[name];
          if (flag === true || flag === 'full')    return 'full';
          if (flag === 'limited')                  return 'limited';
          return 'none';
        };

        // ── Trial timing ──────────────────────────────────────────────────────
        const trialEndsAt    = sub.trial_ends_at    ? new Date(sub.trial_ends_at    as string) : null;
        const gracePeriodEnd = sub.grace_period_end ? new Date(sub.grace_period_end as string) : null;
        const now            = new Date();
        const isExpired      = sub.status === 'expired';
        const isInGrace      = isExpired && gracePeriodEnd != null && gracePeriodEnd > now;

        let trialDaysLeft: number | null = null;
        if (sub.status === 'trial' && trialEndsAt) {
          trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000));
        }

        // ── Limits ────────────────────────────────────────────────────────────
        const vehicleLimit = (sub.max_vehicles as number) ?? (planDef?.vehicle_limit as number) ?? 2;
        const driverLimit  = (sub.max_drivers  as number) ?? (planDef?.driver_limit  as number) ?? 3;
        const vehiclesUsed = vehicleRes.count ?? 0;
        const driversUsed  = driverRes.count  ?? 0;

        const canAddVehicle =
          !isExpired &&
          sub.status !== 'suspended' &&
          (vehicleLimit < 0 || vehiclesUsed < vehicleLimit);

        setState({
          plan:            sub.plan            as PlanName,
          planDisplayName: (planDef?.display_name as string) ?? sub.plan,
          status:          sub.status          as PlanStatus,
          priceInr:        (planDef?.price_inr as number) ?? 0,
          fleetId,
          vehicleLimit,
          driverLimit,
          vehiclesUsed,
          driversUsed,
          canAddVehicle,
          trialEndsAt,
          trialDaysLeft,
          gracePeriodEnd,
          isExpired,
          isInGrace,
          feature,
          loading: false,
          refresh,
        });

        // ── Realtime: re-fetch on subscription row update ─────────────────────
        channelRef.current?.unsubscribe();
        channelRef.current = supabase
          .channel(`sub-watch-${fleetId}`)
          .on(
            'postgres_changes',
            {
              event:  'UPDATE',
              schema: 'public',
              table:  'subscriptions',
              filter: `fleet_id=eq.${fleetId}`,
            },
            () => setTick(t => t + 1),
          )
          .subscribe();

      } catch (err) {
        console.error('[useSubscription] load error:', err);
        if (!cancelled) setState(s => ({ ...s, loading: false }));
      }
    };

    load();

    return () => {
      cancelled = true;
      channelRef.current?.unsubscribe();
      channelRef.current = null;
    };
  }, [tick, refresh]);

  return (
    <SubscriptionContext.Provider value={state}>
      {children}
    </SubscriptionContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSubscription(): SubscriptionState {
  return useContext(SubscriptionContext);
}

// ─── Feature → minimum required plan (for upgrade prompt copy) ───────────────

export const FEATURE_MIN_PLAN: Record<string, PlanName> = {
  fuel_monitoring:       'starter',
  idle_detection:        'starter',
  driver_behavior:       'growth',
  maintenance_alerts:    'growth',
  cost_analytics:        'growth',
  multi_user:            'growth',
  ai_prediction:         'pro',
  fuel_theft_detection:  'pro',
  api_access:            'pro',
  custom_reports:        'pro',
  priority_support:      'pro',
};

export const FEATURE_DISPLAY: Record<string, string> = {
  live_tracking:         'Live Tracking',
  trip_history:          'Trip History',
  vehicle_status:        'Vehicle Status',
  basic_reports:         'Basic Reports',
  fuel_monitoring:       'Fuel Monitoring',
  driver_behavior:       'Driver Behaviour Analytics',
  maintenance_alerts:    'Maintenance Predictions',
  cost_analytics:        'Cost Analytics',
  idle_detection:        'Idle Detection',
  overspeed_alerts:      'Overspeed Alerts',
  ai_prediction:         'AI Predictions & Anomaly Detection',
  fuel_theft_detection:  'Fuel Theft Detection',
  multi_user:            'Multi-User Access',
  api_access:            'API Access',
  custom_reports:        'Custom Reports',
  priority_support:      'Priority Support',
};

export const PLAN_DISPLAY_NAME: Record<PlanName, string> = {
  trial:      'Trial',
  starter:    'Starter',
  growth:     'Growth',
  pro:        'Pro',
  enterprise: 'Enterprise',
};
