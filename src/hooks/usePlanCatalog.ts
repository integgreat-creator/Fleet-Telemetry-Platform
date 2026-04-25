import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { PlanName, BillingModel } from './useSubscription';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PlanCatalogEntry {
  planName:            PlanName;
  displayName:         string;
  billingModel:        BillingModel;
  pricePerVehicleInr:  number | null;  // null for custom (enterprise)
  minVehicles:         number;
  vehicleLimit:        number;          // -1 = unlimited
  driverLimit:         number;          // -1 = unlimited
  trialDays:           number;
  featureFlags:        Record<string, unknown>;
  sortOrder:           number;
  annualDiscountPct:   number;          // e.g. 20 = 20% off when billed annually
  razorpayMonthlyPlanId: string | null;
  razorpayAnnualPlanId:  string | null;
}

export interface PlanCatalogState {
  plans:   PlanCatalogEntry[];
  loading: boolean;
  error:   string | null;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/// Fetches the set of publicly-offered, currently-active plans from
/// `plan_definitions`. Returns them in display order.
///
/// This is the single source of truth for the pricing grid. Prices,
/// min_vehicles, and the annual-discount policy all come from the server so
/// ops can tune pricing without a code deploy.
export function usePlanCatalog(): PlanCatalogState {
  const [state, setState] = useState<PlanCatalogState>({
    plans: [], loading: true, error: null,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('plan_definitions')
        .select(`
          plan_name, display_name, billing_model,
          price_per_vehicle_inr, min_vehicles,
          vehicle_limit, driver_limit, trial_days,
          feature_flags, sort_order,
          annual_discount_pct,
          razorpay_monthly_plan_id, razorpay_annual_plan_id
        `)
        .eq('is_public', true)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (cancelled) return;

      if (error) {
        console.error('[usePlanCatalog] load error:', error);
        setState({ plans: [], loading: false, error: error.message });
        return;
      }

      const plans: PlanCatalogEntry[] = (data ?? []).map(row => ({
        planName:              row.plan_name             as PlanName,
        displayName:          (row.display_name          as string) ?? row.plan_name,
        billingModel:         (row.billing_model         as BillingModel) ?? 'flat',
        pricePerVehicleInr:   (row.price_per_vehicle_inr as number | null) ?? null,
        minVehicles:          (row.min_vehicles          as number) ?? 1,
        vehicleLimit:         (row.vehicle_limit         as number) ?? -1,
        driverLimit:          (row.driver_limit          as number) ?? -1,
        trialDays:            (row.trial_days            as number) ?? 0,
        featureFlags:         (row.feature_flags         as Record<string, unknown>) ?? {},
        sortOrder:            (row.sort_order            as number) ?? 0,
        annualDiscountPct:    Number(row.annual_discount_pct ?? 0),
        razorpayMonthlyPlanId:(row.razorpay_monthly_plan_id as string | null) ?? null,
        razorpayAnnualPlanId: (row.razorpay_annual_plan_id  as string | null) ?? null,
      }));

      setState({ plans, loading: false, error: null });
    })();

    return () => { cancelled = true; };
  }, []);

  return state;
}

// ─── Helpers (pure) ──────────────────────────────────────────────────────────

/// Monthly price for a plan at a given vehicle count.
/// Returns null for enterprise (custom) or unpriced plans.
export function monthlyPriceFor(
  plan: PlanCatalogEntry,
  vehicleCount: number,
): number | null {
  if (plan.pricePerVehicleInr == null) return null;
  return plan.pricePerVehicleInr * Math.max(plan.minVehicles, vehicleCount);
}

/// Annual price for a plan at a given vehicle count (already discount-applied).
/// Returns null for enterprise (custom) or unpriced plans.
export function annualPriceFor(
  plan: PlanCatalogEntry,
  vehicleCount: number,
): number | null {
  const monthly = monthlyPriceFor(plan, vehicleCount);
  if (monthly == null) return null;
  const discountMultiplier = 1 - (plan.annualDiscountPct / 100);
  return Math.round(monthly * 12 * discountMultiplier);
}
