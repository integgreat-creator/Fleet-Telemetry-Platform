import { AlertCircle, Clock, CreditCard } from 'lucide-react';
import { useTrialBannerState, type TrialBannerKind, type TrialBannerSeverity } from '../hooks/useTrialBannerState';
import { usePendingCheckout } from '../hooks/usePendingCheckout';

// ─── Style maps ──────────────────────────────────────────────────────────────

/// Tailwind classes per severity, used to colour the banner row + button.
/// Colocated as a single map so the three severities stay visually distinct
/// at a glance and a designer can adjust without hunting through conditionals.
const SEVERITY_STYLES: Record<TrialBannerSeverity, {
  row:         string;
  text:        string;
  icon:        string;
  button:      string;
}> = {
  info: {
    row:    'bg-gray-800/60 border-gray-700',
    text:   'text-gray-400',
    icon:   'text-gray-400',
    button: 'bg-blue-600 hover:bg-blue-500',
  },
  warning: {
    row:    'bg-yellow-900/40 border-yellow-800',
    text:   'text-yellow-300',
    icon:   'text-yellow-400',
    button: 'bg-yellow-600 hover:bg-yellow-500',
  },
  critical: {
    row:    'bg-red-900/60 border-red-700',
    text:   'text-red-200',
    icon:   'text-red-300',
    button: 'bg-red-600 hover:bg-red-500',
  },
};

/// Icon to show per banner kind. `suspended` and `renewalReminder` get the
/// credit-card icon because the action is "check your card on file"; trial
/// gets the clock; the rest fall back to the alert circle.
function iconForKind(kind: TrialBannerKind) {
  if (kind === 'suspended')        return CreditCard;
  if (kind === 'renewalReminder')  return CreditCard;
  if (kind === 'trial')            return Clock;
  return AlertCircle;                                  // grace, expired
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  /// Page-navigation callback from Layout. The banner uses it to send the
  /// user to AdminPage right after queueing a pending-checkout request.
  onNavigateToAdmin: () => void;
}

/// Sticky banner row anchored above the page content. Hidden when there's
/// nothing to say (active paid plan in good standing). Phase 1.4.
///
/// Click flow:
///   1. Banner CTA → `pendingCheckout.request(plan)` queues the modal target
///   2. Banner CTA → `onNavigateToAdmin()` switches the page
///   3. AdminPage on mount → consumes pendingPlan, opens the modal
/// This gets the user one click away from paying instead of dumping them
/// on the pricing grid expecting them to find their plan.
export default function TrialBanner({ onNavigateToAdmin }: Props) {
  const state    = useTrialBannerState();
  const checkout = usePendingCheckout();

  if (state.kind === 'none') return null;

  const styles = SEVERITY_STYLES[state.severity];
  const Icon   = iconForKind(state.kind);

  const handleCta = () => {
    // External URL takes priority over in-app nav. Currently only used by
    // `renewalReminder` to deep-link into Razorpay's hosted subscription
    // page (Phase 1.6.3). noopener+noreferrer so the new tab can't reach
    // back via window.opener.
    if (state.ctaUrl) {
      window.open(state.ctaUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    // Suspended state → send them to billing details, not the pricing grid.
    // (Until we have a dedicated /billing route, AdminPage is the one place
    // that exposes update-billing-details, so the navigation is the same.)
    if (state.recommendedPlan) {
      checkout.request(state.recommendedPlan);
    }
    onNavigateToAdmin();
  };

  return (
    <div
      className={`border-b px-6 py-2.5 flex items-center gap-3 flex-shrink-0 ${styles.row}`}
      // role=status because this is supplementary information, not a fatal
      // error blocking interaction. Screen readers announce it once on
      // mount + on text change, which is what we want.
      role="status"
    >
      <Icon
        className={`w-4 h-4 flex-shrink-0 ${styles.icon} ${state.pulse ? 'animate-pulse' : ''}`}
      />
      <p className={`text-sm font-medium flex-1 ${styles.text}`}>
        {state.message}
      </p>
      <button
        onClick={handleCta}
        className={`px-3 py-1 ${styles.button} text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0`}
      >
        {state.ctaLabel}
      </button>
    </div>
  );
}
