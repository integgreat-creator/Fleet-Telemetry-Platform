import { useState } from 'react';
import { X, PauseCircle, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Props {
  /// 'pause' opens with pause copy + confirm. 'resume' opens with resume
  /// copy + confirm. The same modal handles both actions because the UX
  /// shape is identical — only the verbs differ — and a separate
  /// ResumeSubscriptionModal would duplicate ~90% of the JSX.
  action:  'pause' | 'resume';
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/// Confirm-and-submit modal for both pause and resume. Phase 3.4.
///
/// Pause behaviour: Razorpay pause-at-cycle-end. Customer keeps paid
/// access through the current cycle, then status flips to 'paused'
/// when the webhook lands. Resume: takes effect immediately (Razorpay
/// resume_at=0), webhook lands quickly, status flips back to 'active'.
///
/// We don't show a "pause until X date" date picker — Razorpay's pause
/// is open-ended, the customer resumes whenever they want. A scheduled
/// resume would need a separate cron + state-machine and isn't worth the
/// complexity for v1.
export default function PauseSubscriptionModal({ action, onClose }: Props) {
  const { t } = useTranslation();
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
      if (!accessToken) throw new Error(t('pauseSubscription.errorAuth'));

      const { error: fnErr } = await supabase.functions.invoke(
        'razorpay-pause-subscription',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          body:    { action },
        },
      );
      if (fnErr) {
        // Drill into the FunctionsHttpError context for the friendly
        // 503 / 404 / 400 detail copy from the edge function.
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

  // Per-action copy keys. Centralised here so the JSX stays one shape;
  // i18n bundle has a parallel structure under 'pauseSubscription' /
  // 'resumeSubscription'.
  const ns = action === 'pause' ? 'pauseSubscription' : 'resumeSubscription';

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
            <div className="p-2 rounded-lg bg-blue-900/40 shrink-0">
              <PauseCircle size={18} className="text-blue-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                {done ? t(`${ns}.titleDone`) : t(`${ns}.title`)}
              </h2>
              {!done && (
                <p className="text-xs text-gray-400 mt-1">
                  {t(`${ns}.subtitle`)}
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
              {t(`${ns}.doneBody`)}
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
            {/* ── Body: what happens ──────────────────────────────────── */}
            <div className="p-6 space-y-5">
              <div className="text-sm text-gray-300 leading-relaxed space-y-2">
                <p>{t(`${ns}.explainTiming`)}</p>
                <p>{t(`${ns}.explainBilling`)}</p>
              </div>

              {error && (
                <div className="flex gap-3 p-3 bg-red-950/40 border border-red-900/60 rounded-lg">
                  <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-red-200 leading-relaxed">{error}</div>
                </div>
              )}
            </div>

            {/* ── Footer ─────────────────────────────────────────────── */}
            <div className="p-6 pt-0 flex items-center justify-between gap-3">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-5 py-2.5 text-sm text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
              >
                {t(`${ns}.cancelLabel`)}
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t(`${ns}.submitting`)}
                  </>
                ) : (
                  t(`${ns}.confirm`)
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
