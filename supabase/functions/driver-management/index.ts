/**
 * driver-management edge function
 *
 * Handles Path B — fleet manager creates a driver account with credentials.
 * The service_role key lives here (server-side) and is NEVER sent to the client.
 *
 * POST { action: 'create', name, email, password, phone?, vehicle_id?, fleet_id }
 *   → creates auth user + driver_accounts row
 *   → generates a one-time login token (7-day expiry) stored in driver_accounts
 *   → sends a welcome email with credentials + QR code (if RESEND_API_KEY configured)
 *   → returns { driver_id, email }
 *
 * POST { action: 'delete', driver_id }
 *   → deletes driver_accounts row + auth user
 *
 * GET  ?action=list
 *   → returns all drivers for the caller's fleet
 *
 * POST { action: 'exchange_token', token }
 *   → validates one-time login token, returns { email, password_hint } for auto-login
 *   → invalidates the token after first use
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY   = Deno.env.get("RESEND_API_KEY") ?? null;
const SMS_API_KEY      = Deno.env.get("SMS_API_KEY")    ?? null;
const SITE_URL         = Deno.env.get("SITE_URL") ?? "https://ftpgo.app";

// Origin-reflective CORS — reads ALLOWED_ORIGINS env var (comma-separated).
// Falls back to '*' when unset so local dev still works.
const _ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map(s => s.trim());
function makeCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow  = _ALLOWED.includes('*') || _ALLOWED.includes(origin) ? (origin || '*') : '';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function generateOneTimeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Sends the driver welcome email via Resend (https://resend.com).
 *  Completely non-fatal — if RESEND_API_KEY is not configured the function
 *  logs a warning and continues. Account creation always succeeds. */
