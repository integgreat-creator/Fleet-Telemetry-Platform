import { useMemo, useState } from 'react';
import { X, Plus, Minus, AlertCircle, ArrowRight, Lock, Loader2, Receipt, ChevronDown } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import {
  monthlyPriceFor,
  annualPriceFor,
  type PlanCatalogEntry,
} from '../hooks/usePlanCatalog';
import type { BillingCycle } from '../hooks/useSubscription';

// Soft cap: fleets larger than this are routed to Enterprise (custom pricing).
const SOFT_CAP_VEHICLES = 500;

// 15-char GSTIN: 2-digit state + 5 alpha (PAN org) + 4 digits + 1 alpha (PAN check)
// + 1 digit (entity number) + 1 alpha ('Z' for normal taxpayers) + 1 alphanumeric.
// Validated client-side for fast feedback; the server validates again with
// the same rule (admin-api → update-billing-details).
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9]{1}[A-Z]{1}[0-9A-Z]{1}$/;

// Pragmatic email check — matches the server's own pattern in admin-api's
// update-billing-details handler. Not full RFC 5321 (that regex is famously
// untenable), but catches every realistic typo while accepting the long
// tail of legitimate corporate addresses (`+aliases`, `accounts.payable@`,
// hyphenated TLDs, etc.). The DB CHECK is the third line of defence.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface BillingDetails {
  gstin:           string | null;
  billingAddress:  string | null;
  stateCode:       string | null;
  /// Optional finance-team email for invoices/receipts. NULL falls back to
  /// the manager's auth email when invoices are dispatched. Phase 3.7.
  billingEmail:    string | null;
}

