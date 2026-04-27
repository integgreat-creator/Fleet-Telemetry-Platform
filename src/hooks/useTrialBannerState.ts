import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
  | 'suspended'
  /// Active annual subscription with a renewal charge approaching. Fires
  /// 14 / 7 / 1 days before `current_period_end`. Distinct from `trial`
  /// because the customer is already paying — no upgrade decision, just
  /// a "make sure your card on file is current" reminder. Phase 1.6.2.
  | 'renewalReminder';

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
  /// External URL to open when the customer clicks the CTA, in lieu of the
  /// in-app navigation path. Currently used by `renewalReminder` to deep-link
  /// to the Razorpay-hosted card-management page. Null for every other kind
  /// (and for renewal reminder when Razorpay didn't return a short_url).
  /// Phase 1.6.3.
  ctaUrl:         string | null;
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
  const sub      = useSubscription();
  // useTranslation makes this hook re-evaluate on language change — `t` is a
  // stable function whose identity flips when i18n.language changes, which is
  // exactly what we want for the useMemo to recompute message + ctaLabel.
  const { t }    = useTranslation();

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
        message:         t('trialBanner.suspendedMessage'),
        ctaLabel:        t('trialBanner.ctaUpdateBilling'),
        recommendedPlan: null,
        ctaUrl:          null,
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
        message:         t('trialBanner.expiredMessage'),
        ctaLabel:        t('trialBanner.ctaUpgradeNow'),
        recommendedPlan: null,
        ctaUrl:          null,
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
        message:         t('trialBanner.graceMessage'),
        ctaLabel:        t('trialBanner.ctaUpgradeNow'),
        recommendedPlan: null,
        ctaUrl:          null,
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
      // customer real information. i18next picks the right plural form
      // (`_one` / `_other`) automatically based on the `count` arg using
      // CLDR rules.
      let message: string;
      if (msLeft <= 0) {
        message = t('trialBanner.trialMessageExpired');
      } else if (msLeft <= 3_600_000) {
        message = t('trialBanner.trialMessageMinutes');
      } else if (msLeft <= 86_400_000) {
        message = t('trialBanner.trialMessageHours', { count: hoursLeft });
      } else {
        message = t('trialBanner.trialMessageDays', { count: daysLeft });
      }

      return {
        kind:            'trial',
        severity,
        daysLeft,
        hoursLeft,
        pulse,
        message,
        ctaLabel:        severity === 'critical'
          ? t('trialBanner.ctaUpgradeNow')
          : t('trialBanner.ctaViewPlans'),
        recommendedPlan: TRIAL_DEFAULT_PLAN,
        ctaUrl:          null,
      };
    }

    // ── Annual renewal reminder (Phase 1.6.2) ─────────────────────────────
    // Active customer, billing cycle annual, current_period_end within 14 days.
    // We deliberately skip monthly: monthly auto-charges happen 12× a year
    // and a banner every 30 days is noise the customer would learn to
    // ignore. Annual customers commit ~12× more money in one shot, so the
    // "make sure your card is up to date" nudge has real value.
    if (sub.status === 'active' && sub.billingCycle === 'annual' && sub.currentPeriodEnd) {
      const msToRenewal = sub.currentPeriodEnd.getTime() - Date.now();
      const daysLeft    = Math.ceil(msToRenewal / 86_400_000);

      // Only fire once we're inside the 14-day window. Outside it,
      // fall through to 'none' — customers don't need a "you renew in 60
      // days" banner.
      if (msToRenewal > 0 && daysLeft <= 14) {
        const severity: TrialBannerSeverity =
          daysLeft <= 1 ? 'critical' : daysLeft <= 7 ? 'warning' : 'info';
        return {
          kind:            'renewalReminder',
          severity,
          daysLeft,
          hoursLeft:       null,
          pulse:           daysLeft <= 1,
          message:         t('trialBanner.renewalReminderMessage', { count: daysLeft }),
          ctaLabel:        t('trialBanner.ctaManageBilling'),
          recommendedPlan: null,
          // Razorpay-hosted card-on-file management. null when Razorpay
          // hasn't surfaced a short_url yet (dormant mode, or pre-charge
          // subscription) — TrialBanner falls back to in-app navigation.
          ctaUrl:          sub.razorpaySubscriptionShortUrl,
        };
      }
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
      ctaUrl:          null,
    };
  }, [
    t,
    sub.status,
    sub.isExpired,
    sub.isInGrace,
    sub.trialEndsAt,
    sub.billingCycle,
    sub.currentPeriodEnd,
    sub.razorpaySubscriptionShortUrl,
  ]);
}
