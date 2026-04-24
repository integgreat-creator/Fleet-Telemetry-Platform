import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHmac } from 'node:crypto';

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-razorpay-signature',
};

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
