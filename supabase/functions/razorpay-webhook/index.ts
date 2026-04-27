import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { createHmac } from 'node:crypto';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-razorpay-signature',
};

// ─── Cashback (Phase 1.6.1) ──────────────────────────────────────────────────
// First-paid-charge bonus: customer gets 10% of the charge back, capped at
// ₹500, applied as a partial refund on their NEXT charge. The cap matters —
// without it a 10-vehicle Business plan would bank ₹3,000 the first month,
// which is too generous for the conversion-incentive math we're targeting.
const CASHBACK_RATE_PCT       = 10;
const CASHBACK_MAX_INR        = 500;
const CASHBACK_EXPIRY_DAYS    = 90;
const CASHBACK_REASON         = 'first_charge_cashback';

// ─── GST invoice helpers (Phase 1.3.2) ──────────────────────────────────────
// Single GST rate for B2B SaaS (HSN/SAC 998314). Split into 9% CGST + 9% SGST
// for intra-state, or 18% IGST for inter-state. If you ever support multiple
// SAC codes with different rates, this becomes a per-line lookup.
const GST_RATE_PCT = 18;

interface SupplierConfig {
  name:        string;
  gstin:       string | null;          // null ⇒ dormant mode
  address:     string;
  stateCode:   string;
}

/// Reads the supplier (us) identity from env. Returns null gstin during the
/// dormant period before GST registration — invoices still get issued, just
/// without a tax breakdown.
function loadSupplierConfig(): SupplierConfig {
  return {
    name:      Deno.env.get('SUPPLIER_NAME')       ?? 'VehicleSense',
    gstin:     Deno.env.get('SUPPLIER_GSTIN')      ?? null,
    address:   Deno.env.get('SUPPLIER_ADDRESS')    ?? 'Address pending GST registration',
    stateCode: Deno.env.get('SUPPLIER_STATE_CODE') ?? '00',
  };
}

/// Indian FY label for an instant. Apr 1 (IST) is the boundary.
/// Apr 2026 ⇒ '2026-27'; Mar 2027 ⇒ '2026-27'; Apr 2027 ⇒ '2027-28'.
function indianFyLabel(d: Date = new Date()): string {
  // Shift to IST (UTC+5:30) so the FY boundary aligns with the legal cutoff,
  // not the host VM's locale.
  const ist        = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
  const year       = ist.getUTCFullYear();
  const month      = ist.getUTCMonth() + 1;
  const startYear  = month >= 4 ? year : year - 1;
  const endYearTwo = ((startYear + 1) % 100).toString().padStart(2, '0');
  return `${startYear}-${endYearTwo}`;
}

/// Splits a tax-inclusive amount (in paise) into taxable + tax components.
/// Razorpay charges the customer a gross amount; the invoice has to back out
/// the GST portion so the customer can claim Input Tax Credit on it.
///
/// In dormant mode (no supplier GSTIN) every charge is recorded with no tax
/// components — taxable_amount = total = grossAmount.
function computeTaxBreakdown(opts: {
  grossPaise:        number;
  supplierGstin:     string | null;
  supplierStateCode: string;
  customerStateCode: string | null;
}) {
  const grossInr = opts.grossPaise / 100;

  if (!opts.supplierGstin) {
    // Dormant — record the charge but issue no GST components.
    return {
      taxableInr:    grossInr,
      cgstPct:       0, cgstInr: 0,
      sgstPct:       0, sgstInr: 0,
      igstPct:       0, igstInr: 0,
      totalInr:      grossInr,
      dormant:       true,
    };
  }

  // Live tax computation. Taxable base = gross / (1 + rate).
  const rate          = GST_RATE_PCT / 100;
  const taxableInrRaw = grossInr / (1 + rate);
  // Round taxable to 2dp then derive tax so penny errors don't accumulate.
  const taxableInr    = Math.round(taxableInrRaw * 100) / 100;
  const totalTaxInr   = Math.round((grossInr - taxableInr) * 100) / 100;

  const intraState = !!opts.customerStateCode &&
                     opts.customerStateCode === opts.supplierStateCode;

  if (intraState) {
    const halfTaxInr = Math.round((totalTaxInr / 2) * 100) / 100;
    // Compensate for the rounding split — the second half absorbs the cent.
    const otherHalfInr = Math.round((totalTaxInr - halfTaxInr) * 100) / 100;
    return {
      taxableInr,
      cgstPct: GST_RATE_PCT / 2, cgstInr: halfTaxInr,
      sgstPct: GST_RATE_PCT / 2, sgstInr: otherHalfInr,
      igstPct: 0,                igstInr: 0,
      totalInr: grossInr,
      dormant:  false,
    };
  }

  return {
    taxableInr,
    cgstPct: 0,            cgstInr: 0,
    sgstPct: 0,            sgstInr: 0,
    igstPct: GST_RATE_PCT, igstInr: totalTaxInr,
    totalInr: grossInr,
    dormant: false,
  };
}

