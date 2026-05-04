import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSubscription } from '../hooks/useSubscription';
import { usePlanCatalog } from '../hooks/usePlanCatalog';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// 3-month threshold mirrors the razorpay-webhook logic that flips
/// `subscriptions.annual_unlocked_at`. Source of truth lives there; this
/// constant is the client mirror, used only to compute the customer-facing
/// countdown. Bumping the threshold means updating both places.
const ANNUAL_UNLOCK_MONTHS = 3;

/// Returns the wall-clock target date for annual unlock. Mirrors the
/// webhook's "3 months after subscription created_at" math. We use
/// `setMonth` (not `setTime`) so 31-day-month rollovers and DST
/// transitions are handled the same way Postgres' INTERVAL would.
function targetUnlockDate(createdAt: Date): Date {
  const t = new Date(createdAt);
  t.setMonth(t.getMonth() + ANNUAL_UNLOCK_MONTHS);
  return t;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /// Subscription row's `created_at`. Shipped from AdminPage which already
  /// reads the row directly. Kept as a prop (rather than reading via
  /// useSubscription, which exposes its own subset) so this component
  /// stays usable from any caller that has the timestamp.
  subscriptionCreatedAt: string | null;
}

/// Surface the upcoming annual-billing unlock for monthly customers who
/// haven't yet qualified. Hidden when:
///   - Customer is on trial / expired / suspended (annual unlock is not
///     a concern there)
///   - Customer is already on annual billing
///   - `annualUnlockedAt` is set (already qualified — they should pick
///     annual at next renewal, the modal handles that path)
///   - We don't have a creation timestamp to compute against
///
/// Phase 3.1.
export default function AnnualUnlockCard({ subscriptionCreatedAt }: Props) {
  const { t, i18n } = useTranslation();
  const { plan, status, billingCycle, annualUnlockedAt } = useSubscription();
  const { plans: catalogPlans } = usePlanCatalog();

  // ── Visibility gate ────────────────────────────────────────────────────────
  // Active monthly customer who hasn't crossed the 3-month threshold yet.
  // Anything else, render nothing — operator dashboard has the full picture
  // of edge cases; the customer doesn't need a card per state.
  if (status !== 'active')        return null;
  if (billingCycle !== 'monthly') return null;
  if (annualUnlockedAt)           return null;
  if (!subscriptionCreatedAt)     return null;

  const created = new Date(subscriptionCreatedAt);
  if (isNaN(created.getTime()))   return null;

  const target  = targetUnlockDate(created);
  const msLeft  = target.getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / 86_400_000);

  // Plan's annual discount drives the savings copy. Look up via the live
  // catalog so a future per-plan discount tweak (D3 was "flat 20%") flows
  // through without touching this component.
  const planEntry = catalogPlans.find(p => p.planName === plan);
  const discountPct = planEntry?.annualDiscountPct ?? 0;

  // Format the target date using the active locale. en-IN/ta-IN both yield
  // sensible output; bare 'en' or 'ta' would too.
  const targetLabel = target.toLocaleDateString(i18n.language || 'en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  // Two states:
  //   1. Still in the 3-month window — show countdown + target date.
  //   2. Past the window but webhook hasn't flipped the flag yet (rare —
  //      it fires on subscription.charged, so the lag is at most one
  //      billing cycle). Tell the customer it'll unlock on next renewal
  //      so they don't read the missing flag as "your account is broken".
  const inWindow = msLeft > 0;

  return (
    <div className="bg-emerald-950/30 border border-emerald-900/60 rounded-xl p-5 flex items-start gap-4">
      <div className="p-2 rounded-lg bg-emerald-900/40 shrink-0">
        <CalendarClock size={18} className="text-emerald-300" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-white">
          {t('annualUnlock.heading')}
        </h3>
        <p className="text-xs text-emerald-200/90 mt-1 leading-relaxed">
          {inWindow
            ? t('annualUnlock.bodyCountdown', {
                count: daysLeft,
                date:  targetLabel,
                pct:   discountPct,
              })
            : t('annualUnlock.bodyPending', { pct: discountPct })}
        </p>
      </div>
    </div>
  );
}
