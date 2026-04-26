import { useEffect, useState } from 'react';
import { Loader2, FileText, AlertCircle, ExternalLink } from 'lucide-react';
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

/// Invoices panel under the Subscription tab. Phase 1.3.3.
///
/// Reads the list via `invoice-api?action=list`, then opens the print-friendly
/// viewer modal on row click (which fetches the full invoice via
/// `invoice-api?action=get&id=...`). Empty state is the common case for B2C
/// customers and pre-charge fleets — kept gentle, not alarmist.
export default function InvoicesPanel() {
  const [rows,    setRows]    = useState<InvoiceListRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Currently-open invoice viewer (full row). null = closed.
  const [viewing, setViewing] = useState<InvoiceFull | null>(null);
  // Set while we're fetching the full invoice for the viewer.
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error('Please log in again to view invoices.');

        const { data, error: fnErr } = await supabase.functions.invoke(
          'invoice-api?action=list',
          { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (fnErr) throw fnErr;
        if (cancelled) return;
        setRows((data as InvoiceListRow[]) ?? []);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message ?? 'Failed to load invoices');
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleOpenInvoice = async (row: InvoiceListRow) => {
    setOpeningId(row.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error('Please log in again to view this invoice.');

      const { data, error: fnErr } = await supabase.functions.invoke(
        `invoice-api?action=get&id=${encodeURIComponent(row.id)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (fnErr) throw fnErr;
      setViewing(data as InvoiceFull);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to open invoice');
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <FileText size={16} className="text-blue-400" />
          <h2 className="font-semibold text-white">Invoices</h2>
        </div>
        {rows && rows.length > 0 && (
          <span className="text-xs text-gray-500">
            {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'}
          </span>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <Loader2 size={18} className="animate-spin mr-2" /> Loading invoices…
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
          <p className="text-sm text-gray-400">No invoices yet.</p>
          <p className="text-xs text-gray-500 mt-1.5 leading-relaxed max-w-sm mx-auto">
            We'll issue a GST tax invoice automatically each time a paid subscription is charged.
            Make sure your GSTIN is on file before your first payment to claim Input Tax Credit.
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
                      Cancelled
                    </span>
                  )}
                  {row.is_dormant_supplier && (
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300"
                      title="Issued before our GST registration — no tax components"
                    >
                      Pre-GST
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
                    incl. {formatInr(row.cgst_amount_inr + row.sgst_amount_inr + row.igst_amount_inr)} GST
                  </div>
                )}
                <div className="flex items-center justify-end gap-1 text-[11px] text-blue-400 mt-1">
                  View
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
