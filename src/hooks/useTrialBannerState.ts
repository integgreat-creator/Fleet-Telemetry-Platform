import { useMemo } from 'react';
import { useSubscription, type PlanName } from './useSubscription';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TrialBannerKind =
  | 'none'
  /// On a free trial with N days/hours remaining. Severity escalates with
  /// proximity to expiry — caller picks colours from `severity`.
  | 'trial'
  /// Trial / paid subscription has expired but we are still inside the
  /// 7-day grace window. Customer keeps access while they fix billing.
  | 'grace'
  /// Trial / paid subscription expired beyond grace. Features are locked
  /// platform-wide; the only way back in is to upgrade.
  | 'expired'
  /// Razorpay returned `payment.failed` for the latest charge. Distinct
  /// from `expired` because the customer typically just needs to retry —
  /// not pick a new plan. Routing the upgrade CTA to "Update billing" is
  /// the caller's job (we just surface the state).
  | 'suspended';

export type TrialBannerSeverity = 'info' | 'warning' | 'critical';

export interface TrialBannerState {
  kind:           TrialBannerKind;
  severity:       TrialBannerSeverity;
  /// Whole days remaining (`Math.ceil`). Null when not on a trial.
  daysLeft:       number | null;
  /// Hours remaining (0–24). Surfaced for the last-day banner copy
  /// — "expires in 4 hours" reads better than "expires today".
  hoursLeft:      number | null;
  /// True iff we should pulse the icon — last 24h of the trial only.
  pulse:          boolean;
  /// Plain-English copy line. Caller wraps it in their own styling.
  message:        string;
  /// Label for the upgrade button. Differs by kind so the verb matches
  /// the actual action ("Upgrade now" vs "Update billing" vs "View plans").
  ctaLabel:       string;
  /// Plan to pre-select when the user clicks the CTA. Null when we
  /// have no opinion (e.g. expired beyond grace — let them choose).
  recommendedPlan: PlanName | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Severity of a trial banner based on `daysLeft`.
///   ≤ 1 day  → critical (red)
///   ≤ 7 days → warning  (yellow)
///   else     → info     (gray/blue)
function severityForTrial(daysLeft: number): TrialBannerSeverity {
  if (daysLeft <= 1) return 'critical';
  if (daysLeft <= 7) return 'warning';
  return 'info';
}

/// Plan we recommend for a fleet whose trial is ending. We currently nudge
/// every trial fleet toward Essential — the cheapest paid tier — because:
///   - It has no minimum vehicle count, so any fleet size can pick it.
///   - Customers can upgrade later without resigning a contract.
///   - Defaulting to a higher tier inflates the "sticker shock" moment.
const TRIAL_DEFAULT_PLAN: PlanName = 'essential';

// ─── Hook ────────────────────────────────────────────────────────────────────

/// Single source of truth for banner state across `<TrialBanner />` and
/// `<TrialStatusCard />`. Reads `useSubscription` and derives presentation
/// flags + copy. Pure (no side effects, no fetches) — re-renders only when
/// the subscription state itself changes.
export function useTrialBannerState(): TrialBannerState {
  const sub = useSubscription();

  return useMemo<TrialBannerState>(() => {
    // ── Suspended (payment failed) ────────────────────────────────────────
    // Highest priority — a suspended subscription means features are locked
    // *and* the customer thinks they paid. Surface this even if some other
    // flag like isInGrace would also be true.
    if (sub.status === 'suspended') {
      return {
        kind:            'suspended',
        severity:        'critical',
        daysLeft:        null,
        hoursLeft:       null,
        pulse:           true,
        message:
          'Your last payment didn’t go through. Update your billing details to ' +
          'restore full access — your data is safe in the meantime.',
        ctaLabel:        'Update billing',
        recommendedPlan: null,
      };
    }

    // ── Expired beyond grace ──────────────────────────────────────────────
    if (sub.isExpired && !sub.isInGrace) {
      return {
        kind:            'expired',
        severity:        'critical',
        daysLeft:        null,
        hoursLeft:       null,
        pulse:           false,
        message:
          'Your subscription has expired and features are locked. ' +
          'Pick a plan to restore access — your data is preserved.',
        ctaLabel:        'Upgrade now',
        recommendedPlan: null,
      };
    }

    // ── In grace period (expired ≤ 7 days ago) ────────────────────────────
    if (sub.isInGrace) {
      return {
        kind:            'grace',
        severity:        'critical',
        daysLeft:        null,
        hoursLeft:       null,
        pulse:           true,
        message:
          'Your subscription has expired. You have a 7-day grace period — ' +
          'upgrade now to avoid losing access.',
        ctaLabel:        'Upgrade now',
        recommendedPlan: null,
      };
    }

    // ── Active trial ──────────────────────────────────────────────────────
    if (sub.status === 'trial' && sub.trialEndsAt) {
      const msLeft     = Math.max(0, sub.trialEndsAt.getTime() - Date.now());
      const daysLeft   = Math.ceil(msLeft / 86_400_000);
      const hoursLeft  = Math.ceil(msLeft / 3_600_000);
      const severity   = severityForTrial(daysLeft);
      const pulse      = msLeft <= 86_400_000;       // last 24h

      // Copy: prefer hour-level granularity in the last day. "Expires in 4
      // hours" reads more urgently than "expires today" and gives the
      // customer real information.
      let message: string;
      if (msLeft <= 0) {
        message = 'Your free trial has expired. Upgrade to keep full access.';
      } else if (msLeft <= 3_600_000) {
        message = 'Your free trial expires in less than an hour. Upgrade to keep full access.';
      } else if (msLeft <= 86_400_000) {
        message =
          `Your free trial expires in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}. ` +
          `Upgrade to keep full access.`;
      } else {
        message =
          `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. ` +
          `Upgrade to keep full access.`;
      }

      return {
        kind:            'trial',
        severity,
        daysLeft,
        hoursLeft,
        pulse,
        message,
        ctaLabel:        severity === 'critical' ? 'Upgrade now' : 'View plans',
        recommendedPlan: TRIAL_DEFAULT_PLAN,
      };
    }

    // ── Default (active paid plan, or unloaded) ───────────────────────────
    return {
      kind:            'none',
      severity:        'info',
      daysLeft:        null,
      hoursLeft:       null,
      pulse:           false,
      message:         '',
      ctaLabel:        '',
      recommendedPlan: null,
    };
  }, [
    sub.status,
    sub.isExpired,
    sub.isInGrace,
    sub.trialEndsAt,
  ]);
}
