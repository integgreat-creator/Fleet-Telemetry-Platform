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
        const plan = sub.plan_id?.includes('pro') ? 'pro'
                   : sub.plan_id?.includes('starter') ? 'starter'
                   : sub.plan_id?.includes('enterprise') ? 'enterprise'
                   : 'starter';
        const maxVehicles = plan === 'starter' ? 10 : plan === 'pro' ? 50 : plan === 'enterprise' ? 9999 : 3;
        const maxDrivers  = plan === 'starter' ? 20 : plan === 'pro' ? 200 : plan === 'enterprise' ? 9999 : 5;
        await supabase.from('subscriptions').upsert({
          fleet_id: fleetId,
          plan,
          status: 'active',
          max_vehicles: maxVehicles,
          max_drivers: maxDrivers,
          razorpay_subscription_id: sub.id,
          current_period_start: sub.current_start ? new Date(sub.current_start * 1000).toISOString() : null,
          current_period_end: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'fleet_id' });
        await supabase.from('audit_logs').insert({
          fleet_id: fleetId,
          action: `subscription.${eventType.split('.')[1]}`,
          resource_type: 'subscription',
          new_values: { plan, status: 'active', razorpay_subscription_id: sub.id },
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
