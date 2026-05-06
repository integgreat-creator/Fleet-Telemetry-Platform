import {
  createContext, useContext, useState,
  useEffect, useCallback, useRef,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

// Active plans (selectable by customers + shown in UI)
// Legacy names kept in the union so existing DB rows still type-check, but
// they are never rendered anywhere — PLAN_DISPLAY_NAME + FEATURE_MIN_PLAN
// + PLAN_CARDS all reference only the active plans.
export type PlanName =
  | 'trial'
  | 'essential' | 'professional' | 'business' | 'enterprise'   // active
  | 'starter'   | 'growth'       | 'pro';                       // legacy (hidden)

export type PlanStatus   = 'trial' | 'active' | 'expired' | 'suspended' | 'inactive' | 'paused';
export type FeatureLevel = 'full'  | 'limited' | 'none';
export type BillingModel = 'flat'  | 'per_vehicle' | 'custom';
export type BillingCycle = 'monthly' | 'annual';

export interface SubscriptionState {
  // Identity
  plan:            PlanName | null;
  planDisplayName: string;
  status:          PlanStatus | null;
  priceInr:        number;
  fleetId:         string | null;

  // Billing model (per-vehicle pricing support)
  billingModel:     BillingModel;
  pricePerVehicle:  number | null;   // null for flat/custom plans
  vehicleCount:     number | null;   // paid-for quota (per_vehicle model)
  gstin:            string | null;
  annualUnlockedAt: Date | null;     // set at 3-month active mark
  billingCycle:     BillingCycle;
  minVehicles:      number;          // from plan_definitions

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

  // Paid-subscription cycle
  // Used by Phase 1.6.2 to compute "renew in N days" reminders. null while
  // unloaded or on the in-app trial; set once Razorpay's first charge lands.
  currentPeriodEnd:  Date | null;

  /// Razorpay-hosted subscription page (card-on-file management, billing
  /// history, cancel). Populated by razorpay-webhook on activation. Phase
  /// 1.6.3. null while in trial / dormant Razorpay mode — the renewal CTA
  /// falls back to in-app navigation in that case.
  razorpaySubscriptionShortUrl: string | null;

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
  billingModel:     'flat',
  pricePerVehicle:  null,
  vehicleCount:     null,
  gstin:            null,
  annualUnlockedAt: null,
  billingCycle:     'monthly',
  minVehicles:      1,
  vehicleLimit:    2,
  driverLimit:     3,
  vehiclesUsed:    0,
  driversUsed:     0,
  canAddVehicle:   true,
  trialEndsAt:     null,
  trialDaysLeft:   null,
  gracePeriodEnd:  null,
  isExpired:       false,
  currentPeriodEnd: null,
  razorpaySubscriptionShortUrl: null,
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
        if (event === 'SIGNED_IN') {
          // Set loading:true immediately so App.tsx shows the spinner
          // instead of NoFleetScreen during the gap between SIGNED_IN
          // firing and the re-fetch effect actually completing.
          setState(s => ({ ...s, loading: true }));
          setTick(t => t + 1);
        } else if (event === 'SIGNED_OUT') {
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
        // plan_definitions is a tiny static table (~5 rows). Fetching all rows
        // here lets us include it in the same round-trip instead of waiting for
        // the subscription row first, then firing a second sequential query.
        const [subRes, vehicleRes, driverRes, planDefsRes] = await Promise.all([
          supabase.from('subscriptions').select('*').eq('fleet_id', fleetId).single(),
          supabase.from('vehicles').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
          supabase.from('driver_accounts').select('id', { count: 'exact', head: true }).eq('fleet_id', fleetId),
          supabase.from('plan_definitions').select('*'),
        ]);

        if (cancelled) return;
        const sub = subRes.data;
        if (!sub) { setState(s => ({ ...s, loading: false, fleetId })); return; }

        // ── Plan definition (matched client-side from the prefetched list) ────
        const planDef = (planDefsRes.data ?? []).find(
          (p: Record<string, unknown>) => p.plan_name === sub.plan
        ) ?? null;

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

        // ── Paid-cycle timing (Phase 1.6.2) ───────────────────────────────────
        // Set by razorpay-webhook on subscription.charged. Drives the renewal
        // reminder banner that fires 14 / 7 / 1 days before the date.
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end as string)
          : null;

        // ── Razorpay-hosted subscription page (Phase 1.6.3) ───────────────────
        // Used by the renewal-reminder banner CTA. null on trial / dormant
        // Razorpay mode → CTA falls back to AdminPage navigation.
        const razorpaySubscriptionShortUrl =
          (sub.razorpay_subscription_short_url as string | null) ?? null;

        let trialDaysLeft: number | null = null;
        if (sub.status === 'trial' && trialEndsAt) {
          trialDaysLeft = Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / 86_400_000));
        }

        // ── Billing model (per_vehicle vs flat vs custom) ─────────────────────
        const billingModel     = (sub.billing_model as BillingModel | null) ?? 'flat';
        const pricePerVehicle  = (sub.price_per_vehicle_inr as number | null) ?? null;
        const vehicleCount     = (sub.vehicle_count         as number | null) ?? null;
        const gstin            = (sub.gstin                 as string | null) ?? null;
        const annualUnlockedAt = sub.annual_unlocked_at
          ? new Date(sub.annual_unlocked_at as string)
          : null;
        const billingCycle     = (sub.billing_cycle as BillingCycle | null) ?? 'monthly';
        const minVehicles      = (planDef?.min_vehicles as number | null) ?? 1;

        // ── Limits (billing-model aware) ──────────────────────────────────────
        let vehicleLimit: number;
        if (billingModel === 'per_vehicle') {
          // Per-vehicle: limit = paid-for quota (vehicle_count)
          vehicleLimit = vehicleCount ?? 0;
        } else {
          // Flat / custom: legacy path — use max_vehicles override or plan_def default
          vehicleLimit = (sub.max_vehicles as number) ?? (planDef?.vehicle_limit as number) ?? 2;
        }

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
          billingModel,
          pricePerVehicle,
          vehicleCount,
          gstin,
          annualUnlockedAt,
          billingCycle,
          minVehicles,
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
          currentPeriodEnd,
          razorpaySubscriptionShortUrl,
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

// Feature → minimum plan required to unlock it.
// Maps only to active plans — legacy starter/growth/pro are never referenced.
export const FEATURE_MIN_PLAN: Record<string, PlanName> = {
  fuel_monitoring:       'essential',
  idle_detection:        'essential',
  overspeed_alerts:      'essential',
  driver_behavior:       'professional',
  maintenance_alerts:    'professional',
  cost_analytics:        'professional',
  multi_user:            'professional',
  ai_prediction:         'business',
  fuel_theft_detection:  'business',
  api_access:            'business',
  custom_reports:        'business',
  priority_support:      'business',
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

// Only active plans have display names. Legacy plans (starter/growth/pro)
// intentionally omitted — if a legacy row somehow appears, UI should fall back
// to subscription.plan_display_name from the DB row itself.
export const PLAN_DISPLAY_NAME: Partial<Record<PlanName, string>> = {
  trial:        'Trial',
  essential:    'Essential',
  professional: 'Professional',
  business:     'Business',
  enterprise:   'Enterprise',
};
