/**
 * whatsapp-alerts edge function
 *
 * Sends WhatsApp messages via WhatsApp Cloud API (Meta).
 *
 * Required secrets:
 *   WHATSAPP_ACCESS_TOKEN      — Meta App access token
 *   WHATSAPP_PHONE_NUMBER_ID   — From phone number ID in Meta dashboard
 *
 * POST body:
 *   event_id, vehicle_name, vehicle_vin, event_type, description,
 *   whatsapp_number (E.164 format, e.g. +919876543210)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const PHONE_NUMBER_ID       = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const WA_API_URL            = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVENT_EMOJIS: Record<string, string> = {
  device_offline:        "🔴",
  device_tamper:         "⚠️",
  unauthorized_movement: "🚨",
  excessive_idle:        "🟡",
  trip_gap:              "⏱️",
  mock_gps_detected:     "🛑",
  ignition_no_data:      "⚠️",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => null);
  if (!body) {
    return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400, headers: corsHeaders });
  }

  const {
    event_id,
    vehicle_name,
    vehicle_vin,
    event_type,
    description,
    whatsapp_number,
  } = body;

  if (!whatsapp_number || !event_type) {
    return new Response(JSON.stringify({ error: "whatsapp_number and event_type required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Normalise number to E.164 (remove spaces, dashes; ensure + prefix)
  const normalised = whatsapp_number.replace(/[\s\-\(\)]/g, "");
  const toNumber   = normalised.startsWith("+") ? normalised : `+${normalised}`;

  const emoji   = EVENT_EMOJIS[event_type] ?? "⚠️";
  const now     = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });

  const messageText = [
    `${emoji} *FTPGo Alert*`,
    ``,
    `*Vehicle:* ${vehicle_name}${vehicle_vin ? ` (${vehicle_vin})` : ""}`,
    `*Event:* ${description}`,
    `*Time:* ${now} IST`,
    ``,
    `Log in to FTPGo dashboard to view details and acknowledge this alert.`,
  ].join("\n");

  let success = false;
  let errorMsg = "";

  // Only attempt if credentials are configured
  if (WHATSAPP_ACCESS_TOKEN && PHONE_NUMBER_ID) {
    try {
      const waRes = await fetch(WA_API_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type:    "individual",
          to:                toNumber.replace("+", ""),
          type:              "text",
          text:              { body: messageText, preview_url: false },
        }),
      });

      const waBody = await waRes.json();
      if (waRes.ok && waBody.messages?.[0]?.id) {
        success = true;
      } else {
        errorMsg = waBody.error?.message ?? JSON.stringify(waBody);
      }
    } catch (e) {
      errorMsg = String(e);
    }
  } else {
    // Credentials not yet configured — log but don't fail
    errorMsg = "WhatsApp credentials not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)";
    console.warn(errorMsg);
  }

  // Mark event as sent in DB
  if (event_id) {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin
      .from("vehicle_events")
      .update({
        whatsapp_sent:    success,
        whatsapp_sent_at: success ? new Date().toISOString() : null,
        metadata:         success ? undefined : { whatsapp_error: errorMsg },
      })
      .eq("id", event_id);
  }

  return new Response(
    JSON.stringify({ success, error: errorMsg || undefined }),
    { status: success ? 200 : 207, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
