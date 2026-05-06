import { useState } from 'react';
import { Clock, ArrowRight, AlertCircle, CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSubscription } from '../hooks/useSubscription';
import { useTrialBannerState } from '../hooks/useTrialBannerState';
import { usePendingCheckout } from '../hooks/usePendingCheckout';
import TrialExtensionModal from './TrialExtensionModal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Trial duration shipped today is 30 days. Sourced from `trial_days` on
/// `plan_definitions.trial` row, but for the progress-bar visual we need
/// a constant — using the catalog value would mean threading it through
/// useSubscription too, and the value never changes per fleet.
const ASSUMED_TRIAL_LENGTH_DAYS = 30;

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /// Function to call when the customer clicks the upgrade CTA. Same shape
  /// as TrialBanner — usePendingCheckout queues the plan, then we let the
  /// parent decide whether to switch tabs / navigate.
  onUpgradeClick?: () => void;
}

/// Trial-status card for the AdminPage Subscription tab. Phase 1.4.3.
///
/// Replaces the tiny "Trial ends X" line with a fuller card that shows:
///   - Days+hours remaining with severity colour
///   - Progress bar (days used / 30)
///   - Plan recommendation + a direct "Choose plan" CTA that goes
///     straight into the checkout modal (skips the pricing grid)
///
/// Hidden when the customer is on a paid plan or expired beyond grace.
/// For grace and suspended states we render a different (red) version of
/// the card so the user has a single, prominent action surface — no need
/// to scroll past the trial card to find the right banner.
export default function TrialStatusCard({ onUpgradeClick }: Props) {
  const { t, i18n }               = useTranslation();
  const { trialEndsAt, status, trialSelfExtendedAt } = useSubscription();
  const banner                    = useTrialBannerState();
  const pendingCheckout           = usePendingCheckout();

  // Phase 3.5 — one-time self-serve trial extension modal. Triggered by
  // a small "Need more time?" link in the trial card; gate is "on trial
  // AND not yet self-extended".
  const [showExtendModal, setShowExtendModal] = useState(false);
  const canSelfExtend = status === 'trial' && trialSelfExtendedAt == null;

  // Centralized "X hours left" / "X days left" copy. Lives inside the
  // component so it can use the same `t` instance as the rest of the JSX —
  // hoisting it would mean threading t through, with no real win.
  const formatTimeLeft = (daysLeft: number, hoursLeft: number): string => {
    if (daysLeft <= 0 && hoursLeft <= 0) return t('trialCard.timeLeftExpired');
    if (daysLeft <= 1)                   return t('trialCard.timeLeftHours', { count: hoursLeft });
    return t('trialCard.timeLeftDays', { count: daysLeft });
  };

  // Hide card entirely when there's nothing to surface.
  if (banner.kind === 'none')    return null;
  if (banner.kind === 'expired') return null;     // global banner already loud

  const handleUpgrade = () => {
    if (banner.recommendedPlan) {
      pendingCheckout.request(banner.recommendedPlan);
    }
    onUpgradeClick?.();
  };

  // ── Suspended / Grace variant (one prominent red card) ───────────────────

  if (banner.kind === 'suspended' || banner.kind === 'grace') {
    const Icon = banner.kind === 'suspended' ? CreditCard : AlertCircle;
    return (
      <div className="bg-red-950/40 border border-red-900/60 rounded-xl p-5 flex items-start gap-4">
        <div className="p-2 rounded-lg bg-red-900/40 shrink-0">
          <Icon size={18} className="text-red-300" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">
            {banner.kind === 'suspended'
              ? t('trialCard.headingPaymentFailed')
              : t('trialCard.headingExpired')}
          </h3>
          <p className="text-xs text-red-200/90 mt-1 leading-relaxed">{banner.message}</p>
        </div>
        <button
          onClick={handleUpgrade}
          className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
        >
          {banner.ctaLabel}
          <ArrowRight size={12} />
        </button>
      </div>
    );
  }

  // ── Trial variant ────────────────────────────────────────────────────────

  if (banner.kind === 'trial' && trialEndsAt && status === 'trial') {
    const daysLeft  = banner.daysLeft  ?? 0;
    const hoursLeft = banner.hoursLeft ?? 0;
    const daysUsed  = Math.max(0, ASSUMED_TRIAL_LENGTH_DAYS - daysLeft);
    const pct       = Math.max(0, Math.min(100,
      (daysUsed / ASSUMED_TRIAL_LENGTH_DAYS) * 100,
    ));

    // Severity → colour. Match TrialBanner so the page isn't sending mixed
    // signals (e.g. yellow card + red banner for the same state).
    const tone = banner.severity === 'critical'
      ? { ring: 'border-red-900/60',    bg: 'bg-red-950/30',    text: 'text-red-300',    bar: 'bg-red-500'    }
      : banner.severity === 'warning'
      ? { ring: 'border-yellow-900/60', bg: 'bg-yellow-950/30', text: 'text-yellow-300', bar: 'bg-yellow-500' }
      : { ring: 'border-blue-900/40',   bg: 'bg-blue-950/20',   text: 'text-blue-300',   bar: 'bg-blue-500'   };

    return (
      <div className={`${tone.bg} border ${tone.ring} rounded-xl p-5`}>
        <div className="flex items-start gap-4">
          <div className={`p-2 rounded-lg bg-gray-900/40 shrink-0`}>
            <Clock size={18} className={`${tone.text} ${banner.pulse ? 'animate-pulse' : ''}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-white">{t('trialCard.headingFreeTrial')}</h3>
              <span className={`text-xs font-semibold ${tone.text}`}>
                {formatTimeLeft(daysLeft, hoursLeft)}
              </span>
            </div>

            {/* Progress bar — visual cue beats counting digits in the copy */}
            <div className="mt-3 h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div
                className={`h-full ${tone.bar} transition-all`}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
            </div>
            <p className="text-[11px] text-gray-500 mt-1.5">
              {/* Date format follows the active locale — `i18n.language`
                  feeds Intl directly. For English-fallback Tamil this also
                  renders sensibly because Intl handles `ta-IN` natively. */}
              {t('trialCard.progressLine', {
                used:  daysUsed,
                total: ASSUMED_TRIAL_LENGTH_DAYS,
                date:  trialEndsAt.toLocaleDateString(i18n.language || 'en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric',
                }),
              })}
            </p>
            {/* Self-serve extension link (Phase 3.5). Hidden once used —
                trialSelfExtendedAt becomes non-null. Muted on purpose:
                the primary CTA is still "Choose plan"; this is the
                escape hatch for customers who need a beat. */}
            {canSelfExtend && (
              <button
                onClick={() => setShowExtendModal(true)}
                className="mt-2 text-[11px] text-yellow-400 hover:text-yellow-300 underline-offset-2 hover:underline transition-colors"
              >
                {t('trialExtension.trigger')}
              </button>
            )}
          </div>
          <button
            onClick={handleUpgrade}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 shrink-0"
          >
            {t('trialCard.chooseplanCta')}
            <ArrowRight size={12} />
          </button>
        </div>

        {showExtendModal && (
          <TrialExtensionModal onClose={() => setShowExtendModal(false)} />
        )}
      </div>
    );
  }

  return null;
}