interface Props {
  plan:          PlanCatalogEntry;
  /// How many vehicles the fleet currently has registered — the stepper
  /// cannot go below this, otherwise the customer would under-provision.
  vehiclesUsed:  number;
  /// True once the fleet has been active on monthly billing for ≥ 3 months
  /// (tracked via `subscriptions.annual_unlocked_at`). Gates the Annual tab.
  annualUnlocked: boolean;
  /// Existing customer billing identity, fetched by the parent before opening
  /// the modal (admin-api ?action=billing-details). Pre-fills the GSTIN form
  /// so returning customers don't retype it. All fields nullable for
  /// first-time customers and B2C users without a GSTIN.
  initialBilling?: BillingDetails;
  /// Which billing cycle should be pre-selected when the modal opens.
  /// Defaults to 'monthly' for first-time checkout. The post-unlock annual
  /// teaser (Phase 3.12) opens the modal with `'annual'` so the customer
  /// lands directly on the annual pricing they already opted into.
  /// Ignored if the customer hasn't crossed the annual-unlock threshold —
  /// the Annual tab is gated by `annualUnlocked` and falling back to
  /// monthly is the right thing.
  initialBillingCycle?: BillingCycle;
  onClose:       () => void;
  /// Persists customer billing identity (GSTIN, address, state code) BEFORE
  /// the Razorpay subscription is created — so the invoice that fires when
  /// `subscription.charged` lands has the right snapshot. The modal awaits
  /// this; throwing surfaces inline like onContinue errors.
  onSaveBilling: (details: BillingDetails) => Promise<void> | void;
  /// Called when the customer commits. Receives the chosen vehicle_count and
  /// billing cycle, and is expected to (a) create a Razorpay subscription
  /// server-side and (b) open the embedded Razorpay Checkout. The modal
  /// awaits this promise — throwing an Error from the parent surfaces the
  /// error message inside the modal without closing it, so the customer
  /// can retry. Returning normally closes the modal.
  onContinue:    (vehicleCount: number, billingCycle: BillingCycle) => Promise<void> | void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampCount(raw: number, min: number, max: number): number {
  if (Number.isNaN(raw)) return min;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PlanCheckoutModal({
  plan,
  vehiclesUsed,
  annualUnlocked,
  initialBilling,
  initialBillingCycle,
  onClose,
  onSaveBilling,
  onContinue,
}: Props) {
  const { t } = useTranslation();

  // The floor the customer can select:
  //   - at least plan.minVehicles (business rule)
  //   - at least current vehiclesUsed (can't under-provision)
  const minCount = Math.max(plan.minVehicles, vehiclesUsed, 1);

  const [vehicleCount, setVehicleCount] = useState<number>(minCount);
  // Honor `initialBillingCycle` only when annual is actually selectable —
  // otherwise the modal would open on a tab the customer can't activate.
  const [billingCycle, setBillingCycle] = useState<BillingCycle>(
    initialBillingCycle === 'annual' && annualUnlocked ? 'annual' : 'monthly',
  );

  // ── GSTIN / billing-address capture (Phase 1.3.1) ────────────────────────
  // Auto-expanded if the customer already has details on file (so they
  // immediately see what we'll print on their invoice). Closed by default
  // for first-time customers — the section is opt-in to keep the modal
  // light for B2C, but heavily encouraged via copy.
  const [gstin,           setGstin]          = useState<string>(initialBilling?.gstin          ?? '');
  const [billingAddress,  setBillingAddress] = useState<string>(initialBilling?.billingAddress ?? '');
  const [stateCode,       setStateCode]      = useState<string>(initialBilling?.stateCode      ?? '');
  const [billingEmail,    setBillingEmail]   = useState<string>(initialBilling?.billingEmail   ?? '');
  // Auto-expand the section if the customer has any of the GSTIN-section
  // fields on file — including the new billing_email — so they can see what
  // we'll print on the invoice without an extra click.
  const [gstinExpanded,   setGstinExpanded]  = useState<boolean>(
    !!(initialBilling?.gstin || initialBilling?.billingEmail),
  );

  // Format error shown inline under the GSTIN input. Cleared on every keystroke.
  const [gstinError,      setGstinError]     = useState<string | null>(null);
  // Format error shown inline under the billing-email input.
  const [emailError,      setEmailError]     = useState<string | null>(null);

  // Set true while the parent's onContinue promise is in flight (Razorpay
  // subscription create + embedded checkout open). Disables the form so the
  // customer can't double-submit.
  const [submitting, setSubmitting] = useState(false);
  /// Server-side error surfaced to the customer (e.g. 503 dormant Razorpay,
  /// 422 below-minimum). null while the form is healthy.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Normalize the GSTIN as the user types: uppercase + strip whitespace, then
  // validate against the canonical regex once they've typed all 15 chars.
  const handleGstinChange = (raw: string) => {
    const normalized = raw.replace(/\s+/g, '').toUpperCase().slice(0, 15);
    setGstin(normalized);
    setGstinError(null);
    // Auto-fill state code from the first 2 digits of the GSTIN — saves a
    // step and guarantees gstin/state_code consistency the server enforces.
    if (normalized.length >= 2 && /^[0-9]{2}/.test(normalized)) {
      setStateCode(normalized.slice(0, 2));
    }
  };

  // Snapshot of "did the user actually fill in any billing detail?" — used to
  // decide whether to call onSaveBilling at all (saves a needless round-trip
  // for B2C customers who skip the section).
  const hasBillingChanges = useMemo(() => {
    return (
      gstin           !== (initialBilling?.gstin          ?? '') ||
      billingAddress  !== (initialBilling?.billingAddress ?? '') ||
      stateCode       !== (initialBilling?.stateCode      ?? '') ||
      billingEmail    !== (initialBilling?.billingEmail   ?? '')
    );
  }, [gstin, billingAddress, stateCode, billingEmail, initialBilling]);

  const handleContinue = async () => {
    if (submitting) return;

    // Validate GSTIN format up-front (skip if unset — GSTIN is optional).
    const trimmedGstin = gstin.trim();
    if (trimmedGstin && !GSTIN_PATTERN.test(trimmedGstin)) {
      setGstinExpanded(true);
      setGstinError(t('checkout.gstinFormatError'));
      return;
    }

    // Validate billing-email format. Optional field, so empty is fine; if
    // the customer typed something, it has to look like an email — server
    // and DB will reject otherwise, and we'd rather catch it here.
    const trimmedEmail = billingEmail.trim();
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail)) {
      setGstinExpanded(true);
      setEmailError(t('checkout.billingEmailFormatError'));
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      // Persist billing details first — so the invoice generated when
      // Razorpay charges has the correct customer snapshot. If save fails,
      // we don't proceed to checkout: the customer should know their tax
      // invoice would have been wrong before paying.
      if (hasBillingChanges) {
        await onSaveBilling({
          gstin:          trimmedGstin || null,
          billingAddress: billingAddress.trim() || null,
          stateCode:      stateCode.trim()      || null,
          // Lower-case to match how the admin-api stores it; keeps lookups
          // case-insensitive without needing a citext column.
          billingEmail:   trimmedEmail ? trimmedEmail.toLowerCase() : null,
        });
      }

      await onContinue(vehicleCount, billingCycle);
      // Success — close the modal so the parent's payment overlay (Razorpay)
      // owns the screen. Don't clear `submitting` first; the unmount is
      // imminent and a dangling state update would warn.
      onClose();
    } catch (e) {
      setSubmitError((e as Error).message || t('common.errorGeneric'));
      setSubmitting(false);
    }
  };

