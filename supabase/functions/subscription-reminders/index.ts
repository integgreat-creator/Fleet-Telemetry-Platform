/**
 * subscription-reminders edge function
 *
 * Fired hourly by pg_cron (see migration 20260603000000). Picks fleets whose
 * trial / renewal date arithmetic puts them in a current reminder window,
 * sends WhatsApp (preferred) or email (fallback), and records the send in
 * `subscription_reminders` for idempotency.
 *
 * Reminder kinds and their windows:
 *   trial_t_minus_7    — trial_ends_at::date = (now + 7d)::date, status='trial'
 *   trial_t_minus_1    — trial_ends_at::date = (now + 1d)::date, status='trial'
 *   trial_expired      — trial_ends_at::date = now::date,        status='trial'
 *   renewal_t_minus_7  — current_period_end::date = (now + 7d)::date, status='active', annual
 *   renewal_t_minus_1  — current_period_end::date = (now + 1d)::date, status='active', annual
 *
 * `payment_suspended` fires from razorpay-webhook on payment.failed —
 * different code path (immediate, not cron-driven).
 *
 * Channel selection:
 *   - If fleets.whatsapp_number is set → WhatsApp via Meta Cloud API
 *   - Else, if RESEND_API_KEY is set + manager email available → email
 *   - Else log and skip (dormant mode, no channels configured yet)
 *
 * Auth: invoked via cron with the anon key. No user-facing surface.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WHATSAPP_ACCESS_TOKEN = Deno.env.get('WHATSAPP_ACCESS_TOKEN')      ?? '';
const PHONE_NUMBER_ID       = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')   ?? '';
const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')             ?? '';
const RESEND_FROM_EMAIL     = Deno.env.get('RESEND_FROM_EMAIL')          ?? 'noreply@vehiclesense.in';
const APP_URL               = Deno.env.get('APP_URL')                    ?? 'https://app.vehiclesense.in';

// ─── Types ───────────────────────────────────────────────────────────────────

type ReminderKind =
  | 'trial_t_minus_7'
  | 'trial_t_minus_1'
  | 'trial_expired'
  | 'renewal_t_minus_7'
  | 'renewal_t_minus_1';

interface FleetRow {
  id:               string;
  name:             string;
  whatsapp_number:  string | null;
  manager_id:       string;
}

interface SubscriptionRow {
  fleet_id:             string;
  status:               string;
  trial_ends_at:        string | null;
  current_period_end:   string | null;
  billing_cycle:        string | null;
  plan:                 string | null;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/// Returns YYYY-MM-DD in IST. The IST shift matters because the trial /
/// renewal cutoffs are anchored to the customer's local calendar day, not
/// UTC midnight (which would land at 5:30 AM IST and skew "tomorrow" by half
/// a day).
function istDateString(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

function daysFromNowIst(days: number): string {
  return istDateString(new Date(Date.now() + days * 86_400_000));
}

// ─── Channel: WhatsApp Cloud API ────────────────────────────────────────────

async function sendWhatsApp(opts: {
  toNumber: string;            // E.164 with leading +
  body:     string;
}): Promise<{ ok: boolean; externalId?: string; error?: string }> {
  if (!WHATSAPP_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    return { ok: false, error: 'whatsapp_not_configured' };
  }

  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:                opts.toNumber.replace(/^\+/, ''),     // Meta wants no plus
      type:              'text',
      text:              { body: opts.body },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `whatsapp_api_${res.status}: ${err.slice(0, 200)}` };
  }
  const body = await res.json();
  // wamid lives at messages[0].id in the Cloud API response
  const wamid = body?.messages?.[0]?.id as string | undefined;
  return { ok: true, externalId: wamid };
}

// ─── Channel: email via Resend ──────────────────────────────────────────────

async function sendEmail(opts: {
  toEmail: string;
  subject: string;
  htmlBody: string;
}): Promise<{ ok: boolean; externalId?: string; error?: string }> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'email_not_configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    RESEND_FROM_EMAIL,
      to:      [opts.toEmail],
      subject: opts.subject,
      html:    opts.htmlBody,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `resend_api_${res.status}: ${err.slice(0, 200)}` };
  }
  const body = await res.json();
  const id   = body?.id as string | undefined;
  return { ok: true, externalId: id };
}

// ─── Message bodies ─────────────────────────────────────────────────────────
// English-only at the function level. Localizing here would require
// fleets.preferred_language (out of scope for v1.7.1 — ties into Phase 1.5
// D14b which kept Tamil as English placeholders anyway). Operator can flip
// these to Tamil once the customer pool warrants it.

function copyForReminder(kind: ReminderKind, fleetName: string): { subject: string; body: string } {
  const upgradeUrl = `${APP_URL}/admin`;
  switch (kind) {
    case 'trial_t_minus_7':
      return {
        subject: `${fleetName}: 7 days left in your FTPGo free trial`,
        body:
          `Hi,\n\nYour FTPGo free trial for ${fleetName} ends in 7 days. ` +
          `Pick a plan now to keep your data, drivers, and alerts running ` +
          `without interruption.\n\nManage subscription: ${upgradeUrl}\n\n— Team FTPGo`,
      };
    case 'trial_t_minus_1':
      return {
        subject: `${fleetName}: trial ends tomorrow`,
        body:
          `Hi,\n\nReminder — your FTPGo free trial for ${fleetName} ends ` +
          `tomorrow. Activate a plan today to avoid losing access to your ` +
          `fleet dashboard.\n\nUpgrade now: ${upgradeUrl}\n\n— Team FTPGo`,
      };
    case 'trial_expired':
      return {
        subject: `${fleetName}: trial expired — features locked`,
        body:
          `Hi,\n\nYour FTPGo free trial for ${fleetName} has expired and ` +
          `features are now locked. Your data is preserved — pick a plan ` +
          `to restore access.\n\nUpgrade now: ${upgradeUrl}\n\n— Team FTPGo`,
      };
    case 'renewal_t_minus_7':
      return {
        subject: `${fleetName}: annual subscription renews in 7 days`,
        body:
          `Hi,\n\nYour FTPGo annual subscription for ${fleetName} renews in ` +
          `7 days. Take a moment to confirm your card on file is current.\n\n` +
          `Manage billing: ${upgradeUrl}\n\n— Team FTPGo`,
      };
    case 'renewal_t_minus_1':
      return {
        subject: `${fleetName}: annual subscription renews tomorrow`,
        body:
          `Hi,\n\nYour FTPGo annual subscription for ${fleetName} renews ` +
          `tomorrow. If your payment method needs updating, please do so ` +
          `today to avoid interruption.\n\nManage billing: ${upgradeUrl}\n\n— Team FTPGo`,
      };
  }
}

// Crude HTML escape for the Resend HTML body — we don't render user-typed
// content here, just plain prose, so this is belt-and-braces.
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bodyToHtml(plain: string): string {
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
         htmlEscape(plain).replace(/\n/g, '<br>') +
         `</div>`;
}

// ─── Send + record ──────────────────────────────────────────────────────────

/// Picks the right channel, sends, and records the result. Returns true if
/// the row landed (sent OR failed); false on idempotency conflict (someone
/// else already inserted this fleet/kind/cycle tuple).
async function sendAndRecord(
  supabase: SupabaseClient,
  opts: {
    fleet:        FleetRow;
    managerEmail: string | null;
    kind:         ReminderKind;
    cycleAnchor:  string;
  },
): Promise<boolean> {
  const copy = copyForReminder(opts.kind, opts.fleet.name);

  // Decide channel.
  const useWhatsApp = !!opts.fleet.whatsapp_number && !!WHATSAPP_ACCESS_TOKEN && !!PHONE_NUMBER_ID;
  const useEmail    = !useWhatsApp && !!opts.managerEmail && !!RESEND_API_KEY;

  if (!useWhatsApp && !useEmail) {
    console.warn('[reminder] no channel available', {
      fleet_id: opts.fleet.id, kind: opts.kind,
    });
    return false;
  }

  let result: { ok: boolean; externalId?: string; error?: string };
  let channel: 'whatsapp' | 'email';

  if (useWhatsApp) {
    channel = 'whatsapp';
    result  = await sendWhatsApp({
      toNumber: opts.fleet.whatsapp_number!,
      body:     copy.body,
    });
  } else {
    channel = 'email';
    result  = await sendEmail({
      toEmail:  opts.managerEmail!,
      subject:  copy.subject,
      htmlBody: bodyToHtml(copy.body),
    });
  }

  // Insert with ON CONFLICT DO NOTHING via upsert(ignoreDuplicates: true).
  // The unique constraint on (fleet_id, reminder_kind, cycle_anchor) is the
  // backstop against double-sends from overlapping cron firings.
  const { error: insErr, data: ins } = await supabase
    .from('subscription_reminders')
    .upsert({
      fleet_id:       opts.fleet.id,
      reminder_kind:  opts.kind,
      channel,
      status:         result.ok ? 'sent' : 'failed',
      cycle_anchor:   opts.cycleAnchor,
      external_id:    result.externalId ?? null,
      notes:          result.error ? { error: result.error } : {},
    }, {
      onConflict:       'fleet_id,reminder_kind,cycle_anchor',
      ignoreDuplicates: true,
    })
    .select('id');

  if (insErr) {
    console.error('[reminder] insert failed', insErr, opts);
    return false;
  }
  // ignoreDuplicates returns an empty array on conflict.
  const inserted = (ins?.length ?? 0) > 0;
  if (!inserted) {
    // Someone else already sent this. Fine — idempotency working.
    return false;
  }

  console.info('[reminder] sent', {
    fleet_id: opts.fleet.id, kind: opts.kind, channel, ok: result.ok,
  });
  return true;
}

// ─── Per-kind eligibility queries ───────────────────────────────────────────

/// Returns the list of fleets eligible for a given trial-reminder kind on
/// today's IST date. The day-precision filter keeps the cron robust against
/// hourly drift.
async function eligibleTrialFleets(
  supabase: SupabaseClient,
  targetDate: string,                          // YYYY-MM-DD in IST
): Promise<Array<{ fleet: FleetRow; subscription: SubscriptionRow }>> {
  // We can't join + range-filter in one query because the cycle_anchor
  // comes from the subscription side. So: fetch matching subscriptions,
  // then fetch the corresponding fleets, then zip.
  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('fleet_id, status, trial_ends_at, current_period_end, billing_cycle, plan')
    .eq('status', 'trial')
    .gte('trial_ends_at', `${targetDate}T00:00:00Z`)
    .lt('trial_ends_at',  `${targetDate}T23:59:59Z`);
  if (subErr) {
    console.error('[reminder] trial subs query failed', subErr);
    return [];
  }
  if (!subs?.length) return [];

  const fleetIds = subs.map(s => s.fleet_id);
  const { data: fleets, error: fleetErr } = await supabase
    .from('fleets')
    .select('id, name, whatsapp_number, manager_id')
    .in('id', fleetIds);
  if (fleetErr) {
    console.error('[reminder] fleets query failed', fleetErr);
    return [];
  }
  const fleetById = new Map((fleets ?? []).map(f => [f.id as string, f as FleetRow]));

  return subs
    .map(s => ({ fleet: fleetById.get(s.fleet_id), subscription: s as SubscriptionRow }))
    .filter((r): r is { fleet: FleetRow; subscription: SubscriptionRow } => !!r.fleet);
}

/// Returns the list of fleets eligible for a given annual-renewal-reminder
/// kind on today's IST date.
async function eligibleRenewalFleets(
  supabase: SupabaseClient,
  targetDate: string,
): Promise<Array<{ fleet: FleetRow; subscription: SubscriptionRow }>> {
  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('fleet_id, status, trial_ends_at, current_period_end, billing_cycle, plan')
    .eq('status', 'active')
    .eq('billing_cycle', 'annual')
    .gte('current_period_end', `${targetDate}T00:00:00Z`)
    .lt('current_period_end',  `${targetDate}T23:59:59Z`);
  if (subErr) {
    console.error('[reminder] renewal subs query failed', subErr);
    return [];
  }
  if (!subs?.length) return [];

  const fleetIds = subs.map(s => s.fleet_id);
  const { data: fleets, error: fleetErr } = await supabase
    .from('fleets')
    .select('id, name, whatsapp_number, manager_id')
    .in('id', fleetIds);
  if (fleetErr) {
    console.error('[reminder] fleets query failed', fleetErr);
    return [];
  }
  const fleetById = new Map((fleets ?? []).map(f => [f.id as string, f as FleetRow]));

  return subs
    .map(s => ({ fleet: fleetById.get(s.fleet_id), subscription: s as SubscriptionRow }))
    .filter((r): r is { fleet: FleetRow; subscription: SubscriptionRow } => !!r.fleet);
}

/// Bulk-fetch manager email addresses for a list of fleets. Service-role
/// client can read auth.users via the admin API.
async function fetchManagerEmails(
  supabase: SupabaseClient,
  managerIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (managerIds.length === 0) return out;

  // listUsers is paginated; for our scale (hundreds of fleets), the first
  // page covers everyone. If the customer count grows past 1k we'll batch.
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.error('[reminder] manager-email lookup failed', error);
    return out;
  }
  const idSet = new Set(managerIds);
  for (const u of (data?.users ?? [])) {
    if (idSet.has(u.id) && u.email) out.set(u.id, u.email);
  }
  return out;
}

// ─── Handler ────────────────────────────────────────────────────────────────

interface RunResult {
  kind:     ReminderKind;
  attempts: number;
  inserted: number;
}

async function runOneKind(
  supabase: SupabaseClient,
  kind:     ReminderKind,
  daysOut:  number | 'today',
): Promise<RunResult> {
  const targetDate = daysOut === 'today'
    ? istDateString(new Date())
    : daysFromNowIst(daysOut);

  const candidates = kind.startsWith('trial_')
    ? await eligibleTrialFleets(supabase, targetDate)
    : await eligibleRenewalFleets(supabase, targetDate);

  if (candidates.length === 0) {
    return { kind, attempts: 0, inserted: 0 };
  }

  // Manager emails are only needed for fleets without a whatsapp_number, but
  // bulk-fetching is cheaper than looping individual queries. Fetch once.
  const managerIds   = candidates.map(c => c.fleet.manager_id);
  const emailById    = await fetchManagerEmails(supabase, managerIds);

  let inserted = 0;
  for (const { fleet, subscription } of candidates) {
    const cycleAnchor = kind.startsWith('trial_')
      ? subscription.trial_ends_at
      : subscription.current_period_end;
    if (!cycleAnchor) continue;

    const ok = await sendAndRecord(supabase, {
      fleet,
      managerEmail: emailById.get(fleet.manager_id) ?? null,
      kind,
      cycleAnchor,
    });
    if (ok) inserted += 1;
  }

  return { kind, attempts: candidates.length, inserted };
}

Deno.serve(async (req: Request) => {
  // No auth check beyond the bearer the cron sends — Supabase's edge
  // function runtime validates the Bearer against the project's anon key
  // before the handler runs. POST-only to discourage accidental browser hits.
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Run all five reminder kinds. Sequential, not parallel — total work is
  // small (a handful of fleets per kind) and serial keeps the logs readable.
  const results: RunResult[] = [];
  results.push(await runOneKind(supabase, 'trial_t_minus_7',   7));
  results.push(await runOneKind(supabase, 'trial_t_minus_1',   1));
  results.push(await runOneKind(supabase, 'trial_expired',     'today'));
  results.push(await runOneKind(supabase, 'renewal_t_minus_7', 7));
  results.push(await runOneKind(supabase, 'renewal_t_minus_1', 1));

  return new Response(
    JSON.stringify({
      ok:                true,
      whatsapp_configured: !!WHATSAPP_ACCESS_TOKEN && !!PHONE_NUMBER_ID,
      email_configured:    !!RESEND_API_KEY,
      results,
    }),
    {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
});
