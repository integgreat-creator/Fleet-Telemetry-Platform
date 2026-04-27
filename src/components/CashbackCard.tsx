import { useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreditRow {
  id:          string;
  amount_inr:  number;
  reason:      string;
  expires_at:  string;
  redeemed_at: string | null;
}

interface Props {
  fleetId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

/// Cashback / credit balance card on the AdminPage Subscription tab. Phase 1.6.1.
///
/// Hidden when there are no unredeemed, unexpired credits — keeps the tab
/// quiet for the 99% of fleets without a balance. RLS on `fleet_credits`
/// scopes the SELECT to the caller's own fleet, so we read directly via the
/// supabase client (no edge-function indirection).
export default function CashbackCard({ fleetId }: Props) {
  const { t, i18n } = useTranslation();
  const [credits,  setCredits]  = useState<CreditRow[] | null>(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!fleetId) { setCredits([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from('fleet_credits')
        .select('id, amount_inr, reason, expires_at, redeemed_at')
        .eq('fleet_id', fleetId)
        .is('redeemed_at', null)
        .gte('expires_at', nowIso)
        .order('granted_at', { ascending: true });
      if (cancelled) return;
      if (error) {
        console.warn('[cashback] load failed', error);
        setCredits([]);
      } else {
        setCredits((data as CreditRow[]) ?? []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fleetId]);

  // Hidden during initial load + when there's nothing to surface. The card is
  // promotional, not informational — empty-state copy would just add noise.
  if (loading)            return null;
  if (!credits?.length)   return null;

  const totalInr = credits.reduce((sum, c) => sum + Number(c.amount_inr), 0);

  // Earliest expiry drives the headline copy. If the customer has multiple
  // credits, expiry happens credit-by-credit, but only the soonest one is
  // visible without expanding — fine for a top-of-tab summary.
  const soonestExpiry = credits[0]?.expires_at;
  const expiryDate    = soonestExpiry
    ? new Date(soonestExpiry).toLocaleDateString(i18n.language || 'en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      })
    : null;

  return (
    <div className="bg-emerald-950/30 border border-emerald-900/60 rounded-xl p-5 flex items-start gap-4">
      <div className="p-2 rounded-lg bg-emerald-900/40 shrink-0">
        <Gift size={18} className="text-emerald-300" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-white">{t('cashback.heading')}</h3>
          <span className="text-emerald-300 font-bold">{formatInr(totalInr)}</span>
        </div>
        <p className="text-xs text-emerald-200/80 mt-1 leading-relaxed">
          {t('cashback.body', { date: expiryDate ?? '—' })}
        </p>
      </div>
    </div>
  );
}