  const overSoftCap = vehicleCount >= SOFT_CAP_VEHICLES;

  const monthlyTotal = useMemo(
    () => monthlyPriceFor(plan, vehicleCount),
    [plan, vehicleCount],
  );
  const annualTotal = useMemo(
    () => annualPriceFor(plan, vehicleCount),
    [plan, vehicleCount],
  );
  // How much the customer saves per year by picking annual vs. 12 × monthly.
  const annualSavings = useMemo(() => {
    if (monthlyTotal == null || annualTotal == null) return null;
    return Math.max(0, monthlyTotal * 12 - annualTotal);
  }, [monthlyTotal, annualTotal]);

  const inc = () => setVehicleCount(c => clampCount(c + 1, minCount, SOFT_CAP_VEHICLES));
  const dec = () => setVehicleCount(c => clampCount(c - 1, minCount, SOFT_CAP_VEHICLES));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between p-6 border-b border-gray-800">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold">{t('checkout.headerLabel')}</p>
            <h2 className="text-xl font-bold text-white mt-1">{t('checkout.modalTitle', { plan: plan.displayName })}</h2>
            <p className="text-sm text-gray-400 mt-1">
              {t('checkout.pricePerVehicle', { price: (plan.pricePerVehicleInr ?? 0).toLocaleString('en-IN') })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Stepper ────────────────────────────────────────────────────── */}
        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {t('checkout.vehicleCountLabel')}
            </label>

            <div className="flex items-center gap-3">
              <button
                onClick={dec}
                disabled={vehicleCount <= minCount}
                className="w-11 h-11 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                aria-label={t('checkout.vehicleAriaDecrease')}
              >
                <Minus size={16} />
              </button>

              <input
                type="number"
                inputMode="numeric"
                value={vehicleCount}
                min={minCount}
                max={SOFT_CAP_VEHICLES}
                onChange={e =>
                  setVehicleCount(clampCount(parseInt(e.target.value, 10), minCount, SOFT_CAP_VEHICLES))
                }
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-center text-lg font-semibold text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
              />

              <button
                onClick={inc}
                disabled={vehicleCount >= SOFT_CAP_VEHICLES}
                className="w-11 h-11 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                aria-label={t('checkout.vehicleAriaIncrease')}
              >
                <Plus size={16} />
              </button>
            </div>

            <div className="mt-2 flex items-start justify-between gap-3 text-xs text-gray-400">
              <span>
                {t('checkout.vehicleMinHint', {
                  count: plan.minVehicles,
                  plan:  plan.displayName,
                })}
              </span>
              {vehiclesUsed > plan.minVehicles && (
                <span>{t('checkout.vehicleCurrentHint', { count: vehiclesUsed })}</span>
              )}
            </div>
          </div>