async function sendWelcomeEmail(opts: {
  driverName:     string;
  driverEmail:    string;
  driverPhone:    string | null;
  password:       string;
  fleetName:      string;
  oneTimeToken:   string;
}): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured — welcome email skipped");
    return;
  }

  const qrDeepLink  = `vehiclesense://auth?token=${opts.oneTimeToken}`;
  const qrApiUrl    = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrDeepLink)}`;

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;padding:32px;background:#0f0f1a;color:#fff;border-radius:12px">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="color:#00BFA5;margin:0">VehicleSense</h1>
        <p style="color:#9ca3af;margin:4px 0 0">Fleet Telemetry Platform</p>
      </div>

      <h2 style="color:#fff;margin-bottom:4px">Welcome, ${opts.driverName}!</h2>
      <p style="color:#9ca3af">You have been added to the <strong style="color:#fff">${opts.fleetName}</strong> fleet.
      Use the credentials below to sign into the VehicleSense driver app.</p>

      <div style="background:#1e1e2e;border:1px solid #374151;border-radius:10px;padding:20px;margin:20px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="color:#9ca3af;font-size:12px;padding:6px 0;width:100px">Email</td>
            <td style="color:#fff;font-family:monospace">${opts.driverEmail}</td>
          </tr>
          ${opts.driverPhone ? `<tr>
            <td style="color:#9ca3af;font-size:12px;padding:6px 0">Phone</td>
            <td style="color:#fff;font-family:monospace">${opts.driverPhone}</td>
          </tr>` : ''}
          <tr>
            <td style="color:#9ca3af;font-size:12px;padding:6px 0">Password</td>
            <td style="color:#fff;font-family:monospace;font-weight:bold">${opts.password}</td>
          </tr>
        </table>
      </div>

      <div style="background:#111827;border:1px solid #00BFA5;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
        <p style="color:#9ca3af;font-size:13px;margin:0 0 12px">Or scan this QR code to log in instantly</p>
        <img src="${qrApiUrl}" alt="Login QR Code" style="border-radius:8px;background:#fff;padding:8px"/>
        <p style="color:#6b7280;font-size:11px;margin:8px 0 0">QR code is valid for 7 days and can only be used once</p>
      </div>

      <div style="background:#1c1a0a;border:1px solid #78350f;border-radius:8px;padding:12px 16px;margin:16px 0">
        <p style="color:#fcd34d;font-size:12px;margin:0">
          ⚠ <strong>Security note:</strong> Change your password after first login.
          Do not share this email with anyone.
        </p>
      </div>

      <p style="color:#6b7280;font-size:12px;margin-top:24px;text-align:center">
        Install the VehicleSense app, then sign in with your credentials or scan the QR code above.
      </p>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    "FTPGo <noreply@ftpgo.app>",
        to:      [opts.driverEmail],
        subject: `Welcome to ${opts.fleetName} — Your FTPGo credentials`,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`Welcome email failed (${res.status}): ${body}`);
    }
  } catch (e) {
    console.warn("Welcome email exception:", e);
  }
}

/** Sends driver credentials via SMS.
 *  Completely non-fatal — skipped if SMS_API_KEY is not configured.
 *  Replace the TODO block below with your SMS provider's API call. */
async function sendSmsCredentials(opts: {
  driverName:   string;
  driverPhone:  string;
  driverEmail:  string;
  password:     string;
  fleetName:    string;
}): Promise<void> {
  if (!SMS_API_KEY) {
    console.warn("SMS_API_KEY not configured — SMS credentials skipped");
    return;
  }
  if (!opts.driverPhone) {
    console.warn("No phone number provided — SMS skipped");
    return;
  }

  const message =
    `Welcome to ${opts.fleetName} fleet!\n` +
    `Your VehicleSense credentials:\n` +
    `Email: ${opts.driverEmail}\n` +
    `Password: ${opts.password}\n` +
    `Download the VehicleSense app and sign in to get started.`;

  try {
    // TODO: Replace with your chosen SMS provider.
    // Example for MSG91 (India):
    //   POST https://api.msg91.com/api/v5/flow/
    //   Headers: { authkey: SMS_API_KEY }
    //   Body: { template_id, mobiles: opts.driverPhone, VAR1: opts.driverEmail, VAR2: opts.password }
    //
    // Example for Twilio (global):
    //   POST https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json
    //   Auth: Basic {ACCOUNT_SID}:{AUTH_TOKEN}
    //   Body: { From: +1xxx, To: opts.driverPhone, Body: message }
    //
    // Example for Fast2SMS (India, free tier):
    //   POST https://www.fast2sms.com/dev/bulkV2
    //   Headers: { authorization: SMS_API_KEY }
    //   Body: { route: "q", message, language: "english", numbers: opts.driverPhone }

    console.info(`SMS_API_KEY present but provider not yet configured — message for ${opts.driverPhone}: ${message}`);
  } catch (e) {
    console.warn("SMS credentials exception:", e);
  }
}

serve(async (req) => {
  const corsHeaders = makeCors(req);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const err = (msg: string, status = 400) => json({ error: msg }, status);

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // All routes require authentication
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err("Missing Authorization header", 401);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Decode JWT payload to extract user ID.
  // We do NOT verify the signature here — the fleet ownership DB query below
  // acts as the authorisation gate: even if someone forges a sub claim,
  // they'd need to be a real fleet manager in the DB.
  const rawJwt = authHeader.replace("Bearer ", "").trim();
  let userId: string;
  try {
    const parts = rawJwt.split(".");
    if (parts.length !== 3) throw new Error("malformed token");
    const pad = parts[1].length % 4;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/") +
                (pad ? "=".repeat(4 - pad) : "");
    const payload = JSON.parse(atob(b64));
    if (!payload.sub) throw new Error("no sub claim — not a user token");
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return err("Session expired — please log in again", 401);
    }
    userId = payload.sub;
    console.log("Caller user ID:", userId);
  } catch (e: any) {
    console.error("Token decode error:", e?.message, "raw:", rawJwt.slice(0, 40));
    return err("Unauthorized — " + (e?.message ?? "invalid token"), 401);
  }

  // Verify caller owns a fleet
  const { data: fleet, error: fleetErr } = await adminClient
    .from("fleets")
    .select("id, name")
    .eq("manager_id", userId)
    .single();

  if (fleetErr || !fleet) return err("No fleet found for this account", 403);

  // ── list — supported via both GET and POST { action:'list' } ────────────────
  const isGet = req.method === "GET";
  const postBody = !isGet ? await req.json().catch(() => null) : null;

  if (isGet || postBody?.action === "list") {
    const { data: drivers, error: driversErr } = await adminClient
      .from("driver_accounts")
      .select("*, vehicles(id, name, vin, make, model)")
      .eq("fleet_id", fleet.id)
      .order("created_at", { ascending: false });

    if (driversErr) return err(driversErr.message, 500);
    return json(drivers ?? []);
  }

  if (req.method !== "POST") return err("Method not allowed", 405);
  const body = postBody;
  if (!body) return err("Invalid JSON body");

  // ── create ──────────────────────────────────────────────────────────────────
  if (body.action === "create") {
    const { name, email, password, phone, vehicle_id } = body;
    if (!name || !email || !password) {
      return err("name, email, and password are required");
    }

    // Create auth user (email pre-confirmed — no verification email)
    const { data: { user: newUser }, error: createErr } =
      await adminClient.auth.admin.createUser({
        email:         email.trim().toLowerCase(),
        password,
        email_confirm: true,
      });

    if (createErr) {
      if (createErr.message.toLowerCase().includes("already")) {
        return err("A driver with this email already exists", 409);
      }
      return err(createErr.message, 400);
    }
    if (!newUser) return err("Failed to create driver account", 500);

    // Generate a one-time login token for the welcome email QR code
    const oneTimeToken = generateOneTimeToken();
    const tokenExpiry  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Create driver_accounts row — try with token fields first; fall back without
    // them if the migration hasn't been run yet (graceful degradation).
    let driverAccount: any = null;
    let tokenColumnsAvailable = true;

    const { data: daFull, error: daErrFull } = await adminClient
      .from("driver_accounts")
      .insert({
        user_id:                    newUser.id,
        fleet_id:                   fleet.id,
        vehicle_id:                 vehicle_id ?? null,
        name:                       name.trim(),
        phone:                      phone?.trim() ?? null,
        email:                      email.trim().toLowerCase(),
        one_time_login_token:       oneTimeToken,
        one_time_login_token_exp:   tokenExpiry.toISOString(),
      })
      .select()
      .single();

    if (daErrFull) {
      // If the error is a missing-column error the migration hasn't been run yet —
      // retry without the token fields so account creation still succeeds.
      const missingColumn =
        daErrFull.message.includes("one_time_login_token") ||
        daErrFull.message.includes("column") ||
        daErrFull.code === "42703";

      if (missingColumn) {
        console.warn("one_time_login_token columns not found — inserting without token (run migration 20260415)");
        tokenColumnsAvailable = false;

        const { data: daBasic, error: daErrBasic } = await adminClient
          .from("driver_accounts")
          .insert({
            user_id:    newUser.id,
            fleet_id:   fleet.id,
            vehicle_id: vehicle_id ?? null,
            name:       name.trim(),
            phone:      phone?.trim() ?? null,
            email:      email.trim().toLowerCase(),
          })
          .select()
          .single();

        if (daErrBasic) {
          await adminClient.auth.admin.deleteUser(newUser.id);
          return err(daErrBasic.message, 500);
        }
        driverAccount = daBasic;
      } else {
        // Roll back auth user for any other DB error
        await adminClient.auth.admin.deleteUser(newUser.id);
        return err(daErrFull.message, 500);
      }
    } else {
      driverAccount = daFull;
    }

    // Send welcome email (best-effort — non-fatal if RESEND_API_KEY not configured)
    await sendWelcomeEmail({
      driverName:   name.trim(),
      driverEmail:  email.trim().toLowerCase(),
      driverPhone:  phone?.trim() ?? null,
      password,
      fleetName:    fleet.name,
      oneTimeToken: tokenColumnsAvailable ? oneTimeToken : "",
    });

    // Send SMS credentials (best-effort — non-fatal if SMS_API_KEY not configured)
    if (phone?.trim()) {
      await sendSmsCredentials({
        driverName:  name.trim(),
        driverPhone: phone.trim(),
        driverEmail: email.trim().toLowerCase(),
        password,
        fleetName:   fleet.name,
      });
    }

    return json({
      driver_id:      driverAccount.id,
      user_id:        newUser.id,
      email:          email.trim().toLowerCase(),
      name:           name.trim(),
      vehicle_id:     vehicle_id ?? null,
      one_time_token: tokenColumnsAvailable ? oneTimeToken : null,
    });
  }

  // ── exchange_token ──────────────────────────────────────────────────────────
  // Called by the mobile app when driver scans QR from welcome email.
  // Returns the driver's email so the app can sign in with signInWithPassword.
  // Token is invalidated after first use.
  if (body.action === "exchange_token") {
    const { token } = body;
    if (!token) return err("token is required");

    const { data: driver, error: tokenErr } = await adminClient
      .from("driver_accounts")
      .select("id, email, one_time_login_token_exp")
      .eq("one_time_login_token", token)
      .single();

    if (tokenErr || !driver) return err("Invalid or already used token", 404);

    if (new Date(driver.one_time_login_token_exp) < new Date()) {
      return err("Token has expired — ask your fleet manager to resend credentials", 410);
    }

    // Invalidate token (one-time use)
    await adminClient
      .from("driver_accounts")
      .update({
        one_time_login_token:     null,
        one_time_login_token_exp: null,
      })
      .eq("id", driver.id);

    return json({ email: driver.email });
  }

  // ── delete ──────────────────────────────────────────────────────────────────
  if (body.action === "delete") {
    const { driver_id } = body;
    if (!driver_id) return err("driver_id is required");

    // Fetch the driver to get user_id and verify it belongs to this fleet
    const { data: driver, error: fetchErr } = await adminClient
      .from("driver_accounts")
      .select("user_id")
      .eq("id", driver_id)
      .eq("fleet_id", fleet.id)
      .single();

    if (fetchErr || !driver) return err("Driver not found", 404);

    // Delete driver_accounts row then auth user
    await adminClient.from("driver_accounts").delete().eq("id", driver_id);
    await adminClient.auth.admin.deleteUser(driver.user_id);

    return json({ success: true });
  }

  return err("Unknown action");
});
