/**
 * BillingDetailsCard — in-app editor for the customer's GSTIN, billing
 * address, state code and (Phase 3.7) invoice email.
 *
 * Lives on the Subscription tab. Until Phase 3.8 these fields could only be
 * set at checkout — fine for first-time signup, useless once the customer
 * was already paying. Real-world: finance-team email rotates, office moves,
 * the company finally registers for GST. Customers shouldn't have to email
 * support to update an invoice address.
 *
 * Reuses the same admin-api `update-billing-details` action as the checkout
 * modal, so all validation / audit-logging stays in one place. The card is
 * intentionally read-only by default to keep the tab calm; clicking "Edit"
 * unfolds the form. Saving collapses back to read-only with the new values.
 *
 * NULL vs empty: an empty input means "clear this field". The admin-api
 * treats `null` as a clear; passing the trimmed empty string would save
 * `''` which would then fail GSTIN format validation on the next read. We
 * normalize on the client so the server sees nulls.
 */

import { useEffect, useMemo, useState } from 'react';
import { Receipt, Pencil, Loader2, AlertCircle, X, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BillingDetails } from './PlanCheckoutModal';

// Mirror of the regex in PlanCheckoutModal + admin-api. Centralising would
// require a shared util module — these three live-spots are tiny enough
// that duplication beats indirection. If we add a fourth, extract.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9]{1}[A-Z]{1}[0-9A-Z]{1}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  /// Current billing details on file. `null` means "not yet loaded" — the
  /// card shows a skeleton; if the loaded value is `{ ...all nulls }`, the
  /// card shows "Not set" placeholders with a prominent Edit button.
  details:  BillingDetails | null;
  /// Same callback signature AdminPage passes to PlanCheckoutModal. Throws
  /// on server failure; the card surfaces the message inline.
  onSave:   (next: BillingDetails) => Promise<void> | void;
}

