/**
 * invoice-api edge function
 *
 * Read-only access to a fleet's GST tax invoices. JWT-authed; the caller's
 * fleet is resolved via `fleets.manager_id` and used as the only filter —
 * RLS on `invoices` already enforces the same constraint, but doing it here
 * gives clearer errors (403 vs empty result) for misconfigured callers.
 *
 * Routes:
 *   GET ?action=list                   → list invoices (newest first, capped at 200)
 *   GET ?action=get&id=<uuid>          → fetch a single invoice by id
 *
 * Both routes return the full invoice row including denormalized customer +
 * supplier snapshots — the print-friendly /invoices/:id page renders directly
 * off the response without further lookups.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX     = 200;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'GET')     return err('Method not allowed', 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return err('Missing Authorization header', 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return err('Unauthorized', 401);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Resolve caller's fleet ────────────────────────────────────────────────
  const { data: fleet, error: fleetErr } = await adminClient
    .from('fleets')
    .select('id')
    .eq('manager_id', user.id)
    .single();
  if (fleetErr || !fleet) return err('No fleet found for this account', 403);

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') ?? '';

  // ── GET ?action=list ──────────────────────────────────────────────────────
  if (action === 'list') {
    const requested = parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit     = Number.isFinite(requested)
      ? Math.min(LIST_LIMIT_MAX, Math.max(1, requested))
      : LIST_LIMIT_DEFAULT;

    const { data, error: listErr } = await adminClient
      .from('invoices')
      .select(`
        id, invoice_number, invoice_date, status, is_dormant_supplier,
        description, total_inr, taxable_amount_inr,
        cgst_amount_inr, sgst_amount_inr, igst_amount_inr,
        razorpay_payment_id, razorpay_subscription_id
      `)
      .eq('fleet_id', fleet.id)
      .order('invoice_date', { ascending: false })
      .limit(limit);
    if (listErr) return err(listErr.message, 500);
    return json(data ?? []);
  }

  // ── GET ?action=get&id=<uuid> ─────────────────────────────────────────────
  if (action === 'get') {
    const id = url.searchParams.get('id') ?? '';
    if (!id) return err('id is required', 400);

    const { data, error: getErr } = await adminClient
      .from('invoices')
      .select('*')
      .eq('id', id)
      .eq('fleet_id', fleet.id)              // belt-and-braces — RLS would also block this
      .maybeSingle();
    if (getErr) return err(getErr.message, 500);
    if (!data)  return err('Invoice not found', 404);
    return json(data);
  }

  return err(`Unknown action: ${action}`, 400);
});
