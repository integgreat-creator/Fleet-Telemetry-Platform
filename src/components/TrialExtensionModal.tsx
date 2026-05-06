import { useState } from 'react';
import { X, Clock, Loader2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

/// Mirrors RECOGNISED_REASONS in the edge function. Keep in sync — anything
/// outside this set lands in the 'other' bucket on the server, which loses
/// the specific signal in the audit log.
const REASONS = [
  'still_evaluating',
  'waiting_on_team_decision',
  'havent_set_up_yet',
  'need_more_time_to_test',
  'other',
] as const;

type Reason = typeof REASONS[number];

/// Self-serve cap. Edge function rejects > 7 with a 400; 7 here is not
/// just UI — it's the truth. Centralised constant in case we adjust.
const MAX_DAYS = 7;

interface Props {
  onClose: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/// One-time self-serve trial extension confirm modal. Phase 3.5.
///
/// Days picker (1-7), reason dropdown, optional comment. Calls the
/// extend-trial-self-serve edge function. The realtime channel on
/// subscriptions picks up the row update; the customer doesn't need a
/// manual refresh.
export default function TrialExtensionModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [days,       setDays]       = useState<number>(7);
  const [reason,     setReason]     = useState<Reason>('still_evaluating');
  const [comment,    setComment]    = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [done,       setDone]       = useState<{ trial_ends_at: string; days_added: number } | null>(null);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t('trialExtension.errorAuth'));

      const { data, error: fnErr } = await supabase.functions.invoke(
        'extend-trial-self-serve',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          body: {
            days,
            reason,
            comment: comment.trim() || undefined,
          },
        },
      );
      if (fnErr) {
        let msg = fnErr.message ?? t('common.errorGeneric');
        try {
          const errBody = await (fnErr as unknown as {
            context?: { json?: () => Promise<{ error?: string; detail?: string }> };
          }).context?.json?.();
          msg = errBody?.detail ?? errBody?.error ?? msg;
        } catch { /* fall back */ }
        throw new Error(msg);
      }
      setDone({
        trial_ends_at: (data as { trial_ends_at: string }).trial_ends_at,
        days_added:    (data as { days_added: number }).days_added,
      });
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
            <div className="p-2 rounded-lg bg-yellow-900/40 shrink-0">
              <Clock size={18} className="text-yellow-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                {done ? t('trialExtension.titleDone') : t('trialExtension.title')}
              </h2>
              {!done && (
                <p className="text-xs text-gray-400 mt-1">
                  {t('trialExtension.subtitle')}
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
              {t('trialExtension.doneBody', {
                count:  done.days_added,
                date: new Date(done.trial_ends_at).toLocaleDateString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric',
                }),
              })}
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
            {/* ── Body ────────────────────────────────────────────────── */}
            <div className="p-6 space-y-5">
              <p className="text-sm text-gray-300 leading-relaxed">
                {t('trialExtension.explainOnetime')}
              </p>

              {/* Days picker — 1..7 buttons. A range slider would also work
                  but discrete buttons make the cap visible at a glance and
                  let the customer pick at most 7 in one click. */}
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  {t('trialExtension.daysLabel')}
                </label>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: MAX_DAYS }, (_, i) => i + 1).map(n => (
                    <button
                      key={n}
                      onClick={() => setDays(n)}
                      className={`py-2 rounded-md text-sm font-semibold transition-colors ${
                        days === n
                          ? 'bg-yellow-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  {t('trialExtension.reasonLabel')}
                </label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value as Reason)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/40 focus:border-yellow-500"
                >
                  {REASONS.map(r => (
                    <option key={r} value={r}>
                      {t(`trialExtension.reasons.${r}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5">
                  {t('trialExtension.commentLabel')}
                  {' '}
                  <span className="text-gray-600">{t('trialExtension.commentOptional')}</span>
                </label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  rows={2}
                  maxLength={500}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-500/40 focus:border-yellow-500 resize-none"
                  placeholder={t('trialExtension.commentPlaceholder')}
                />
              </div>

              {error && (
                <div className="flex gap-3 p-3 bg-red-950/40 border border-red-900/60 rounded-lg">
                  <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <div className="text-xs text-red-200 leading-relaxed">{error}</div>
                </div>
              )}
            </div>

            {/* ── Footer ────────────────────────────────────────────────── */}
            <div className="p-6 pt-0 flex items-center justify-between gap-3">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-5 py-2.5 text-sm text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="flex items-center gap-2 px-5 py-2.5 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-yellow-500/20 transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t('trialExtension.submitting')}
                  </>
                ) : (
                  t('trialExtension.confirm')
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