          {/* ── Soft-cap nudge to Enterprise ───────────────────────────── */}
          {overSoftCap && (
            <div className="flex gap-3 p-3 bg-yellow-950/40 border border-yellow-900/60 rounded-lg">
              <AlertCircle size={16} className="text-yellow-500 shrink-0 mt-0.5" />
              <div className="text-xs text-yellow-200 leading-relaxed">
                {/* <Trans> preserves the inline <strong> wrapper around
                    "Enterprise" so the translation stays one cohesive
                    sentence — translators see the placeholder as <1> in
                    the source string and produce a Tamil equivalent that
                    keeps the emphasis where it belongs. */}
                <Trans
                  i18nKey="checkout.softCapNudge"
                  values={{ cap: SOFT_CAP_VEHICLES }}
                  components={{ strong: <span className="font-semibold" /> }}
                />
              </div>
            </div>
          )}

          {/* ── Billing-cycle toggle (1.2.3) ───────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-300">{t('checkout.billingCycleLabel')}</label>
              {plan.annualDiscountPct > 0 && (
                <span className="text-[11px] text-green-400 font-semibold">
                  {t('checkout.annualSavingsBadge', { pct: plan.annualDiscountPct })}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 bg-gray-800/60 border border-gray-800 rounded-lg">
              <button
                onClick={() => setBillingCycle('monthly')}
                className={`py-2 rounded-md text-sm font-medium transition-colors ${
                  billingCycle === 'monthly'
                    ? 'bg-gray-700 text-white shadow-inner'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {t('checkout.monthlyTab')}
              </button>
              <button
                onClick={() => annualUnlocked && setBillingCycle('annual')}
                disabled={!annualUnlocked}
                title={
                  annualUnlocked
                    ? undefined
                    : t('checkout.annualLockTooltip')
                }
                className={`relative py-2 rounded-md text-sm font-medium transition-colors ${
                  billingCycle === 'annual'
                    ? 'bg-gray-700 text-white shadow-inner'
                    : annualUnlocked
                    ? 'text-gray-400 hover:text-gray-200'
                    : 'text-gray-600 cursor-not-allowed'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  {!annualUnlocked && <Lock size={11} />}
                  {t('checkout.annualTab')}
                  {plan.annualDiscountPct > 0 && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      annualUnlocked
                        ? 'bg-green-900/60 text-green-300'
                        : 'bg-gray-700/60 text-gray-500'
                    }`}>
                      −{plan.annualDiscountPct}%
                    </span>
                  )}
                </span>
              </button>
            </div>

            {!annualUnlocked && (
              <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                {t('checkout.annualLockHelp')}
              </p>
            )}
          </div>

          {/* ── GSTIN / billing-address capture (1.3.1) ───────────────── */}
          {/* Collapsible. Auto-expanded if the customer already has details
              on file. Optional — B2C customers who skip this still get a
              valid (non-tax) invoice. State code is auto-filled from the
              first 2 digits of the GSTIN. */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setGstinExpanded(e => !e)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-gray-800/40 hover:bg-gray-800/70 transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <Receipt size={15} className="text-gray-400" />
                <span className="text-sm font-medium text-gray-200">
                  {gstin ? t('checkout.gstinSectionTitleOpen') : t('checkout.gstinSectionTitleClosed')}
                </span>
                {!gstin && (
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                    {t('checkout.gstinChipOptional')}
                  </span>
                )}
                {gstin && GSTIN_PATTERN.test(gstin) && (
                  <span className="text-[10px] uppercase tracking-wider text-green-400 font-semibold">
                    {t('checkout.gstinChipSaved')}
                  </span>
                )}
              </div>
              <ChevronDown
                size={16}
                className={`text-gray-400 transition-transform ${gstinExpanded ? 'rotate-180' : ''}`}
              />
            </button>

            {gstinExpanded && (
              <div className="p-4 space-y-3 bg-gray-900/40">
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
                    className={`w-full bg-gray-800 border rounded-lg px-3 py-2 text-sm font-mono tracking-wider text-white focus:outline-none focus:ring-2 ${
                      gstinError
                        ? 'border-red-700 focus:ring-red-500/40'
                        : 'border-gray-700 focus:ring-blue-500/40 focus:border-blue-500'
                    }`}
                  />
                  {gstinError && (
                    <p className="mt-1 text-[11px] text-red-400">{gstinError}</p>
                  )}
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

                {/* Billing email (Phase 3.7). Distinct from auth email — finance
                    teams typically want invoices to land at accounts@company.com
                    rather than the manager's personal address. NULL falls back
                    to the auth email server-side. */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    {t('checkout.billingEmailLabel')} <span className="text-gray-600">{t('checkout.billingEmailHint')}</span>
                  </label>
                  <input
                    type="email"
                    value={billingEmail}
                    onChange={e => {
                      setBillingEmail(e.target.value);
                      setEmailError(null);
                    }}
                    placeholder={t('checkout.billingEmailPlaceholder')}
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="email"
                    maxLength={320}
                    className={`w-full bg-gray-800 border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 ${
                      emailError
                        ? 'border-red-700 focus:ring-red-500/40'
                        : 'border-gray-700 focus:ring-blue-500/40 focus:border-blue-500'
                    }`}
                  />
                  {emailError && (
                    <p className="mt-1 text-[11px] text-red-400">{emailError}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Price summary ──────────────────────────────────────────── */}
          <div className="bg-gray-800/60 border border-gray-800 rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-sm text-gray-300">
              <span>
                {t('checkout.priceLine', {
                  count: vehicleCount,
                  price: (plan.pricePerVehicleInr ?? 0).toLocaleString('en-IN'),
                })}
              </span>
              <span className="font-semibold text-white">
                {monthlyTotal != null ? formatInr(monthlyTotal) : '—'}
                <span className="text-gray-400 text-xs font-normal"> {t('checkout.perMonthSuffix')}</span>
              </span>
            </div>

            {billingCycle === 'annual' && annualSavings != null && annualSavings > 0 && (
              <div className="flex items-center justify-between text-xs text-green-400">
                <span>{t('checkout.annualSavingsLine', { pct: plan.annualDiscountPct })}</span>
                <span className="font-semibold">− {formatInr(annualSavings)}</span>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-gray-800">
              <span className="text-sm font-semibold text-white">
                {billingCycle === 'annual' ? t('checkout.billedAnnually') : t('checkout.billedMonthly')}
              </span>
              <div className="text-right">
                <div className="text-lg font-bold text-white">
                  {billingCycle === 'annual'
                    ? (annualTotal  != null ? formatInr(annualTotal)  : '—')
                    : (monthlyTotal != null ? formatInr(monthlyTotal) : '—')}
                  <span className="text-gray-400 text-sm font-normal">
                    {' '}{billingCycle === 'annual' ? t('checkout.perYearSuffix') : t('checkout.perMonthSuffix')}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500">{t('checkout.gstFootnote')}</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Server error (e.g. Razorpay dormant / below-minimum) ──────── */}
        {submitError && (
          <div className="px-6 pb-4">
            <div className="flex gap-3 p-3 bg-red-950/40 border border-red-900/60 rounded-lg">
              <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
              <div className="text-xs text-red-200 leading-relaxed">{submitError}</div>
            </div>
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="p-6 pt-0 flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-5 py-2.5 text-sm text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          >
            {t('checkout.cancelButton')}
          </button>
          <button
            onClick={handleContinue}
            disabled={
              submitting ||
              (billingCycle === 'annual'
                ? annualTotal  == null
                : monthlyTotal == null)
            }
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-colors"
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t('checkout.continueButtonLoading')}
              </>
            ) : (
              <>
                {t('checkout.continueButton')}
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