export default function BillingDetailsCard({ details, onSave }: Props) {
  const { t } = useTranslation();

  // Edit mode is opt-in. Default closed so the tab stays readable for
  // customers who set their details once at checkout and never look again.
  const [editing,   setEditing]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err,       setErr]       = useState<string | null>(null);

  // Local form state — populated from the prop when entering edit mode and
  // when the prop changes mid-edit (e.g. another tab saved). Cancelling
  // resets to whatever's currently in `details`.
  const [gstin,          setGstin]          = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [stateCode,      setStateCode]      = useState('');
  const [billingEmail,   setBillingEmail]   = useState('');

  // Hydrate on enter-edit and whenever the source prop changes underneath us.
  useEffect(() => {
    setGstin(details?.gstin                 ?? '');
    setBillingAddress(details?.billingAddress ?? '');
    setStateCode(details?.stateCode         ?? '');
    setBillingEmail(details?.billingEmail   ?? '');
  }, [details]);

  // GSTIN auto-fills the state code (same heuristic as the checkout modal).
  const handleGstinChange = (raw: string) => {
    const normalized = raw.replace(/\s+/g, '').toUpperCase().slice(0, 15);
    setGstin(normalized);
    if (normalized.length >= 2 && /^[0-9]{2}/.test(normalized)) {
      setStateCode(normalized.slice(0, 2));
    }
  };

  // Disable the save button until at least one field has actually changed.
  // No point in making the customer hit Save just to write the same row.
  const dirty = useMemo(() => (
    (details?.gstin          ?? '') !== gstin ||
    (details?.billingAddress ?? '') !== billingAddress ||
    (details?.stateCode      ?? '') !== stateCode ||
    (details?.billingEmail   ?? '') !== billingEmail
  ), [details, gstin, billingAddress, stateCode, billingEmail]);

  const handleSave = async () => {
    if (submitting || !dirty) return;
    setErr(null);

    const trimmedGstin = gstin.trim();
    if (trimmedGstin && !GSTIN_PATTERN.test(trimmedGstin)) {
      setErr(t('checkout.gstinFormatError'));
      return;
    }
    const trimmedEmail = billingEmail.trim();
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail)) {
      setErr(t('checkout.billingEmailFormatError'));
      return;
    }

    setSubmitting(true);
    try {
      // Empty inputs become nulls — the admin-api treats `null` as a clear.
      await onSave({
        gstin:          trimmedGstin                          || null,
        billingAddress: billingAddress.trim()                 || null,
        stateCode:      stateCode.trim()                      || null,
        billingEmail:   trimmedEmail ? trimmedEmail.toLowerCase() : null,
      });
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message || t('common.errorGeneric'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    setGstin(details?.gstin                 ?? '');
    setBillingAddress(details?.billingAddress ?? '');
    setStateCode(details?.stateCode         ?? '');
    setBillingEmail(details?.billingEmail   ?? '');
    setErr(null);
    setEditing(false);
  };

  // ── Read-only view ────────────────────────────────────────────────────────
  // Used when not editing and once the data has loaded. We show the
  // currently-stored values with a placeholder for unset ones so the
  // customer can see what's on their invoices at a glance.
  const renderReadOnly = () => {
    const dash = <span className="text-gray-600">{t('billingDetailsCard.notSet')}</span>;
    return (
      <div className="space-y-3 text-sm">
        <Row
          label={t('billingDetailsCard.fieldGstin')}
          value={details?.gstin ? <span className="font-mono">{details.gstin}</span> : dash}
        />
        <Row
          label={t('billingDetailsCard.fieldBillingAddress')}
          value={
            details?.billingAddress
              ? <span className="whitespace-pre-line">{details.billingAddress}</span>
              : dash
          }
        />
        <Row
          label={t('billingDetailsCard.fieldStateCode')}
          value={details?.stateCode ? <span className="font-mono">{details.stateCode}</span> : dash}
        />
        <Row
          label={t('billingDetailsCard.fieldBillingEmail')}
          value={details?.billingEmail ?? dash}
        />
      </div>
    );
  };

  // ── Edit form ─────────────────────────────────────────────────────────────
  const renderEditForm = () => (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        {t('checkout.gstinHelp')}
      </p>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          {t('checkout.gstinFieldLabel')} <span className="text-gray-600">{t('checkout.gstinFieldHint')}</span>
        </label>
        <input
          type="text"
          value={gstin}
          onChange={e => handleGstinChange(e.target.value)}
          placeholder="33ABCDE1234F1Z5"
          spellCheck={false}
          autoComplete="off"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono tracking-wider text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          {t('checkout.billingAddressLabel')}
        </label>
        <textarea
          value={billingAddress}
          onChange={e => setBillingAddress(e.target.value)}
          placeholder={t('checkout.billingAddressPlaceholder')}
          rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 resize-none"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          {t('checkout.stateCodeLabel')} <span className="text-gray-600">{t('checkout.stateCodeHint')}</span>
        </label>
        <input
          type="text"
          value={stateCode}
          onChange={e => setStateCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
          placeholder={t('checkout.stateCodePlaceholder')}
          maxLength={2}
          inputMode="numeric"
          className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-center font-mono text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">
          {t('checkout.billingEmailLabel')} <span className="text-gray-600">{t('checkout.billingEmailHint')}</span>
        </label>
        <input
          type="email"
          value={billingEmail}
          onChange={e => setBillingEmail(e.target.value)}
          placeholder={t('checkout.billingEmailPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          inputMode="email"
          maxLength={320}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
        />
      </div>
    </div>
  );

  // ── Frame ─────────────────────────────────────────────────────────────────
  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Receipt size={16} className="text-gray-400" />
            {t('billingDetailsCard.heading')}
          </h3>
          <p className="text-gray-400 text-xs mt-0.5">
            {t('billingDetailsCard.subheading')}
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white px-2.5 py-1 rounded border border-gray-700 hover:border-gray-600 transition-colors"
          >
            <Pencil size={12} />
            {t('billingDetailsCard.editButton')}
          </button>
        )}
      </div>

      {details === null ? (
        <div className="space-y-2">
          <div className="h-3 w-2/3 bg-gray-700/60 rounded animate-pulse" />
          <div className="h-3 w-1/2 bg-gray-700/60 rounded animate-pulse" />
          <div className="h-3 w-1/3 bg-gray-700/60 rounded animate-pulse" />
        </div>
      ) : editing ? (
        <>
          {renderEditForm()}

          {err && (
            <div className="mt-3 flex gap-2 p-2.5 bg-red-950/40 border border-red-900/60 rounded-lg">
              <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
              <div className="text-xs text-red-200 leading-relaxed">{err}</div>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={handleCancel}
              disabled={submitting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
            >
              <X size={12} />
              {t('billingDetailsCard.cancelButton')}
            </button>
            <button
              onClick={handleSave}
              disabled={submitting || !dirty}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-md transition-colors"
            >
              {submitting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {submitting ? t('billingDetailsCard.savingButton') : t('billingDetailsCard.saveButton')}
            </button>
          </div>
        </>
      ) : (
        renderReadOnly()
      )}
    </div>
  );
}

// ─── Tiny presentational helper ─────────────────────────────────────────────

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-start">
      <span className="text-xs uppercase tracking-wide text-gray-500 mt-0.5">{label}</span>
      <span className="text-sm text-gray-200 break-words">{value}</span>
    </div>
  );
}