/// Issues a GST tax invoice for a captured Razorpay payment. Idempotent —
/// the unique index on `invoices.razorpay_payment_id` makes ON CONFLICT a
/// no-op for redelivered webhooks. Best-effort: any failure is logged but
/// does NOT roll back the subscription update — we'd rather have an active
/// subscription with a missing invoice than a paid customer with no service.
async function issueInvoiceForCharge(
  supabase: SupabaseClient,
  opts: {
    fleetId:        string;
    subscriptionId: string;                    // Razorpay subscription id (string)
    paymentEntity:  Record<string, unknown>;
    plan:           string;
    billingCycle:   string;
    vehicleCount:   number | null;
    pricePerVeh:    number | null;
  },
): Promise<void> {
  const grossPaise = Number(opts.paymentEntity.amount);
  const paymentId  = opts.paymentEntity.id as string | undefined;
  if (!Number.isFinite(grossPaise) || grossPaise <= 0 || !paymentId) {
    console.warn('[invoice] skipped — missing payment amount or id', opts.paymentEntity);
    return;
  }

  // Customer snapshot — captured at issue time so a later edit on `fleets`
  // doesn't retroactively rewrite the invoice.
  const { data: customer, error: custErr } = await supabase
    .from('fleets')
    .select('name, gstin, billing_address, state_code')
    .eq('id', opts.fleetId)
    .maybeSingle();
  if (custErr || !customer) {
    console.warn('[invoice] skipped — customer fleet not found', opts.fleetId, custErr);
    return;
  }

  const supplier = loadSupplierConfig();
  const tax = computeTaxBreakdown({
    grossPaise,
    supplierGstin:     supplier.gstin,
    supplierStateCode: supplier.stateCode,
    customerStateCode: customer.state_code,
  });

  // Sequential invoice number, allocated atomically by the DB function.
  const fyLabel = indianFyLabel();
  const { data: invNum, error: numErr } = await supabase
    .rpc('next_invoice_number', { p_fy_label: fyLabel });
  if (numErr || !invNum) {
    console.error('[invoice] next_invoice_number failed', numErr);
    return;
  }

  // Description copy printed verbatim on the invoice. Falls back gracefully
  // if any field is missing — ops still gets a usable invoice for a manual
  // rebuild later.
  const cycleLabel    = opts.billingCycle === 'annual' ? 'annual' : 'monthly';
  const vehiclesLabel = opts.vehicleCount != null
    ? `${opts.vehicleCount} vehicle${opts.vehicleCount === 1 ? '' : 's'}`
    : 'fleet';
  const description   =
    `${opts.plan.charAt(0).toUpperCase() + opts.plan.slice(1)} plan — ` +
    `${vehiclesLabel}, ${cycleLabel} billing`;

  const insertRow = {
    invoice_number:           invNum as string,
    fleet_id:                 opts.fleetId,

    customer_name:            customer.name,
    customer_gstin:           customer.gstin           ?? null,
    customer_address:         customer.billing_address ?? null,
    customer_state_code:      customer.state_code      ?? null,

    supplier_name:            supplier.name,
    supplier_gstin:           supplier.gstin,
    supplier_address:         supplier.address,
    supplier_state_code:      supplier.stateCode,

    description,
    hsn_sac:                  '998314',
    quantity:                 opts.vehicleCount ?? 1,
    unit_price_inr:           opts.pricePerVeh ?? (tax.taxableInr / Math.max(1, opts.vehicleCount ?? 1)),
    taxable_amount_inr:       tax.taxableInr,

    cgst_pct:                 tax.cgstPct,
    cgst_amount_inr:          tax.cgstInr,
    sgst_pct:                 tax.sgstPct,
    sgst_amount_inr:          tax.sgstInr,
    igst_pct:                 tax.igstPct,
    igst_amount_inr:          tax.igstInr,
    total_inr:                tax.totalInr,

    razorpay_payment_id:      paymentId,
    razorpay_subscription_id: opts.subscriptionId,

    is_dormant_supplier:      tax.dormant,
    status:                   'issued',
  };

  // ON CONFLICT DO NOTHING via upsert with `ignoreDuplicates`. The unique
  // partial index on razorpay_payment_id is what gives us the idempotency
  // guarantee — a Razorpay redelivery silently no-ops.
  const { error: insErr } = await supabase
    .from('invoices')
    .upsert(insertRow, {
      onConflict:       'razorpay_payment_id',
      ignoreDuplicates: true,
    });
  if (insErr) {
    console.error('[invoice] insert failed', insErr, { paymentId, invNum });
    return;
  }
  console.info('[invoice] issued', { invoice_number: invNum, payment_id: paymentId, dormant: tax.dormant });
}

