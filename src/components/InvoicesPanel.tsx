import { useEffect, useState } from 'react';
import { Loader2, FileText, AlertCircle, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { supabase } from '../lib/supabase';
import InvoiceViewerModal, { type InvoiceFull } from './InvoiceViewerModal';

// ─── Types ───────────────────────────────────────────────────────────────────

/// Slim row used in the list view. The viewer modal fetches the full row
/// (including tax breakdown + customer/supplier snapshots) on click.
export interface InvoiceListRow {
  id:                   string;
  invoice_number:       string;
  invoice_date:         string;
  status:               'draft' | 'issued' | 'cancelled';
  is_dormant_supplier:  boolean;
  description:          string;
  total_inr:            number;
  taxable_amount_inr:   number;
  cgst_amount_inr:      number;
  sgst_amount_inr:      number;
  igst_amount_inr:      number;
  razorpay_payment_id:  string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// `formatDate` lives inside the component now — it depends on the active
// i18n.language so a top-level helper would have to thread the locale through
// or capture it in a closure that ignores switches. Cleaner to keep it local.

// ─── Component ───────────────────────────────────────────────────────────────

/// Invoices panel under the Subscription tab. Phase 1.3.3.
///
/// Reads the list via `invoice-api?action=list`, then opens the print-friendly
/// viewer modal on row click (which fetches the full invoice via
/// `invoice-api?action=get&id=...`). Empty state is the common case for B2C
/// customers and pre-charge fleets — kept gentle, not alarmist.
export default function InvoicesPanel() {
  const { t, i18n } = useTranslation();
  const [rows,    setRows]    = useState<InvoiceListRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Currently-open invoice viewer (full row). null = closed.
  const [viewing, setViewing] = useState<InvoiceFull | null>(null);
  // Set while we're fetching the full invoice for the viewer.
  const [openingId, setOpeningId] = useState<string | null>(null);

  // Locale-aware date formatter — falls back to en-IN if i18n.language hasn't
  // resolved yet. Defined per-render so it picks up language switches without
  // a useMemo gymnastics.
  const formatDate = (iso: string): string =>
    new Date(iso).toLocaleDateString(i18n.language || 'en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error(t('invoices.errorLoad'));

        const { data, error: fnErr } = await supabase.functions.invoke(
          'invoice-api?action=list',
          { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (fnErr) throw fnErr;
        if (cancelled) return;
        setRows((data as InvoiceListRow[]) ?? []);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message ?? t('invoices.errorLoad'));
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // i18n.language change shouldn't refetch; t is stable except across language
    // switches and we reuse the same error copy regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenInvoice = async (row: InvoiceListRow) => {
    setOpeningId(row.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t('invoices.errorOpen'));

      const { data, error: fnErr } = await supabase.functions.invoke(
        `invoice-api?action=get&id=${encodeURIComponent(row.id)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (fnErr) throw fnErr;
      setViewing(data as InvoiceFull);
    } catch (e) {
      setError((e as Error).message ?? t('invoices.errorOpen'));
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <FileText size={16} className="text-blue-400" />
          <h2 className="font-semibold text-white">{t('invoices.panelHeading')}</h2>
        </div>
        {rows && rows.length > 0 && (
          <span className="text-xs text-gray-500">
            {t('invoices.panelCountSuffix', { count: rows.length })}
          </span>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <Loader2 size={18} className="animate-spin mr-2" /> {t('invoices.loadingLabel')}
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="m-4 p-4 flex gap-3 bg-red-950/40 border border-red-900/60 rounded-lg">
          <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-red-200">{error}</div>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && rows?.length === 0 && (
        <div className="px-6 py-10 text-center">
          <FileText size={28} className="text-gray-700 mx-auto mb-3" />
          <p className="text-sm text-gray-400">{t('invoices.emptyTitle')}</p>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed max-w-sm mx-auto">
            {t('invoices.emptyHelp')}
          </p>
        </div>
      )}

      {/* List */}
      {!loading && !error && rows && rows.length > 0 && (
        <div className="divide-y divide-gray-800">
          {rows.map(row => (
            <button
              key={row.id}
              onClick={() => handleOpenInvoice(row)}
              disabled={openingId === row.id}
              className="w-full text-left px-6 py-4 hover:bg-gray-800/50 transition-colors flex items-center justify-between gap-4 disabled:opacity-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm text-white">{row.invoice_number}</span>
                  {row.status === 'cancelled' && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-red-900/60 text-red-300">
                      {t('invoices.chipCancelled')}
                    </span>
                  )}
                  {row.is_dormant_supplier && (
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300"
                      title={t('invoices.chipPreGstTooltip')}
                    >
                      {t('invoices.chipPreGst')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1 truncate">{row.description}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{formatDate(row.invoice_date)}</p>
              </div>

              <div className="text-right shrink-0">
                <div className="text-sm font-semibold text-white">{formatInr(row.total_inr)}</div>
                {(row.cgst_amount_inr + row.sgst_amount_inr + row.igst_amount_inr) > 0 && (
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    {t('invoices.inclGst', {
                      amount: formatInr(row.cgst_amount_inr + row.sgst_amount_inr + row.igst_amount_inr),
                    })}
                  </div>
                )}
                <div className="flex items-center justify-end gap-1 text-[11px] text-blue-400 mt-1">
                  {t('invoices.viewAction')}
                  <ExternalLink size={11} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {viewing && (
        <InvoiceViewerModal invoice={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
