import {
  createContext, useCallback, useContext, useMemo, useState,
  type ReactNode,
} from 'react';
import type { PlanName } from './useSubscription';

// ─── Types ───────────────────────────────────────────────────────────────────

/// Cross-page channel for "open the checkout modal for plan X". Set by
/// banners / cards that live outside AdminPage; read by AdminPage on mount.
///
/// Why a context and not a URL query param? The app uses page-state-based
/// routing, not real URLs, so query params would mean wiring routing first.
/// A context keeps the change minimal — one provider in App.tsx, one
/// consumer hook everywhere else.
export interface PendingCheckoutState {
  /// Plan name the navigator wants to open in the checkout modal. null
  /// while idle. AdminPage clears this once it consumes the request.
  pendingPlan: PlanName | null;
  /// Set the pending plan. Typically followed immediately by an
  /// onNavigate('admin') so AdminPage actually mounts to consume it.
  request: (plan: PlanName) => void;
  /// AdminPage calls this once it has read pendingPlan and either opened
  /// the modal or decided not to (e.g. plan not in the live catalog).
  clear: () => void;
}

const DEFAULT: PendingCheckoutState = {
  pendingPlan: null,
  request:     () => {},
  clear:       () => {},
};

const PendingCheckoutContext = createContext<PendingCheckoutState>(DEFAULT);

// ─── Provider ────────────────────────────────────────────────────────────────

export function PendingCheckoutProvider({ children }: { children: ReactNode }) {
  const [pendingPlan, setPendingPlan] = useState<PlanName | null>(null);

  const request = useCallback((plan: PlanName) => {
    setPendingPlan(plan);
  }, []);
  const clear = useCallback(() => {
    setPendingPlan(null);
  }, []);

  // Memoize so consumers can list `pendingCheckout` itself (or its stable
  // members) in useEffect dep arrays without firing on every parent render.
  const value = useMemo<PendingCheckoutState>(
    () => ({ pendingPlan, request, clear }),
    [pendingPlan, request, clear],
  );

  return (
    <PendingCheckoutContext.Provider value={value}>
      {children}
    </PendingCheckoutContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function usePendingCheckout(): PendingCheckoutState {
  return useContext(PendingCheckoutContext);
}