// ─── Cashback ledger (Phase 1.6.1) ──────────────────────────────────────────

interface CreditRow {
  id:            string;
  amount_inr:    number;
  expires_at:    string;
}

/// Razorpay partial-refund call. Used to redeem cashback credits against a
/// successful charge. Returns the refund_id on success or throws.
///
/// Razorpay's refund endpoint accepts an `amount` in paise; if omitted, it
/// refunds the full charge. We always pass an amount because we're issuing
/// partial refunds, never full ones.
async function razorpayPartialRefund(opts: {
  paymentId:  string;
  amountInr:  number;
  notes:      Record<string, string>;
}): Promise<string> {
  const keyId     = Deno.env.get('RAZORPAY_KEY_ID');
  const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials not configured — refund skipped');
  }
  const auth = btoa(`${keyId}:${keySecret}`);
  const res  = await fetch(
    `https://api.razorpay.com/v1/payments/${encodeURIComponent(opts.paymentId)}/refund`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        amount: Math.round(opts.amountInr * 100),    // paise
        notes:  opts.notes,
      }),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Razorpay refund failed (${res.status}): ${errBody}`);
  }
  const body = await res.json();
  return body.id as string;
}

/// First-charge cashback grant. Idempotent — the unique partial index on
/// `fleet_credits(fleet_id) WHERE reason='first_charge_cashback'` makes a
/// duplicate INSERT a no-op via ON CONFLICT DO NOTHING. Best-effort: any
/// failure is logged but doesn't roll back the subscription update.
async function maybeGrantFirstChargeCashback(
  supabase: SupabaseClient,
  opts: {
    fleetId:    string;
    paymentId:  string;
    amountInr:  number;
  },
): Promise<void> {
  const cashbackInr = Math.min(
    Math.round((opts.amountInr * CASHBACK_RATE_PCT) / 100 * 100) / 100,
    CASHBACK_MAX_INR,
  );
  if (cashbackInr <= 0) return;

  const expiresAt = new Date(Date.now() + CASHBACK_EXPIRY_DAYS * 86_400_000).toISOString();
  const { error } = await supabase
    .from('fleet_credits')
    .insert({
      fleet_id:           opts.fleetId,
      amount_inr:         cashbackInr,
      reason:             CASHBACK_REASON,
      expires_at:         expiresAt,
      source_payment_id:  opts.paymentId,
      notes: {
        rate_pct: CASHBACK_RATE_PCT,
        cap_inr:  CASHBACK_MAX_INR,
      },
    });

  // 23505 = unique_violation. Means the cashback was already granted for
  // this fleet (e.g. webhook redelivery hit a different ordering window).
  // That's the desired no-op.
  if (error && error.code !== '23505') {
    console.error('[cashback] grant failed', error, opts);
    return;
  }
  if (!error) {
    console.info('[cashback] granted', {
      fleet_id:    opts.fleetId,
      amount_inr:  cashbackInr,
      expires_at:  expiresAt,
    });
  }
}

/// Walks unredeemed, unexpired credits for a fleet and applies them as
/// partial refunds against the just-captured payment. Stops at the charge
/// amount — we never refund more than the customer paid this cycle.
///
/// IMPORTANT: callers must NOT invoke this for the SAME charge that
/// triggered a cashback grant. The grant happens on the first paid charge;
/// redemption only fires on subsequent charges. Otherwise the customer
/// would effectively pay nothing on month 1.
async function maybeRedeemCredits(
  supabase: SupabaseClient,
  opts: {
    fleetId:        string;
    paymentId:      string;
    chargeAmountInr: number;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: credits, error: selErr } = await supabase
    .from('fleet_credits')
    .select('id, amount_inr, expires_at')
    .eq('fleet_id', opts.fleetId)
    .is('redeemed_at', null)
    .gte('expires_at', nowIso)
    .order('granted_at', { ascending: true });

  if (selErr) {
    console.error('[cashback] select failed', selErr, opts);
    return;
  }
  if (!credits || credits.length === 0) return;

  let remainingChargeInr = opts.chargeAmountInr;

  for (const credit of credits as CreditRow[]) {
    if (remainingChargeInr <= 0) break;

    const refundInr = Math.min(Number(credit.amount_inr), remainingChargeInr);
    if (refundInr <= 0) continue;

    let refundId: string;
    try {
      refundId = await razorpayPartialRefund({
        paymentId:  opts.paymentId,
        amountInr:  refundInr,
        notes: {
          fleet_id:   opts.fleetId,
          credit_id:  credit.id,
          source:     'fleet_credit_redemption',
        },
      });
    } catch (e) {
      // Refund call failed — credit stays unredeemed for the next cycle.
      // Don't mark it consumed; we'd lose track of an obligation we
      // haven't fulfilled.
      console.error('[cashback] refund failed', e, { credit_id: credit.id });
      continue;
    }

    const { error: updErr } = await supabase
      .from('fleet_credits')
      .update({
        redeemed_at:           new Date().toISOString(),
        redemption_payment_id: opts.paymentId,
        redemption_refund_id:  refundId,
      })
      .eq('id', credit.id)
      .is('redeemed_at', null);              // CAS guard against double-redeem under webhook redelivery

    if (updErr) {
      console.error('[cashback] mark-redeemed failed', updErr, { credit_id: credit.id, refundId });
      // Refund already happened; the audit log row below is the recovery hook.
    }

    remainingChargeInr -= refundInr;
    console.info('[cashback] redeemed', {
      fleet_id:    opts.fleetId,
      credit_id:   credit.id,
      refund_id:   refundId,
      amount_inr:  refundInr,
    });

    await supabase.from('audit_logs').insert({
      fleet_id:      opts.fleetId,
      action:        'cashback.redeemed',
      resource_type: 'fleet_credit',
      resource_id:   credit.id,
      new_values: {
        amount_inr:           refundInr,
        razorpay_payment_id:  opts.paymentId,
        razorpay_refund_id:   refundId,
      },
    });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
  const signature = req.headers.get('x-razorpay-signature') ?? '';
  const rawBody = await req.text();

  // Verify Razorpay signature
  if (webhookSecret) {
    const expectedSig = createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (expectedSig !== signature) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const eventType: string = event.event ?? '';
  const payload = event.payload ?? {};

  try {
    switch (eventType) {
      case 'subscription.activated':
      case 'subscription.charged': {
        const sub = payload.subscription?.entity ?? {};
        const fleetId = sub.notes?.fleet_id;
        if (!fleetId) break;

        // Plan name comes through Razorpay subscription notes — we do NOT parse
        // it out of plan_id because IDs are opaque and differ between test/live.
        // The checkout flow sets these notes when creating the subscription.
        const notes = sub.notes ?? {};
        const planFromNotes: string | undefined = notes.plan;
        const validPlans = new Set([
          'essential', 'professional', 'business', 'enterprise',
        ]);
        const plan = planFromNotes && validPlans.has(planFromNotes)
          ? planFromNotes
          : 'essential';

        // Per-vehicle billing fields (also passed through notes)
        const billingModel    = (notes.billing_model as string) ?? 'per_vehicle';
        const billingCycle    = (notes.billing_cycle as string) ?? 'monthly';
        const vehicleCount    = notes.vehicle_count
          ? Number(notes.vehicle_count)
          : null;
        const pricePerVehicle = notes.price_per_vehicle_inr
          ? Number(notes.price_per_vehicle_inr)
          : null;

        // driver_limit comes from plan_definitions so the two stay in sync.
        const { data: planDef } = await supabase
          .from('plan_definitions')
          .select('driver_limit')
          .eq('plan_name', plan)
          .maybeSingle();
        const maxDrivers = (planDef?.driver_limit as number | undefined) ?? null;

        const upsertRow: Record<string, unknown> = {
          fleet_id:                 fleetId,
          plan,
          status:                   'active',
          billing_model:            billingModel,
          billing_cycle:            billingCycle,
          razorpay_subscription_id: sub.id,
          current_period_start:     sub.current_start ? new Date(sub.current_start * 1000).toISOString() : null,
          current_period_end:       sub.current_end   ? new Date(sub.current_end   * 1000).toISOString() : null,
          updated_at:               new Date().toISOString(),
        };
        if (vehicleCount    !== null) upsertRow.vehicle_count         = vehicleCount;
        if (pricePerVehicle !== null) upsertRow.price_per_vehicle_inr = pricePerVehicle;
        if (maxDrivers      !== null) upsertRow.max_drivers           = maxDrivers;

        // Razorpay-hosted subscription page (Phase 1.6.3). Used by the renewal
        // reminder banner CTA to deep-link the customer to card-management.
        // Razorpay populates this on subscription create; we only WRITE if
        // present so a missing field on a redelivered event doesn't blank a
        // previously-stored URL.
        if (typeof sub.short_url === 'string' && sub.short_url) {
          upsertRow.razorpay_subscription_short_url = sub.short_url;
        }

        // Unlock annual billing once customer completes 3 months on monthly.
        // Only SET the timestamp on charge events — never clear it.
        if (eventType === 'subscription.charged') {
          const { data: existing } = await supabase
            .from('subscriptions')
            .select('created_at, annual_unlocked_at')
            .eq('fleet_id', fleetId)
            .maybeSingle();
          if (existing?.created_at && !existing.annual_unlocked_at) {
            const createdAt = new Date(existing.created_at as string);
            const threeMonthsAgo = new Date();
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
            if (createdAt <= threeMonthsAgo) {
              upsertRow.annual_unlocked_at = new Date().toISOString();
            }
          }
        }

        await supabase.from('subscriptions').upsert(upsertRow, { onConflict: 'fleet_id' });

        await supabase.from('audit_logs').insert({
          fleet_id:      fleetId,
          action:        `subscription.${eventType.split('.')[1]}`,
          resource_type: 'subscription',
          new_values:    {
            plan,
            status:        'active',
            billing_model: billingModel,
            billing_cycle: billingCycle,
            vehicle_count: vehicleCount,
            razorpay_subscription_id: sub.id,
          },
        });

        // ── Issue a GST tax invoice (Phase 1.3.2) + cashback (Phase 1.6.1) ─
        // Only on subscription.charged: subscription.activated fires before
        // the first charge is captured (it covers free trials and pending
        // payments), so there's no payment to invoice yet. The webhook will
        // get a separate subscription.charged event once the payment lands.
        if (eventType === 'subscription.charged') {
          const paymentEntity = payload.payment?.entity as Record<string, unknown> | undefined;
          if (paymentEntity) {
            await issueInvoiceForCharge(supabase, {
              fleetId,
              subscriptionId: sub.id,
              paymentEntity,
              plan,
              billingCycle,
              vehicleCount,
              pricePerVeh:    pricePerVehicle,
            });

            // Cashback: redeem any unredeemed/unexpired credits FIRST
            // (these were granted on prior charges), then grant the
            // first-charge cashback. The order matters — without it, a
            // first charge would both grant a credit AND immediately
            // redeem it on the same payment, netting the customer to
            // zero on month 1.
            const paymentId       = paymentEntity.id     as string | undefined;
            const chargeAmountInr = Number(paymentEntity.amount) / 100;
            if (paymentId && Number.isFinite(chargeAmountInr) && chargeAmountInr > 0) {
              await maybeRedeemCredits(supabase, {
                fleetId,
                paymentId,
                chargeAmountInr,
              });
              await maybeGrantFirstChargeCashback(supabase, {
                fleetId,
                paymentId,
                amountInr: chargeAmountInr,
              });
            }
          } else {
            console.warn('[invoice] subscription.charged with no payment entity', sub.id);
          }
        }
        break;
      }
      case 'subscription.cancelled':
      case 'subscription.expired': {
        const sub = payload.subscription?.entity ?? {};
        const fleetId = sub.notes?.fleet_id;
        if (!fleetId) break;
        await supabase.from('subscriptions')
          .update({ status: 'inactive', updated_at: new Date().toISOString() })
          .eq('fleet_id', fleetId);
        await supabase.from('audit_logs').insert({
          fleet_id: fleetId,
          action: eventType,
          resource_type: 'subscription',
          new_values: { status: 'inactive' },
        });
        break;
      }
      case 'payment.failed': {
        const payment = payload.payment?.entity ?? {};
        const fleetId = payment.notes?.fleet_id;
        if (!fleetId) break;
        await supabase.from('subscriptions')
          .update({ status: 'suspended', updated_at: new Date().toISOString() })
          .eq('fleet_id', fleetId);
        break;
      }
      default:
        // Unknown event — log and ignore
        console.log(`Unhandled Razorpay event: ${eventType}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('Webhook error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
