import { useEffect, useState } from 'react';
import {
  History, CheckCircle, XCircle, AlertCircle, Clock,
  CreditCard, Gift, Users, PauseCircle, PlayCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AuditLogRow {
  id:            string;
  action:        string;
  resource_type: string;
  new_values?:   Record<string, unknown> | null;
  created_at:    string;
}

interface Props {
  /// Render-gating props from AdminPage. The card is hidden for fleets that
  /// have no audit history yet (very fresh signup) — empty-state copy
  /// would be noise on a tab that already has plenty going on.
  hasFleet:    boolean;
}

// ─── Action whitelist ───────────────────────────────────────────────────────

/// Audit-log actions that are subscription / billing-relevant from the
/// customer's point of view. Other audit actions (driver creation, API
/// key rotation, threshold edits, …) live in their own histories on
/// other tabs; mixing them in here would dilute the timeline.
///
/// Add new entries here AND in the i18n bundle (`subscriptionHistory.event`
/// namespace) AND in the icon/severity maps below.
const RELEVANT_ACTIONS: ReadonlySet<string> = new Set([
  'subscription.activated',
  'subscription.charged',
  'subscription.cancelled',
  'subscription.cancellation_requested',
  'subscription.checkout_initiated',
  'subscription.expired',
  'subscription.enterprise_contact_initiated',
  'subscription.pause_requested',
  'subscription.paused',
  'subscription.resume_requested',
  'subscription.resumed',
  'extend-trial',
  'trial.self_extended',
  'fleet.billing_details_updated',
  'fleet.language_preference_updated',
  'cashback.redeemed',
]);

// ─── Visual maps ────────────────────────────────────────────────────────────

type Severity = 'good' | 'neutral' | 'warning' | 'critical';

const ACTION_ICON: Record<string, typeof CheckCircle> = {
  'subscription.activated':                  CheckCircle,
  'subscription.charged':                    CreditCard,
  'subscription.cancelled':                  XCircle,
  'subscription.cancellation_requested':     XCircle,
  'subscription.checkout_initiated':         CreditCard,
  'subscription.expired':                    AlertCircle,
  'subscription.enterprise_contact_initiated': Users,
  'subscription.pause_requested':            PauseCircle,
  'subscription.paused':                     PauseCircle,
  'subscription.resume_requested':           PlayCircle,
  'subscription.resumed':                    PlayCircle,
  'extend-trial':                            Clock,
  'trial.self_extended':                     Clock,
  'fleet.billing_details_updated':           CreditCard,
  'fleet.language_preference_updated':       History,
  'cashback.redeemed':                       Gift,
};

const ACTION_SEVERITY: Record<string, Severity> = {
  'subscription.activated':                  'good',
  'subscription.charged':                    'good',
  'subscription.cancelled':                  'critical',
  'subscription.cancellation_requested':     'warning',
  'subscription.checkout_initiated':         'neutral',
  'subscription.expired':                    'critical',
  'subscription.enterprise_contact_initiated': 'neutral',
  'subscription.pause_requested':            'warning',
  'subscription.paused':                     'warning',
  'subscription.resume_requested':           'good',
  'subscription.resumed':                    'good',
  'extend-trial':                            'good',
  'trial.self_extended':                     'good',
  'fleet.billing_details_updated':           'neutral',
  'fleet.language_preference_updated':       'neutral',
  'cashback.redeemed':                       'good',
};

const SEVERITY_RING: Record<Severity, string> = {
  good:     'bg-emerald-900/40 text-emerald-300',
  neutral:  'bg-gray-800/60   text-gray-400',
  warning:  'bg-yellow-900/40 text-yellow-300',
  critical: 'bg-red-900/40    text-red-300',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Best-effort detail string for a row. Reads a small handful of keys we
/// actually emit from the writers; anything we don't recognize falls
/// through to the empty string and the timeline shows the headline only.
function detailFor(row: AuditLogRow): string {
  const nv = row.new_values ?? {};
  switch (row.action) {
    case 'subscription.activated':
    case 'subscription.charged': {
      const plan  = (nv.plan          as string | undefined);
      const cycle = (nv.billing_cycle as string | undefined);
      const count = (nv.vehicle_count as number | undefined);
      const parts: string[] = [];
      if (plan)  parts.push(plan);
      if (cycle) parts.push(cycle);
      if (typeof count === 'number') parts.push(`${count} vehicle${count === 1 ? '' : 's'}`);
      return parts.join(' · ');
    }
    case 'subscription.cancellation_requested': {
      const reason = (nv.reason as string | undefined);
      return reason ? reason.replace(/_/g, ' ') : '';
    }
    case 'extend-trial': {
      const days = (nv.days_extended as number | undefined);
      return typeof days === 'number' ? `+${days} days` : '';
    }
    case 'trial.self_extended': {
      const days = (nv.days_added as number | undefined);
      return typeof days === 'number' ? `+${days} days` : '';
    }
    case 'cashback.redeemed': {
      const amount = (nv.amount_inr as number | undefined);
      return typeof amount === 'number' ? `₹${amount.toLocaleString('en-IN')}` : '';
    }
    case 'fleet.language_preference_updated': {
      const lang = (nv.preferred_language as string | undefined);
      return lang ?? '';
    }
    default:
      return '';
  }
}

function formatTimestamp(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale || 'en-IN', {
    day:   '2-digit',
    month: 'short',
    year:  'numeric',
    hour:  '2-digit',
    minute:'2-digit',
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

const VISIBLE_LIMIT_INITIAL = 6;

/// Subscription / billing history timeline. Phase 3.3.
///
/// Shows the customer their own billing-related audit trail: when they
/// activated, paid, cancelled, got cashback, etc. Strictly customer-side
/// view — operator audit lives elsewhere.
///
/// Reads from admin-api ?action=audit-logs and filters to RELEVANT_ACTIONS.
/// We don't pre-filter server-side because the existing endpoint only
/// supports a single resource_type filter and we span 'subscription' +
/// 'fleet' + 'fleet_credit'; client-side filter is cheaper than three
/// round trips.
export default function SubscriptionHistoryCard({ hasFleet }: Props) {
  const { t, i18n } = useTranslation();
  const [rows,    setRows]    = useState<AuditLogRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!hasFleet) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error(t('subscriptionHistory.errorAuth'));

        // 100 covers months of activity for a typical fleet; we filter
        // and take the top ~20 client-side. If this gets noisy, we can
        // add a `actions=` server filter later.
        const { data, error: fnErr } = await supabase.functions.invoke(
          'admin-api?action=audit-logs&limit=100',
          {
            method:  'GET',
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        if (fnErr) throw fnErr;
        if (cancelled) return;

        const all     = (data as AuditLogRow[]) ?? [];
        const filtered = all.filter(r => RELEVANT_ACTIONS.has(r.action));
        setRows(filtered);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [hasFleet, t]);

  // Hidden for very fresh fleets — no events of interest yet.
  if (loading)             return null;
  if (error)               return null;          // best-effort surface; banner already exists for hard errors
  if (!rows || rows.length === 0) return null;

  const visible = showAll ? rows : rows.slice(0, VISIBLE_LIMIT_INITIAL);
  const canExpand = rows.length > VISIBLE_LIMIT_INITIAL;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <History size={15} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-white">
            {t('subscriptionHistory.heading')}
          </h2>
        </div>
        <span className="text-xs text-gray-500">
          {t('subscriptionHistory.subtitle', { count: rows.length })}
        </span>
      </div>

      <ol className="space-y-3">
        {visible.map(row => {
          const Icon     = ACTION_ICON[row.action] ?? History;
          const severity = ACTION_SEVERITY[row.action] ?? 'neutral';
          const ringCls  = SEVERITY_RING[severity];
          const detail   = detailFor(row);
          // i18n key per action — falls through to the raw action value if
          // the bundle hasn't been updated yet (visible regression rather
          // than silent missing label).
          const labelKey = `subscriptionHistory.event.${row.action.replace(/[.\-]/g, '_')}`;
          const label    = t(labelKey, { defaultValue: row.action });
          return (
            <li key={row.id} className="flex items-start gap-3">
              <div className={`p-1.5 rounded-lg shrink-0 ${ringCls}`}>
                <Icon size={13} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="text-sm font-medium text-gray-200">{label}</span>
                  <span className="text-[11px] text-gray-500 tabular-nums">
                    {formatTimestamp(row.created_at, i18n.language)}
                  </span>
                </div>
                {detail && (
                  <p className="text-xs text-gray-500 mt-0.5">{detail}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {canExpand && (
        <div className="mt-4 pt-3 border-t border-gray-800 text-center">
          <button
            onClick={() => setShowAll(s => !s)}
            className="text-xs text-gray-500 hover:text-gray-200 transition-colors"
          >
            {showAll
              ? t('subscriptionHistory.showFewer')
              : t('subscriptionHistory.showAll', { count: rows.length })}
          </button>
        </div>
      )}
    </div>
  );
}
