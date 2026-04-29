/**
 * admin-api edge function
 *
 * Fleet-admin operations: subscription, audit logs, device health, trial extension,
 * subscription override (service-role only), and manual audit log entries.
 *
 * All routes require a valid user Bearer token.
 * Subscription override additionally requires:
 *   X-Admin-Override: true
 *   X-Admin-Secret: <ADMIN_SECRET env var>
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY          = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET      = Deno.env.get('ADMIN_SECRET') ?? '';
const ALLOWED_ORIGIN    = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-admin-override, x-admin-secret',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  // ── Auth verification ────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return err('Missing Authorization header', 401);

  // Verify caller using the anon client (honours RLS, confirms JWT)
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return err('Unauthorized', 401);

  // Service-role client for all DB operations (bypasses RLS safely server-side)
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Verify caller is a fleet manager ─────────────────────────────────────────
  const { data: fleet, error: fleetErr } = await adminClient
    .from('fleets')
    .select('id, name')
    .eq('manager_id', user.id)
    .single();

  if (fleetErr || !fleet) return err('No fleet found for this account', 403);

  const url = new URL(req.url);

  // ════════════════════════════════════════════════════════════════════════════
  // GET routes
  // ════════════════════════════════════════════════════════════════════════════

  if (req.method === 'GET') {
    const action = url.searchParams.get('action') ?? '';

    // ── GET ?action=subscription ─────────────────────────────────────────────
    if (action === 'subscription') {
      const [subRes, vehicleCountRes, driverCountRes] = await Promise.all([
        adminClient
          .from('subscriptions')
          .select('*')
          .eq('fleet_id', fleet.id)
          .single(),
        adminClient
          .from('vehicles')
          .select('id', { count: 'exact', head: true })
          .eq('fleet_id', fleet.id),
        adminClient
          .from('driver_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('fleet_id', fleet.id),
      ]);

      if (subRes.error && subRes.error.code !== 'PGRST116') {
        return err(subRes.error.message, 500);
      }

      return json({
        subscription: subRes.data ?? null,
        vehicle_count: vehicleCountRes.count ?? 0,
        driver_count: driverCountRes.count ?? 0,
      });
    }

    // ── GET ?action=audit-logs&limit=N ───────────────────────────────────────
    if (action === 'audit-logs') {
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10)));
      const resourceType = url.searchParams.get('resource_type') ?? '';

      let query = adminClient
        .from('audit_logs')
        .select('*')
        .eq('fleet_id', fleet.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (resourceType) query = query.eq('resource_type', resourceType);

      const { data, error: logsErr } = await query;
      if (logsErr) return err(logsErr.message, 500);
      return json(data ?? []);
    }

    // ── GET ?action=device-health ────────────────────────────────────────────
    if (action === 'device-health') {
      // Fetch vehicle IDs for this fleet first
      const { data: vehicles, error: vErr } = await adminClient
        .from('vehicles')
        .select('id')
        .eq('fleet_id', fleet.id);

      if (vErr) return err(vErr.message, 500);

      const vehicleIds = (vehicles ?? []).map((v: { id: string }) => v.id);

      if (vehicleIds.length === 0) return json([]);

      const { data, error: dhErr } = await adminClient
        .from('device_health')
        .select('*, vehicles(id, name, vin, make, model, is_active)')
        .in('vehicle_id', vehicleIds)
        .order('last_ping_at', { ascending: false });

      if (dhErr) return err(dhErr.message, 500);
      return json(data ?? []);
    }

    // ── GET ?action=billing-details ──────────────────────────────────────────
    // Returns the customer's billing identity (used to pre-fill the GSTIN
    // form in PlanCheckoutModal and to render the customer block on past
    // invoices). All fields nullable — B2C customers without a GSTIN are
    // first-class citizens here.
    if (action === 'billing-details') {
      const { data, error: bdErr } = await adminClient
        .from('fleets')
        .select('name, gstin, billing_address, state_code')
        .eq('id', fleet.id)
        .single();
      if (bdErr) return err(bdErr.message, 500);
      return json({
        name:             data.name,
        gstin:            data.gstin            ?? null,
        billing_address:  data.billing_address  ?? null,
        state_code:       data.state_code       ?? null,
      });
    }

    return err(`Unknown GET action: ${action}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // POST routes
  // ════════════════════════════════════════════════════════════════════════════

  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return err('Invalid JSON body');
    }

    const action = (body.action as string) ?? '';

    // ── POST { action: 'extend-trial', days: number } ────────────────────────
    if (action === 'extend-trial') {
      const days = Number(body.days);
      if (!days || days < 1 || days > 365) return err('days must be between 1 and 365');

      // Fetch current subscription
      const { data: sub, error: subErr } = await adminClient
        .from('subscriptions')
        .select('id, trial_ends_at, status')
        .eq('fleet_id', fleet.id)
        .single();

      if (subErr || !sub) return err('Subscription not found for this fleet', 404);

      // Only extend trial for trial or inactive subscriptions
      if (sub.status !== 'trial' && sub.status !== 'inactive') {
        return err(`Cannot extend trial: subscription is currently "${sub.status}"`);
      }

      const base = sub.trial_ends_at ? new Date(sub.trial_ends_at) : new Date();
      // If base is in the past, extend from now instead
      const effectiveBase = base < new Date() ? new Date() : base;
      effectiveBase.setDate(effectiveBase.getDate() + days);
      const newTrialEndsAt = effectiveBase.toISOString();

      const { error: updateErr } = await adminClient
        .from('subscriptions')
        .update({ trial_ends_at: newTrialEndsAt, status: 'trial', updated_at: new Date().toISOString() })
        .eq('fleet_id', fleet.id);

      if (updateErr) return err(updateErr.message, 500);

      // Audit
      await adminClient.from('audit_logs').insert({
        fleet_id: fleet.id,
        user_id: user.id,
        action: 'extend-trial',
        resource_type: 'subscription',
        resource_id: sub.id,
        old_values: { trial_ends_at: sub.trial_ends_at },
        new_values: { trial_ends_at: newTrialEndsAt, days_extended: days },
      });

      return json({ success: true, trial_ends_at: newTrialEndsAt });
    }

    // ── POST { action: 'update-subscription', plan, max_vehicles, max_drivers }
    // Requires: X-Admin-Override: true AND X-Admin-Secret matching ADMIN_SECRET
    if (action === 'update-subscription') {
      const overrideHeader = req.headers.get('X-Admin-Override');
      const secretHeader   = req.headers.get('X-Admin-Secret');

      if (overrideHeader !== 'true') {
        return err('X-Admin-Override header required', 403);
      }
      if (!ADMIN_SECRET || secretHeader !== ADMIN_SECRET) {
        return err('Invalid or missing X-Admin-Secret', 403);
      }

      const plan        = body.plan as string | undefined;
      const maxVehicles = body.max_vehicles != null ? Number(body.max_vehicles) : undefined;
      const maxDrivers  = body.max_drivers  != null ? Number(body.max_drivers)  : undefined;

      // Active plans (per-vehicle billing) + trial + legacy names. Legacy kept
      // so admin can still reassign historical rows if needed.
      const validPlans = [
        'trial',
        'essential', 'professional', 'business', 'enterprise',
        'free', 'starter', 'growth', 'pro',  // legacy
      ];
      if (plan && !validPlans.includes(plan)) {
        return err(`Invalid plan. Must be one of: ${validPlans.join(', ')}`);
      }
      if (maxVehicles !== undefined && (isNaN(maxVehicles) || maxVehicles < 1)) {
        return err('max_vehicles must be a positive integer');
      }
      if (maxDrivers !== undefined && (isNaN(maxDrivers) || maxDrivers < 1)) {
        return err('max_drivers must be a positive integer');
      }

      // Fetch old values for audit
      const { data: oldSub } = await adminClient
        .from('subscriptions')
        .select('id, plan, max_vehicles, max_drivers, status')
        .eq('fleet_id', fleet.id)
        .single();

      const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (plan !== undefined)        updatePayload.plan         = plan;
      if (maxVehicles !== undefined) updatePayload.max_vehicles = maxVehicles;
      if (maxDrivers !== undefined)  updatePayload.max_drivers  = maxDrivers;

      const { error: updateErr } = await adminClient
        .from('subscriptions')
        .update(updatePayload)
        .eq('fleet_id', fleet.id);

      if (updateErr) return err(updateErr.message, 500);

      // Audit
      await adminClient.from('audit_logs').insert({
        fleet_id: fleet.id,
        user_id: user.id,
        action: 'admin-override.update-subscription',
        resource_type: 'subscription',
        resource_id: oldSub?.id ?? null,
        old_values: oldSub
          ? { plan: oldSub.plan, max_vehicles: oldSub.max_vehicles, max_drivers: oldSub.max_drivers }
          : null,
        new_values: updatePayload,
      });

      return json({ success: true, updated: updatePayload });
    }

    // ── POST { action: 'update-billing-details', gstin?, billing_address?, state_code? }
    // Persists the customer's GST identity to `fleets`. Used by:
    //   - PlanCheckoutModal "Add GSTIN for tax invoice" before launching Razorpay
    //   - the Subscription tab's billing-details edit form (future)
    //
    // All three fields are optional. To clear a field, pass null explicitly
    // (undefined leaves the existing value alone). Validation:
    //   - gstin: exactly 15 chars, classic format regex (state + PAN + entity + 'Z' + checksum)
    //   - state_code: 2 digits
    //   - if both gstin and state_code are set, state_code must equal gstin's first 2 chars
    if (action === 'update-billing-details') {
      const hasGstin    = Object.prototype.hasOwnProperty.call(body, 'gstin');
      const hasAddress  = Object.prototype.hasOwnProperty.call(body, 'billing_address');
      const hasState    = Object.prototype.hasOwnProperty.call(body, 'state_code');

      const gstin    = hasGstin   ? (body.gstin           as string | null) : undefined;
      const address  = hasAddress ? (body.billing_address as string | null) : undefined;
      const state    = hasState   ? (body.state_code      as string | null) : undefined;

      // GSTIN format: 2-digit state + 5 alpha (PAN org) + 4 digit + 1 alpha (PAN check)
      // + 1 digit (entity) + 1 alpha ('Z' for normal taxpayers) + 1 alphanumeric (checksum)
      const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9]{1}[A-Z]{1}[0-9A-Z]{1}$/;
      if (gstin !== undefined && gstin !== null) {
        const trimmed = gstin.toUpperCase().trim();
        if (!gstinPattern.test(trimmed)) {
          return err('Invalid GSTIN format. Expected 15-character GSTIN (e.g. 33ABCDE1234F1Z5).');
        }
      }

      if (state !== undefined && state !== null && !/^[0-9]{2}$/.test(state)) {
        return err('state_code must be a 2-digit GST state code (e.g. "33").');
      }

      // Cross-field consistency. We need the *resolved* values — if the
      // caller didn't include a field, fall back to the row's current value.
      const { data: current, error: curErr } = await adminClient
        .from('fleets')
        .select('gstin, billing_address, state_code')
        .eq('id', fleet.id)
        .single();
      if (curErr) return err(curErr.message, 500);

      const resolvedGstin = gstin !== undefined ? gstin : current.gstin;
      const resolvedState = state !== undefined ? state : current.state_code;
      if (resolvedGstin && resolvedState &&
          resolvedGstin.substring(0, 2) !== resolvedState) {
        return err('state_code must match the first 2 digits of GSTIN.');
      }

      const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (gstin   !== undefined) updatePayload.gstin           = gstin === null ? null : gstin.toUpperCase().trim();
      if (address !== undefined) updatePayload.billing_address = address;
      if (state   !== undefined) updatePayload.state_code      = state;

      const { error: updErr } = await adminClient
        .from('fleets')
        .update(updatePayload)
        .eq('id', fleet.id);
      if (updErr) return err(updErr.message, 500);

      await adminClient.from('audit_logs').insert({
        fleet_id:      fleet.id,
        user_id:       user.id,
        action:        'fleet.billing_details_updated',
        resource_type: 'fleet',
        resource_id:   fleet.id,
        old_values: {
          gstin:           current.gstin,
          billing_address: current.billing_address,
          state_code:      current.state_code,
        },
        new_values: updatePayload,
      });

      return json({
        success:         true,
        gstin:           updatePayload.gstin           ?? current.gstin           ?? null,
        billing_address: updatePayload.billing_address ?? current.billing_address ?? null,
        state_code:      updatePayload.state_code      ?? current.state_code      ?? null,
      });
    }

    // ── POST { action: 'update-language-preference', language: 'en' | 'ta' }
    // Persists the customer's language choice to fleets.preferred_language
    // (Phase 1.8). Called by LanguageSwitcher on every toggle so server-side
    // reminders (WhatsApp, email) localize to match the in-app preference.
    //
    // Pass `null` (or omit `language`) to clear — useful if we ever want a
    // "follow browser" reset path. Validation:
    //   - language must be 'en' | 'ta' | null. Any other value rejected.
    if (action === 'update-language-preference') {
      const SUPPORTED = ['en', 'ta'] as const;
      const raw = body.language;

      // Allow explicit null (clear preference) and the supported set.
      const isClear   = raw === null;
      const language  = typeof raw === 'string' ? raw.trim() : '';
      const isValid   = isClear || (SUPPORTED as readonly string[]).includes(language);
      if (!isValid) {
        return err(`language must be one of: ${SUPPORTED.join(', ')}, or null to clear`);
      }

      const newValue = isClear ? null : language;

      const { data: current } = await adminClient
        .from('fleets')
        .select('preferred_language')
        .eq('id', fleet.id)
        .single();

      // No-op if the value isn't actually changing — saves a write + an
      // audit row. The LanguageSwitcher fires on every click so this
      // skips the noisy case of toggling back to the existing language.
      if (current?.preferred_language === newValue) {
        return json({ success: true, language: newValue, unchanged: true });
      }

      const { error: updErr } = await adminClient
        .from('fleets')
        .update({
          preferred_language: newValue,
          updated_at:         new Date().toISOString(),
        })
        .eq('id', fleet.id);
      if (updErr) return err(updErr.message, 500);

      await adminClient.from('audit_logs').insert({
        fleet_id:      fleet.id,
        user_id:       user.id,
        action:        'fleet.language_preference_updated',
        resource_type: 'fleet',
        resource_id:   fleet.id,
        old_values: { preferred_language: current?.preferred_language ?? null },
        new_values: { preferred_language: newValue },
      });

      return json({ success: true, language: newValue });
    }

    // ── POST { action: 'log-action', resource_type, action_name, ... } ────────
    if (action === 'log-action') {
      const resourceType = body.resource_type as string | undefined;
      const actionName   = body.action_name   as string | undefined;
      const resourceId   = (body.resource_id  as string) ?? null;

      if (!resourceType) return err('resource_type is required');
      if (!actionName)   return err('action_name is required');

      // For resource types that map to fleet-owned rows, verify ownership
      // to prevent a manager from injecting audit entries for other fleets.
      if (resourceId) {
        const fleetColumnByType: Record<string, { table: string; column: string }> = {
          vehicle:    { table: 'vehicles',        column: 'fleet_id' },
          driver:     { table: 'driver_accounts', column: 'fleet_id' },
          threshold:  { table: 'thresholds',      column: 'fleet_id' },
          geofence:   { table: 'geofences',       column: 'fleet_id' },
        };
        const mapping = fleetColumnByType[resourceType];
        if (mapping) {
          const { data: owned } = await adminClient
            .from(mapping.table)
            .select('id')
            .eq('id', resourceId)
            .eq(mapping.column, fleet.id)
            .maybeSingle();
          if (!owned) return err('resource_id does not belong to your fleet', 403);
        }
      }

      const { error: insertErr } = await adminClient.from('audit_logs').insert({
        fleet_id:      fleet.id,
        user_id:       user.id,
        action:        actionName,
        resource_type: resourceType,
        resource_id:   resourceId,
        old_values:    (body.old_values  as Record<string, unknown>) ?? null,
        new_values:    (body.new_values  as Record<string, unknown>) ?? null,
      });

      if (insertErr) return err(insertErr.message, 500);
      return json({ success: true });
    }

    return err(`Unknown POST action: ${action}`);
  }

  return err('Method not allowed', 405);
});
