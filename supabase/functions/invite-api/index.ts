/**
 * invite-api edge function
 *
 * Handles the QR invite flow (Path A — mobile-initiated invites):
 *
 * POST { action: 'create', driver_phone, fleet_id, vehicle_name?, driver_email? }
 *   → creates invitation row, returns { token, invite_url }
 *     also sends an invite email to driver_email if provided
 *
 * GET  ?action=get&token=<token>
 *   → returns invite details for the mobile app to display
 *
 * POST { action: 'accept', token }
 *   → creates driver_accounts row (vehicle_id=null), marks invitation accepted,
 *     returns { success, fleet_id, user_id, session }
 *
 * GET  ?action=poll&token=<token>
 *   → returns { status } for the web dashboard to poll
 *
 * POST { action: 'revoke', token }
 *   → marks the invitation as 'revoked' (fleet manager only)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function err(msg: string, status = 400) { return json({ error: msg }, status); }

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const action = req.method === "GET"
    ? url.searchParams.get("action")
    : (await req.clone().json().catch(() => ({}))).action;

  // ── GET: get invite details (no auth required — mobile uses this) ──────────
  if (req.method === "GET" && action === "get") {
    const token = url.searchParams.get("token");
    if (!token) return err("token is required");

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await adminClient
      .from("invitations")
      .select("fleet_name, vehicle_name, status, expires_at")
      .eq("invite_token", token)
      .single();

    if (error || !data) return err("Invitation not found", 404);
    if (data.status === "accepted") return err("Invitation already accepted", 410);
    if (data.status === "revoked")  return err("Invitation has been revoked", 410);
    if (new Date(data.expires_at) < new Date()) return err("Invitation has expired", 410);

    return json(data);
  }

  // ── GET: poll status (fleet manager dashboard) ────────────────────────────
  if (req.method === "GET" && action === "poll") {
    const token = url.searchParams.get("token");
    if (!token) return err("token is required");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err("Missing Authorization header", 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return err("Unauthorized", 401);

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await adminClient
      .from("invitations")
      .select("status, vehicle_id")
      .eq("invite_token", token)
      .single();

    if (error || !data) return err("Invitation not found", 404);
    return json({ status: data.status, vehicle_id: data.vehicle_id });
  }

  // ── POST actions ──────────────────────────────────────────────────────────
  if (req.method !== "POST") return err("Method not allowed", 405);

  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid JSON body");

  // ── create: fleet manager creates an invitation ───────────────────────────
  if (body.action === "create") {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err("Missing Authorization header", 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return err("Unauthorized", 401);

    const { driver_phone, driver_email, fleet_id } = body;
    // vehicle_name is now optional — driver vehicle is registered via OBD connection
    const vehicle_name: string = (body.vehicle_name as string | undefined)?.trim() || 'TBD';

    if (!driver_phone || !fleet_id) {
      return err("driver_phone and fleet_id are required");
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify the caller owns this fleet
    const { data: fleet, error: fleetErr } = await adminClient
      .from("fleets")
      .select("id, name")
      .eq("id", fleet_id)
      .eq("manager_id", user.id)
      .single();

    if (fleetErr || !fleet) return err("Fleet not found or access denied", 403);

    const token = generateToken();

    const { data: invite, error: inviteErr } = await adminClient
      .from("invitations")
      .insert({
        fleet_id,
        fleet_name:   fleet.name,
        invite_token: token,
        vehicle_name: vehicle_name,
        driver_phone: driver_phone.trim(),
        driver_email: driver_email?.trim() ?? null,
        status:       "pending",
      })
      .select()
      .single();

    if (inviteErr) return err(inviteErr.message, 500);

    // Send invite email if driver_email was provided
    const driverEmail = body.driver_email as string | undefined;
    if (driverEmail && driverEmail.includes('@')) {
      try {
        const inviteUrl = `${Deno.env.get('SITE_URL') ?? 'https://ftpgo.app'}/invite?token=${token}`;
        const emailHtml = `
          <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:32px">
            <h2 style="color:#00BFA5">You've been invited to FTPGo</h2>
            <p>Your fleet manager has added you to <strong>${fleet.name}</strong>.</p>
            ${vehicle_name !== 'TBD' ? `<p>Vehicle: <strong>${vehicle_name}</strong></p>` : ''}
            <p>Install the FTPGo app and scan the QR code, or tap the button below:</p>
            <a href="ftpgo://join?token=${token}"
               style="display:inline-block;background:#00BFA5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
              Open in App
            </a>
            <p style="margin-top:16px;font-size:12px;color:#666">
              Or copy this link: ftpgo://join?token=${token}
            </p>
            <p style="font-size:12px;color:#666">This invite expires in 72 hours.</p>
          </div>
        `;

        await adminClient.auth.admin.inviteUserByEmail(driverEmail, {
          data: { invite_token: token, fleet_name: fleet.name },
          redirectTo: `ftpgo://join?token=${token}`,
        }).catch(() => null); // non-fatal — email is best-effort
      } catch (_) {
        // Email sending failure is non-fatal
      }
    }

    return json({
      token,
      invite_url: `ftpgo://join?token=${token}`,
      invite_id:  invite.id,
    });
  }

  // ── revoke: fleet manager cancels a pending invitation ────────────────────
  if (body.action === "revoke") {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err("Missing Authorization header", 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return err("Unauthorized", 401);

    const { token } = body;
    if (!token) return err("token is required");

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch the invitation and verify it belongs to a fleet owned by this user
    const { data: invite, error: fetchErr } = await adminClient
      .from("invitations")
      .select("id, fleet_id, status")
      .eq("invite_token", token)
      .single();

    if (fetchErr || !invite) return err("Invitation not found", 404);

    // Confirm the caller owns the fleet this invitation belongs to
    const { data: fleet, error: fleetErr } = await adminClient
      .from("fleets")
      .select("id")
      .eq("id", invite.fleet_id)
      .eq("manager_id", user.id)
      .maybeSingle();

    if (fleetErr || !fleet) return err("Access denied", 403);

    if (invite.status !== "pending") {
      return err(`Cannot revoke an invitation with status '${invite.status}'`, 409);
    }

    const { error: updateErr } = await adminClient
      .from("invitations")
      .update({ status: "revoked" })
      .eq("id", invite.id);

    if (updateErr) return err(updateErr.message, 500);

    return json({ success: true });
  }

  // ── accept: driver accepts the invitation on mobile app ───────────────────
  if (body.action === "accept") {
    const { token } = body;
    if (!token) {
      return err("token is required");
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch and validate the invitation
    const { data: invite, error: inviteErr } = await adminClient
      .from("invitations")
      .select("*")
      .eq("invite_token", token)
      .single();

    if (inviteErr || !invite) return err("Invitation not found", 404);
    if (invite.status === "accepted") return err("Invitation already accepted", 410);
    if (invite.status === "revoked")  return err("Invitation has been revoked", 410);
    if (new Date(invite.expires_at) < new Date()) return err("Invitation has expired", 410);

    // Create or retrieve the driver's auth user
    let userId: string;
    let sessionTokens: { access_token: string; refresh_token: string } | null = null;

    const phone = invite.driver_phone as string;
    const email = invite.driver_email as string | null;

    // Try to find an existing user by phone or email
    let existingUserId: string | null = null;

    if (email) {
      const { data: listData } = await adminClient.auth.admin.listUsers();
      const match = listData?.users?.find((u: { email?: string; phone?: string; id: string }) =>
        u.email === email || u.phone === phone
      );
      if (match) existingUserId = match.id;
    }

    if (!existingUserId) {
      // Create a new user for the driver
      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        phone,
        email: email ?? undefined,
        password: generateToken(), // crypto-random temporary password
        email_confirm: true,
        phone_confirm: true,
        user_metadata: { name: invite.vehicle_name, fleet_id: invite.fleet_id },
      });
      if (createErr || !newUser?.user) return err("Failed to create driver account", 500);
      userId = newUser.user.id;
    } else {
      userId = existingUserId;
    }

    // Generate a sign-in link / session for the new user using service role
    try {
      const { data: linkData } = await adminClient.auth.admin.generateLink({
        type: "magiclink",
        email: email ?? `${phone.replace(/\D/g, '')}@ftpgo.driver`,
        options: { data: { fleet_id: invite.fleet_id } },
      });
      if (linkData?.properties) {
        const supabaseUser = createClient(SUPABASE_URL, ANON_KEY);
        const { data: sessionData } = await supabaseUser.auth.verifyOtp({
          token_hash: linkData.properties.hashed_token,
          type: "magiclink",
        });
        if (sessionData?.session) {
          sessionTokens = {
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
          };
        }
      }
    } catch (_) {
      // Session generation is best-effort; driver can still sign in manually
    }

    // Create/update driver_accounts row with vehicle_id = null
    await adminClient.from('driver_accounts').upsert({
      user_id: userId,
      fleet_id: invite.fleet_id,
      vehicle_id: null,   // will be set after driver connects OBD
      name: invite.vehicle_name,
      phone: invite.driver_phone,
      email: invite.driver_email ?? null,
    }, { onConflict: 'user_id' });

    // Mark invitation as accepted
    await adminClient
      .from("invitations")
      .update({ status: "accepted" })
      .eq("invite_token", token);

    return new Response(JSON.stringify({
      success: true,
      fleet_id: invite.fleet_id,
      user_id: userId,
      session: sessionTokens,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return err("Unknown action");
});
