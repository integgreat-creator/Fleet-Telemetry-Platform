/**
 * AnnualUpgradeTeaser — post-unlock nudge for monthly customers who've
 * crossed the 3-month threshold.
 *
 * Phase 3.12. The pre-unlock countdown lives in `AnnualUnlockCard` and
 * hides itself the moment `annual_unlocked_at` is set. Without this
 * follow-up surface, the customer crosses the threshold and never knows
 * — they keep paying monthly forever even when an annual switch would
 * save them real money. This card is the "you've unlocked it, here's
 * what you'd save" pitch.
 *
 * Visibility is conservative:
 *   - status must be 'active'
 *   - billingCycle must be 'monthly'  (annual customers don't need a teaser)
 *   - annualUnlockedAt must be set    (the gate)
 *   - the customer hasn't dismissed it in the last 14 days
 *
 * Dismissal is per-fleet and lives in localStorage. We don't write it to
 * the DB because the cost of a stale-on-fresh-device "show again" is
 * roughly zero (it's just a card), and we don't want to pollute
 * subscriptions with a UI-state column.
 *
 * The CTA opens the existing PlanCheckoutModal with the customer's
 * current plan + `initialBillingCycle='annual'`. The modal already gates
 * the annual tab on `annualUnlocked`, so the same plumbing handles the
 * "but my unlock just got revoked somehow" edge case gracefully.
 */

import { useMemo, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSubscription } from '../hooks/useSubscription';
import {
  usePlanCatalog,
  monthlyPriceFor,
  annualPriceFor,
} from '../hooks/usePlanCatalog';

/// How long to suppress the teaser after a customer dismisses it. Two
/// weeks is short enough that a customer who dismissed-by-accident sees
/// the pitch again, long enough that a customer who actively said "no"
/// isn't pestered the next time they open the page.
const DISMISS_COOLDOWN_DAYS = 14;

/// localStorage key namespace. Per-fleet so a multi-fleet user (rare but
/// possible) doesn't have one fleet's dismissal silence another's pitch.
const DISMISS_KEY_PREFIX = 'ftpgo:annualTeaserDismissedAt:';

interface Props {
  /// The current fleet id, used to namespace the localStorage dismiss
  /// key. Passing it explicitly (rather than reading useSubscription
  /// internally) keeps the component testable without a hook context.
  fleetId: string | null;
  /// Click handler for the upgrade CTA. AdminPage passes a function that
  /// opens PlanCheckoutModal with `initialBillingCycle='annual'`.
  onUpgrade: () => void;
}

function dismissedRecently(fleetId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY_PREFIX + fleetId);
    if (!raw) return false;
    const ts = Date.parse(raw);
    if (isNaN(ts)) return false;
    const ageMs = Date.now() - ts;
    return ageMs < DISMISS_COOLDOWN_DAYS * 86_400_000;
  } catch {
    // Some browsers (private mode, some embedded webviews) throw on
    // localStorage access. Treat that as "not dismissed" — showing the
    // teaser is the safer fallback for revenue.
    return false;
  }
}

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function AnnualUpgradeTeaser({ fleetId, onUpgrade }: Props) {
  const { t } = useTranslation();
  const { plan, status, billingCycle, annualUnlockedAt, vehiclesUsed } = useSubscription();
  const { plans: catalogPlans } = usePlanCatalog();

  // Track local dismissal so the card vanishes immediately on click,
  // without waiting for a re-render driven by something else. Initialised
  // from localStorage on first mount so reloads honour the cooldown.
  const [dismissed, setDismissed] = useState<boolean>(
    () => fleetId != null && dismissedRecently(fleetId),
  );

  // Look up the current plan in the live catalog. Prices live there so a
  // future per-plan annual-discount tweak (e.g. raising it from 20% to
  // 25%) flows through without touching this component.
  const planEntry = useMemo(
    () => catalogPlans.find(p => p.planName === plan) ?? null,
    [catalogPlans, plan],
  );

  // Compute savings up front. We only render when both totals resolve to
  // numbers — Enterprise / unpriced plans return null from the helpers
  // and that's the right "hide me" signal anyway.
  const savings = useMemo(() => {
    if (!planEntry) return null;
    const monthly = monthlyPriceFor(planEntry, vehiclesUsed);
    const annual  = annualPriceFor(planEntry, vehiclesUsed);
    if (monthly == null || annual == null) return null;
    const yearMonthly = monthly * 12;
    const diff        = yearMonthly - annual;
    if (diff <= 0) return null;     // sanity guard: no savings, no pitch
    return {
      yearMonthly,
      annual,
      diff,
      pct: planEntry.annualDiscountPct,
    };
  }, [planEntry, vehiclesUsed]);

  // ── Visibility gate ────────────────────────────────────────────────────────
  if (dismissed)                  return null;
  if (status !== 'active')        return null;
  if (billingCycle !== 'monthly') return null;
  if (!annualUnlockedAt)          return null;
  if (!savings)                   return null;

  const handleDismiss = () => {
    setDismissed(true);
    if (typeof window === 'undefined' || !fleetId) return;
    try {
      window.localStorage.setItem(
        DISMISS_KEY_PREFIX + fleetId,
        new Date().toISOString(),
      );
    } catch {
      // localStorage write failed — already-dismissed in this session is
      // good enough; the teaser will reappear on next mount, which is
      // the worst-case "we asked you twice" outcome we can live with.
    }
  };

  return (
    <div className="bg-gradient-to-r from-emerald-950/60 to-emerald-900/30 border border-emerald-800/60 rounded-xl p-5 flex items-start gap-4 relative">
      <div className="p-2 rounded-lg bg-emerald-900/50 shrink-0">
        <Sparkles size={18} className="text-emerald-300" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-white">
          {t('annualTeaser.heading', { amount: formatInr(savings.diff) })}
        </h3>
        <p className="text-xs text-emerald-100/80 mt-1 leading-relaxed">
          {t('annualTeaser.body', { pct: savings.pct })}
        </p>
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[11px] text-emerald-200/80">
          <span>
            {t('annualTeaser.labelMonthlyYear')}: <span className="line-through text-emerald-300/50 font-mono">{formatInr(savings.yearMonthly)}</span>
          </span>
          <span>
            {t('annualTeaser.labelAnnualToday')}: <span className="text-white font-semibold font-mono">{formatInr(savings.annual)}</span>
          </span>
        </div>
        <button
          onClick={onUpgrade}
          className="mt-3 inline-flex items-center px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-md transition-colors"
        >
          {t('annualTeaser.cta')}
        </button>
      </div>
      <button
        onClick={handleDismiss}
        title={t('annualTeaser.dismissTitle')}
        aria-label={t('annualTeaser.dismissAria')}
        className="absolute top-3 right-3 p-1 text-emerald-300/60 hover:text-emerald-200 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
