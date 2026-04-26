import { X, Printer } from 'lucide-react';
import { useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

/// Full invoice row as returned by `invoice-api?action=get`. Snapshot-style:
/// every field needed to render the invoice is present, no further lookups.
export interface InvoiceFull {
  id:                       string;
  invoice_number:           string;
  invoice_date:             string;
  status:                   'draft' | 'issued' | 'cancelled';
  is_dormant_supplier:      boolean;

  customer_name:            string;
  customer_gstin:           string | null;
  customer_address:         string | null;
  customer_state_code:      string | null;

  supplier_name:            string;
  supplier_gstin:           string | null;
  supplier_address:         string;
  supplier_state_code:      string;

  description:              string;
  hsn_sac:                  string;
  quantity:                 number;
  unit_price_inr:           number;
  taxable_amount_inr:       number;

  cgst_pct:                 number;
  cgst_amount_inr:          number;
  sgst_pct:                 number;
  sgst_amount_inr:          number;
  igst_pct:                 number;
  igst_amount_inr:          number;
  total_inr:                number;

  razorpay_payment_id:      string | null;
  razorpay_subscription_id: string | null;
}

interface Props {
  invoice: InvoiceFull;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

// Convert a number to Indian-numbering words for the legal "Amount in words"
// line every GST invoice carries. Handles up to ten crore.
function rupeesInWords(n: number): string {
  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen',
    'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function below100(num: number): string {
    if (num < 20) return ones[num];
    return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '');
  }
  function below1000(num: number): string {
    if (num < 100) return below100(num);
    return ones[Math.floor(num / 100)] + ' Hundred' + (num % 100 ? ' ' + below100(num % 100) : '');
  }

  const rupees = Math.floor(n);
  const paise  = Math.round((n - rupees) * 100);

  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';

  const crore = Math.floor(rupees / 10000000);
  const lakh  = Math.floor((rupees % 10000000) / 100000);
  const thou  = Math.floor((rupees % 100000) / 1000);
  const rest  = rupees % 1000;

  const parts: string[] = [];
  if (crore) parts.push(below100(crore) + ' Crore');
  if (lakh)  parts.push(below100(lakh)  + ' Lakh');
  if (thou)  parts.push(below100(thou)  + ' Thousand');
  if (rest)  parts.push(below1000(rest));

  let result = parts.join(' ').trim() + ' Rupees';
  if (paise > 0) result += ' and ' + below100(paise) + ' Paise';
  return result + ' Only';
}

// ─── Component ───────────────────────────────────────────────────────────────

