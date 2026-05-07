/**
 * ReferralCard — customer-facing surface for the referral program.
 *
 * Phase 4.7. Pairs with the backend in 4.6 (referrals table + webhook
 * credit grant). Shows the customer:
 *   - their share link, with a one-click copy button
 *   - a summary: how many friends converted, ₹ total earned
 *   - a list of past credited referrals with their credit status
 *
 * The share link encodes the customer's fleet_id as `?ref=<uuid>`.
 * fleet-signup's classifier resolves that token against the fleets
 * table at signup time, sets `acquisition_referrer_fleet_id`, and the
 * razorpay-webhook's `maybeGrantReferralCredit` issues ₹500 to the
 * referrer on the new fleet's first paid charge.
 *
 * Privacy: we never show WHO was referred — RLS gates referrals to
 * "rows where I am the referrer," and we deliberately don't render
 * the referred_fleet_id even though it's in the row. The customer
 * cares about whether they earned, not who triggered it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Gift, Copy, Check, Loader2, AlertCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

interface Props {
  /// The customer's fleet id. Used to construct the share link AND to
  /// scope the referrals query (RLS would filter anyway, but passing
  /// the id keeps the query plan simple and the failure modes explicit).
  fleetId: string | null;
}

/// One referrals row joined with its fleet_credits row. Status is
/// derived client-side — we have all the inputs (redeemed_at, expires_at,
/// now) — and the schema's CHECK guarantees the redemption fields are
/// either all set or all null, so the derivation is unambiguous.
interface ReferralRow {
  id:                   string;
  credited_amount_inr:  number;
  created_at:           string;
  /// PostgREST FK embed. supabase-js types this as `unknown` for a 1:1
  /// embed, so we lock the shape down here.
  fleet_credits: {
    id:           string;
    redeemed_at:  string | null;
    expires_at:   string;
  } | null;
}

type DerivedStatus = 'redeemed' | 'expired' | 'pending';

function deriveStatus(credit: ReferralRow['fleet_credits'], nowIso: string): DerivedStatus {
  if (!credit) return 'pending';            // shouldn't happen, defensive
  if (credit.redeemed_at) return 'redeemed';
  if (credit.expires_at < nowIso) return 'expired';
  return 'pending';
}

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function ReferralCard({ fleetId }: Props) {
  const { t, i18n } = useTranslation();
  const [rows,    setRows]    = useState<ReferralRow[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [copied,  setCopied]  = useState(false);

  // Build the share link from the runtime origin so dev/staging/prod
  // each get the right host without per-environment config. The path
  // is the app root because that's where the AuthPage renders for
  // unauthenticated visitors — a referred user lands there, signs up,
  // and the URL params land in the fleet-signup classifier.
  const shareUrl = useMemo(() => {
    if (!fleetId || typeof window === 'undefined') return null;
    return `${window.location.origin}/?ref=${fleetId}`;
  }, [fleetId]);

  useEffect(() => {
    if (!fleetId) { setRows([]); return; }
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        // FK embed pulls the joined credit row in one round trip.
        // RLS gates both tables: referrals to referrer_fleet_id=my,
        // fleet_credits to fleet_id=my (which equals the referrer FK
        // by construction since the credit was granted to us).
        const { data, error: qErr } = await supabase
          .from('referrals')
          .select(`
            id,
            credited_amount_inr,
            created_at,
            fleet_credits!fleet_credit_id (
              id,
              redeemed_at,
              expires_at
            )
          `)
          .eq('referrer_fleet_id', fleetId)
          .order('created_at', { ascending: false });
        if (qErr) throw qErr;
        if (!cancelled) {
          // PostgREST returns the embedded row as an array even on a
          // 1:1 FK; normalise to a single object (or null) so the rest
          // of the component doesn't have to think about it.
          const normalized: ReferralRow[] = (data ?? []).map(r => {
            const fc = (r as { fleet_credits: unknown }).fleet_credits;
            return {
              id:                  (r as { id: string }).id,
              credited_amount_inr: Number((r as { credited_amount_inr: number }).credited_amount_inr ?? 0),
              created_at:          (r as { created_at: string }).created_at,
              fleet_credits:       Array.isArray(fc) ? (fc[0] ?? null) : (fc as ReferralRow['fleet_credits']),
            };
          });
          setRows(normalized);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || t('common.errorGeneric'));
      }
    })();
    return () => { cancelled = true; };
  }, [fleetId, t]);

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      // Reset the "Copied!" affordance after 2s. No state cleanup
      // needed — by then the user has either moved on or copied again.
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (insecure context, browser permission
      // denied). Fall back to selecting the input — user can ⌘C from
      // there. Below the JSX wires the input as `readOnly` and
      // `onFocus={e => e.target.select()}` for that path.
      setError(t('referralCard.errorClipboard'));
    }
  };

  // ── Summary numbers (always shown) ─────────────────────────────────────────
  // Computed from `rows`. Empty array → all zeros, which renders as the
  // empty state's "0 referrals" line beneath the share section.
  const nowIso = new Date().toISOString();
  const summary = useMemo(() => {
    const list = rows ?? [];
    let totalEarned = 0;
    let redeemedCount = 0;
    let pendingAmount = 0;
    for (const r of list) {
      totalEarned += r.credited_amount_inr;
      const status = deriveStatus(r.fleet_credits, nowIso);
      if (status === 'redeemed') redeemedCount += 1;
      else if (status === 'pending') pendingAmount += r.credited_amount_inr;
    }
    return {
      count:         list.length,
      totalEarned,
      redeemedCount,
      pendingAmount,
    };
  }, [rows, nowIso]);

  return (
    <div className="bg-gradient-to-br from-violet-950/40 via-violet-950/20 to-gray-900 border border-violet-900/40 rounded-xl p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-violet-900/40 shrink-0">
          <Gift size={18} className="text-violet-300" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white">
            {t('referralCard.heading', { amount: formatInr(500) })}
          </h3>
          <p className="text-xs text-violet-100/80 mt-1 leading-relaxed">
            {t('referralCard.body', { amount: formatInr(500) })}
          </p>
        </div>
      </div>

      {/* ── Share link ─────────────────────────────────────────────────── */}
      {shareUrl && (
        <div className="flex items-stretch gap-2">
          <input
            type="text"
            readOnly
            value={shareUrl}
            onFocus={e => e.currentTarget.select()}
            spellCheck={false}
            className="flex-1 min-w-0 bg-gray-900/70 border border-gray-800 rounded-lg px-3 py-2 text-sm font-mono text-gray-200 select-all focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-600"
          />
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold rounded-lg transition-colors shrink-0"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('referralCard.copiedLabel') : t('referralCard.copyLabel')}
          </button>
        </div>
      )}

      {/* ── Summary tiles ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryTile
          label={t('referralCard.summaryReferrals')}
          value={String(summary.count)}
        />
        <SummaryTile
          label={t('referralCard.summaryEarned')}
          value={formatInr(summary.totalEarned)}
          accent="positive"
        />
        <SummaryTile
          label={t('referralCard.summaryPending')}
          value={formatInr(summary.pendingAmount)}
          hint={summary.redeemedCount > 0
            ? t('referralCard.summaryRedeemedHint', { count: summary.redeemedCount })
            : undefined}
        />
      </div>

      {/* ── Recent referrals list ─────────────────────────────────────── */}
      {/* Hidden in the empty state — the share-link section + tiles
          carry the full message for first-time users. Only renders
          when there's at least one credited referral. */}
      {(rows?.length ?? 0) > 0 && (
        <div className="pt-3 border-t border-violet-900/30">
          <h4 className="text-[11px] uppercase tracking-wide text-violet-300/70 font-medium mb-2">
            {t('referralCard.recentHeading')}
          </h4>
          <ul className="space-y-1.5">
            {rows!.slice(0, 5).map(r => {
              const status = deriveStatus(r.fleet_credits, nowIso);
              const date = new Date(r.created_at).toLocaleDateString(
                i18n.language || 'en-IN',
                { day: '2-digit', month: 'short', year: 'numeric' },
              );
              return (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="text-gray-300 truncate">
                    {date} · {formatInr(r.credited_amount_inr)}
                  </span>
                  <ReferralStatusBadge status={status} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <div className="flex gap-2 p-2.5 bg-red-950/40 border border-red-900/60 rounded-lg">
          <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
          <div className="text-xs text-red-200 leading-relaxed">{error}</div>
        </div>
      )}

      {rows === null && !error && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" />
          {t('common.loading')}
        </div>
      )}
    </div>
  );
}

// ─── Tiny presentational helpers ───────────────────────────────────────────

function SummaryTile({
  label,
  value,
  hint,
  accent,
}: {
  label:   string;
  value:   string;
  hint?:   string;
  accent?: 'positive';
}) {
  const valueClass = accent === 'positive' ? 'text-emerald-300' : 'text-white';
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-3">
      <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{label}</p>
      <p className={`text-lg font-bold tabular-nums mt-0.5 ${valueClass}`}>{value}</p>
      {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function ReferralStatusBadge({ status }: { status: DerivedStatus }) {
  const cfg = {
    redeemed: { cls: 'bg-emerald-900/40 text-emerald-300', labelKey: 'referralCard.statusRedeemed' },
    pending:  { cls: 'bg-blue-900/40    text-blue-300',    labelKey: 'referralCard.statusPending'  },
    expired:  { cls: 'bg-gray-800       text-gray-400',    labelKey: 'referralCard.statusExpired'  },
  }[status];
  // We intentionally don't memoise t — the badge re-rendering on locale
  // change is a feature, not a perf issue.
  return (
    <Badge cls={cfg.cls} labelKey={cfg.labelKey} />
  );
}

function Badge({ cls, labelKey }: { cls: string; labelKey: string }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded ${cls} text-[10px] font-semibold uppercase tracking-wide`}>
      {t(labelKey)}
    </span>
  );
}
