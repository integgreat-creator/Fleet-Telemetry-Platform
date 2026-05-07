import { useState } from 'react';
import { X, AlertTriangle, Loader2, PauseCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

/// Enum mirrors the server-side RECOGNISED_REASONS set in
/// supabase/functions/razorpay-cancel-subscription/index.ts. Keep them in
/// sync — anything outside this set lands in the 'other' bucket on the
/// server, which would lose specific signal in the audit log.
const REASONS = [
  'too_expensive',
  'missing_features',
  'switching_competitor',
  'temporary_pause',
  'just_exploring',
  'other',
] as const;

type Reason = typeof REASONS[number];

interface Props {
  /// When the user dismisses or successfully cancels. Caller decides whether
  /// to refresh useSubscription afterwards (the realtime channel will pick
  /// up the row update from the webhook anyway).
  onClose: () => void;
  /// Optional opt-in to the cancellation save flow (Phase 3.14). When the
  /// customer picks `temporary_pause` as their reason, an inline
  /// "Pause instead" suggestion appears. Clicking it calls this callback —
  /// the parent is expected to close the cancel modal and open the pause
  /// flow. If unset, the suggestion isn't rendered (e.g. for fleets whose
  /// subscription state can't be paused — paused already, no Razorpay
  /// subscription, etc.).
  onPauseInstead?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/// Self-serve cancellation confirm modal. Phase 3.2.
///
/// Rendered when the customer clicks "Cancel subscription" in the
/// Subscription tab. Shows what will happen (cycle-end, data retention),
/// captures a reason for ops, calls the edge function. The actual
/// status='inactive' flip happens at cycle end via Razorpay's
/// subscription.cancelled webhook — the edge function only initiates.
export default function CancelSubscriptionModal({ onClose, onPauseInstead }: Props) {
  const { t } = useTranslation();

  const [reason,     setReason]     = useState<Reason>('too_expensive');
  const [comment,    setComment]    = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [done,       setDone]       = useState(false);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t('cancelSubscription.errorAuth'));

      const { error: fnErr } = await supabase.functions.invoke(
        'razorpay-cancel-subscription',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          body:    { reason, comment: comment.trim() || undefined },
        },
      );
      if (fnErr) {
        // Drill into the FunctionsHttpError context for the friendly
        // 503 / 404 / 400 detail copy the edge function emits.
        let msg = fnErr.message ?? t('common.errorGeneric');
        try {
          const errBody = await (fnErr as unknown as {
            context?: { json?: () => Promise<{ error?: string; detail?: string }> };
          }).context?.json?.();
          msg = errBody?.detail ?? errBody?.error ?? msg;
        } catch { /* fall back to fnErr.message */ }
        throw new Error(msg);
      }
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between p-6 border-b border-gray-800">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-900/40 shrink-0">
              <AlertTriangle size={18} className="text-red-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                {done ? t('cancelSubscription.titleDone') : t('cancelSubscription.title')}
              </h2>
              {!done && (
                <p className="text-xs text-gray-400 mt-1">
                  {t('cancelSubscription.subtitle')}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white disabled:opacity-40 transition-colors shrink-0"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Done state ─────────────────────────────────────────────────── */}
        {done ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-300 leading-relaxed">
              {t('cancelSubscription.doneBody')}
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {t('common.close')}
            </button>
          </div>
        ) : (
          <>
            {/* ── Body: what happens ───────────────────────────────────── */}
            <div className="p-6 space-y-5">
              <div className="text-sm text-gray-300 leading-relaxed space-y-2">
                <p>{t('cancelSubscription.explainCycleEnd')}</p>
                <p>{t('cancelSubscription.explainDataRetention')}</p>
              </div>

              {/* Reason dropdown — required so ops gets a churn signal.
                  All values map to RECOGNISED_REASONS server-side. */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  {t('cancelSubscription.reasonLabel')}
                </label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value as Reason)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500"
                >
                  {REASONS.map(r => (
                    <option key={r} value={r}>
                      {t(`cancelSubscription.reasons.${r}`)}
                    </option>
                  ))}
                </select>
              </div>

              {/* ── Save flow (Phase 3.14) ───────────────────────────────────
                  Customer self-selected `temporary_pause` as their reason
                  — that's a directly addressable retention case and we
                  have a less-aggressive option that maps to it
                  one-to-one. The whole point of the pause feature is
                  that customers don't have to cancel; surface it
                  explicitly when they're about to. Only render when the
                  parent has wired up `onPauseInstead` (paid+active subs
                  can pause; trial/expired/inactive can't, and we
                  shouldn't tease an option the customer can't take). */}
              {reason === 'temporary_pause' && onPauseInstead && (
                <div className="rounded-lg bg-blue-950/40 border border-blue-900/60 p-4 flex items-start gap-3">
                  <div className="p-1.5 rounded-md bg-blue-900/50 shrink-0">
                    <PauseCircle size={16} className="text-blue-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-white">
                      {t('cancelSubscription.saveOffer.heading')}
                    </h3>
                    <p className="text-xs text-blue-100/80 mt-1 leading-relaxed">
                      {t('cancelSubscription.saveOffer.body')}
                    </p>
                    <button
                      onClick={onPauseInstead}
                      disabled={submitting}
                      className="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-xs font-semibold rounded-md transition-colors"
                    >
                      <PauseCircle size={12} />
                      {t('cancelSubscription.saveOffer.cta')}
                    </button>
                  </div>
                </div>
              )}

              {/* Optional free-text. Capped at 500 chars on the server;
                  client lets them type more but trims silently. */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  {t('cancelSubscription.commentLabel')}
                  {' '}
                  <span className="text-gray-600">{t('cancelSubscription.commentOptional')}</span>
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={3}
                  maxLength={500}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500 resize-none"
                  placeholder={t('cancelSubscription.commentPlaceholder')}
                />
              </div>

              {error && (
                <div className="flex gap-3 p-3 bg-red-950/40 border border-red-900/60 rounded-lg">
                  <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-red-200 leading-relaxed">{error}</div>
                </div>
              )}
            </div>

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="p-6 pt-0 flex items-center justify-between gap-3">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-5 py-2.5 text-sm text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
              >
                {t('cancelSubscription.keepSubscription')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-red-500/20 transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t('cancelSubscription.submitting')}
                  </>
                ) : (
                  t('cancelSubscription.confirmCancel')
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