/// Print-friendly invoice viewer. Phase 1.3.3.
///
/// Renders the invoice as plain HTML inside a styled white card. The
/// "Print / Save as PDF" button calls window.print(); the @media print
/// CSS rules below hide the chrome so the printed page contains only the
/// invoice itself. Avoids a PDF library entirely — Indian B2B accounting
/// teams accept browser-printed PDFs without issue.
export default function InvoiceViewerModal({ invoice, onClose }: Props) {
  // Esc to close — skip while a native print dialog is open since browsers
  // already handle Esc there.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const intraState = invoice.cgst_amount_inr > 0 || invoice.sgst_amount_inr > 0;
  const interState = invoice.igst_amount_inr > 0;
  const dormant    = invoice.is_dormant_supplier;
  const cancelled  = invoice.status === 'cancelled';

  const totalGst   = invoice.cgst_amount_inr + invoice.sgst_amount_inr + invoice.igst_amount_inr;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/80 backdrop-blur-sm overflow-y-auto py-8 px-4 print:bg-white print:p-0 print:py-0 print:overflow-visible"
      onClick={onClose}
    >
      {/* Print-only overrides — hide page chrome, paint the card flat. */}
      <style>{`
        @media print {
          @page { margin: 14mm; }
          html, body { background: white !important; }
          .invoice-print-hide { display: none !important; }
          .invoice-print-card {
            box-shadow: none !important;
            border:     none  !important;
            max-width:  none  !important;
            margin:     0     !important;
          }
        }
      `}</style>

      <div
        className="invoice-print-card relative bg-white text-gray-900 w-full max-w-3xl shadow-2xl my-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Toolbar (hidden on print) ───────────────────────────────────── */}
        <div className="invoice-print-hide sticky top-0 z-10 flex items-center justify-between gap-3 px-6 py-3 bg-gray-50 border-b border-gray-200">
          <span className="text-xs text-gray-500 font-mono">{invoice.invoice_number}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
            >
              <Printer size={12} /> Print / Save as PDF
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-200 rounded-md transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── Invoice body ────────────────────────────────────────────────── */}
        <div className="p-10 print:p-0">
          {/* Status banners (printed too — these are legally meaningful) */}
          {cancelled && (
            <div className="mb-6 px-4 py-2 bg-red-50 border-l-4 border-red-500 text-sm text-red-900 font-semibold">
              CANCELLED — this invoice has been voided.
            </div>
          )}
          {dormant && !cancelled && (
            <div className="mb-6 px-4 py-2 bg-yellow-50 border-l-4 border-yellow-500 text-xs text-yellow-900 leading-relaxed">
              Issued before our GST registration was active. Treated as a non-GST
              receipt — no Input Tax Credit available on this invoice.
            </div>
          )}

          {/* Header: title + invoice meta */}
          <div className="flex items-start justify-between gap-6 pb-6 border-b border-gray-200">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {dormant ? 'Receipt' : 'Tax Invoice'}
              </h1>
              <p className="text-xs text-gray-500 mt-1">
                {dormant
                  ? 'Pre-GST registration — issued for accounting reference.'
                  : 'Original for Recipient'}
              </p>
            </div>
            <div className="text-right text-sm">
              <div className="font-mono font-semibold">{invoice.invoice_number}</div>
              <div className="text-xs text-gray-500 mt-0.5">Issued {formatDate(invoice.invoice_date)}</div>
            </div>
          </div>

          {/* Parties */}
          <div className="grid grid-cols-2 gap-6 py-6 border-b border-gray-200">
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-2">From</h3>
              <p className="font-semibold">{invoice.supplier_name}</p>
              <p className="text-xs text-gray-600 whitespace-pre-line mt-0.5">{invoice.supplier_address}</p>
              {invoice.supplier_gstin
                ? <p className="text-xs text-gray-700 mt-1.5">GSTIN: <span className="font-mono">{invoice.supplier_gstin}</span></p>
                : <p className="text-xs text-yellow-700 mt-1.5 italic">GST registration pending</p>}
              <p className="text-xs text-gray-500 mt-0.5">State code: {invoice.supplier_state_code}</p>
            </div>
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-2">Bill to</h3>
              <p className="font-semibold">{invoice.customer_name}</p>
              {invoice.customer_address && (
                <p className="text-xs text-gray-600 whitespace-pre-line mt-0.5">{invoice.customer_address}</p>
              )}
              {invoice.customer_gstin && (
                <p className="text-xs text-gray-700 mt-1.5">GSTIN: <span className="font-mono">{invoice.customer_gstin}</span></p>
              )}
              {invoice.customer_state_code && (
                <p className="text-xs text-gray-500 mt-0.5">State code: {invoice.customer_state_code}</p>
              )}
            </div>
          </div>

          {/* Line item table */}
          <div className="py-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left  py-2 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Description</th>
                  <th className="text-left  py-2 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">HSN/SAC</th>
                  <th className="text-right py-2 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Qty</th>
                  <th className="text-right py-2 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Unit (₹)</th>
                  <th className="text-right py-2 text-[10px] uppercase tracking-widest text-gray-500 font-semibold">Taxable (₹)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-200">
                  <td className="py-3">{invoice.description}</td>
                  <td className="py-3 font-mono text-xs">{invoice.hsn_sac}</td>
                  <td className="py-3 text-right">{invoice.quantity}</td>
                  <td className="py-3 text-right">{formatInr(invoice.unit_price_inr)}</td>
                  <td className="py-3 text-right">{formatInr(invoice.taxable_amount_inr)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end pb-6">
            <div className="w-72 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-gray-600">Taxable amount</span>
                <span>{formatInr(invoice.taxable_amount_inr)}</span>
              </div>
              {intraState && (
                <>
                  <div className="flex justify-between">
                    <span className="text-gray-600">CGST @ {invoice.cgst_pct}%</span>
                    <span>{formatInr(invoice.cgst_amount_inr)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">SGST @ {invoice.sgst_pct}%</span>
                    <span>{formatInr(invoice.sgst_amount_inr)}</span>
                  </div>
                </>
              )}
              {interState && (
                <div className="flex justify-between">
                  <span className="text-gray-600">IGST @ {invoice.igst_pct}%</span>
                  <span>{formatInr(invoice.igst_amount_inr)}</span>
                </div>
              )}
              {dormant && (
                <div className="flex justify-between text-xs text-gray-500 italic">
                  <span>GST not applicable</span>
                  <span>—</span>
                </div>
              )}
              <div className="flex justify-between pt-2 mt-2 border-t border-gray-300 font-bold text-base">
                <span>Total</span>
                <span>{formatInr(invoice.total_inr)}</span>
              </div>
              {totalGst > 0 && (
                <div className="text-[10px] text-gray-500 text-right">
                  (incl. {formatInr(totalGst)} GST)
                </div>
              )}
            </div>
          </div>

          {/* Amount in words */}
          <div className="pb-6 border-b border-gray-200 text-sm">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mr-2">
              Amount in words
            </span>
            {rupeesInWords(invoice.total_inr)}
          </div>

          {/* Footer: payment ref + signature line */}
          <div className="pt-6 grid grid-cols-2 gap-6 text-xs text-gray-600">
            <div>
              {invoice.razorpay_payment_id && (
                <p>
                  <span className="text-gray-500">Payment ref: </span>
                  <span className="font-mono">{invoice.razorpay_payment_id}</span>
                </p>
              )}
              {invoice.razorpay_subscription_id && (
                <p className="mt-1">
                  <span className="text-gray-500">Subscription: </span>
                  <span className="font-mono">{invoice.razorpay_subscription_id}</span>
                </p>
              )}
              <p className="mt-3 text-gray-500 italic leading-relaxed">
                This is a system-generated invoice and does not require a signature.
              </p>
            </div>
            <div className="text-right">
              <div className="border-t border-gray-300 pt-2 mt-12 inline-block min-w-[12rem]">
                <p className="text-xs">For {invoice.supplier_name}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Authorized signatory</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
