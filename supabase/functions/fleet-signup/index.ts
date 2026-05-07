/**
 * fleet-signup edge function
 *
 * Handles fleet manager registration atomically using the service role key:
 *   1. Creates the auth user (marked as email-confirmed immediately)
 *   2. Creates the fleet record + trial subscription linked to that user
 *   3. Returns { ok: true } — the client signs in with signInWithPassword()
 *
 * The client handles sign-in rather than receiving a server-side session
 * because setSession() is unreliable across browsers and doesn't consistently
 * fire onAuthStateChange, preventing the dashboard from loading.
 *
 * "Already exists" path: if the auth account exists but has no fleet (e.g.
 * after a fleet deletion), credentials are verified via signInWithPassword and
 * a new fleet is created for the existing account.
 *
 * POST { email, password, fleet_name,
 *        preferred_language?: 'en' | 'ta',
 *        acquisition?: { ref?, utm_source?, utm_medium?, utm_campaign?,
 *                        utm_content?, utm_term? } }
 *
 * Acquisition (Phase 4.1): the client passes whatever URL params were
 * present at signup time and we classify them server-side into a closed
 * enum bucket (organic / referral / paid_search / paid_social / partner /
 * direct / other). Server-side classification keeps the bucket logic in
 * one place and lets us tune mappings without a client redeploy.
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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

// ─── Acquisition classifier (Phase 4.1) ─────────────────────────────────────

/// Inputs from the signup URL captured by the client. All fields optional.
interface AcquisitionInput {
  ref?:           string;
  utm_source?:    string;
  utm_medium?:    string;
  utm_campaign?:  string;
  utm_content?:   string;
  utm_term?:      string;
}

/// Output fields written onto the new fleet row.
interface AcquisitionFields {
  acquisition_source:            string;
  acquisition_source_raw:        string | null;
  acquisition_utm:               Record<string, unknown> | null;
  acquisition_referrer_fleet_id: string | null;
}

/// Recognised partner sources — extend as we sign partner co-marketing
/// deals. Anything not in this set with no other UTM signal lands in
/// 'other'. Keep lowercase here; the classifier lowercases inputs.
const PARTNER_SOURCES = new Set<string>([
  // Empty for now — populate as partners sign on. Keeping the list
  // explicit (rather than a regex) means a "facebook-partner" UTM
  // doesn't accidentally land in this bucket via a substring match.
]);

/// Sources we treat as social platforms when paired with a paid medium.
const SOCIAL_SOURCES = new Set<string>([
  'facebook', 'instagram', 'linkedin', 'twitter', 'x',
  'youtube', 'tiktok', 'reddit', 'whatsapp', 'telegram',
]);

/// Mediums that signal paid placement. 'cpc' and 'ppc' are the GA-standard
/// values; 'paid' is a common humanism we accept too.
const PAID_MEDIUMS = new Set<string>([
  'cpc', 'ppc', 'paid', 'paidsearch', 'paid-search', 'paid_search',
  'paidsocial', 'paid-social', 'paid_social', 'display',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Verify the ref token resolves to an actual fleet. Anyone can put
/// `?ref=<random-uuid>` in their URL, but if it doesn't match a real
/// fleet we fall back to source='other' rather than letting bogus
/// referrer_fleet_id values pile up. Done with the admin client to
/// bypass RLS — fleet existence is not RLS-protected per se but the
/// signup flow doesn't have a session yet.
async function verifyReferrerFleet(
  adminClient: ReturnType<typeof createClient>,
  candidate: string,
): Promise<string | null> {
  if (!UUID_RE.test(candidate)) return null;
  const { data } = await adminClient
    .from('fleets')
    .select('id')
    .eq('id', candidate)
    .maybeSingle();
  return data?.id ?? null;
}

/// Classify acquisition inputs into the closed enum bucket the DB
/// CHECK enforces. Returns the four columns to write onto the fleet row.
///
/// Precedence (highest to lowest):
///   1. Valid `?ref=<uuid>` resolving to a real fleet  → referral
///   2. utm_medium ∈ paid AND utm_source ∈ social      → paid_social
///   3. utm_medium ∈ paid (any other source)           → paid_search
///   4. utm_source ∈ partner allow-list                → partner
///   5. Any utm_source at all                          → other
///   6. Nothing at all                                 → direct
///
/// 'organic' isn't reachable from this classifier alone — it requires
/// an HTTP referrer header check (search engine domain) which we don't
/// do here. Reserved for a future enrichment pass.
async function classifyAcquisition(
  adminClient: ReturnType<typeof createClient>,
  input: AcquisitionInput | null | undefined,
): Promise<AcquisitionFields> {
  // Always keep the raw UTM blob even when classification falls through
  // to 'direct' — it's cheap forensic data, and a future re-classifier
  // pass can revisit it without a re-signup.
  const cleanUtm: Record<string, string> = {};
  if (input) {
    for (const k of ['ref', 'utm_source', 'utm_medium', 'utm_campaign',
                     'utm_content', 'utm_term'] as const) {
      const v = (input[k] ?? '').toString().trim();
      if (v) cleanUtm[k] = v.slice(0, 200);  // hard cap to dodge garbage payloads
    }
  }
  const utmJsonb = Object.keys(cleanUtm).length > 0 ? cleanUtm : null;
  const sourceRaw = cleanUtm.utm_source ?? null;

  // 1. Referral — only when the ref resolves to a real fleet.
  if (cleanUtm.ref) {
    const referrerId = await verifyReferrerFleet(adminClient, cleanUtm.ref);
    if (referrerId) {
      return {
        acquisition_source:            'referral',
        acquisition_source_raw:        sourceRaw,
        acquisition_utm:               utmJsonb,
        acquisition_referrer_fleet_id: referrerId,
      };
    }
    // Fall through if ref didn't resolve — invalid token, treat as if
    // no ref was supplied. The raw value lands in acquisition_utm so
    // ops can spot the broken share link in forensics.
  }

  const source = (cleanUtm.utm_source ?? '').toLowerCase();
  const medium = (cleanUtm.utm_medium ?? '').toLowerCase();

  // 2-3. Paid splits.
  if (medium && PAID_MEDIUMS.has(medium)) {
    if (source && SOCIAL_SOURCES.has(source)) {
      return baseAcquisition('paid_social', sourceRaw, utmJsonb);
    }
    return baseAcquisition('paid_search', sourceRaw, utmJsonb);
  }

  // 4. Partner.
  if (source && PARTNER_SOURCES.has(source)) {
    return baseAcquisition('partner', sourceRaw, utmJsonb);
  }

  // 5. Catch-all UTM source.
  if (source) {
    return baseAcquisition('other', sourceRaw, utmJsonb);
  }

  // 6. Default — no signal at all.
  return baseAcquisition('direct', null, utmJsonb);
}

function baseAcquisition(
  bucket: string,
  sourceRaw: string | null,
  utm: Record<string, unknown> | null,
): AcquisitionFields {
  return {
    acquisition_source:            bucket,
    acquisition_source_raw:        sourceRaw,
    acquisition_utm:               utm,
    acquisition_referrer_fleet_id: null,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err("Method not allowed", 405);

  let email: string, password: string, fleet_name: string;
  // Optional. The Auth screen reads i18n.language at submit time and passes
  // it through so first-time customers don't have to re-toggle the
  // LanguageSwitcher post-login to "lock in" their reminder language.
  // Phase 1.8.1.
  let preferred_language: string | null | undefined;
  // Optional acquisition payload — URL params captured by the client at
  // signup time. We classify server-side into the closed bucket enum the
  // fleets CHECK enforces. Phase 4.1.
  let acquisition: AcquisitionInput | null | undefined;
  try {
    ({ email, password, fleet_name, preferred_language, acquisition } =
      await req.json());
  } catch {
    return err("Invalid JSON body");
  }

  if (!email || !password || !fleet_name) {
    return err("email, password, and fleet_name are required");
  }

  // Whitelist the language value before it lands in the DB. Anything outside
  // the supported set falls back to NULL (= "no opinion expressed", same as
  // the existing-fleet default). Defensive against a malformed client header
  // or a future locale we haven't added yet.
  const SUPPORTED_LANGUAGES = ['en', 'ta'] as const;
  const normalizedLanguage =
    typeof preferred_language === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(preferred_language)
      ? preferred_language
      : null;

  // Service-role client — bypasses RLS for admin operations
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const normalizedEmail = email.trim().toLowerCase();

  // ── Anon client — used for sign-in steps ────────────────────────────────────
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);

  // Resolve acquisition fields once — we'll write them on the fleet row
  // whether this is a new auth user or a re-create-after-deletion case.
  // Failure inside the classifier (e.g. flaky DB lookup for ref token)
  // throws — we'd rather hard-fail signup than write a half-attributed row.
  const acquisitionFields = await classifyAcquisition(adminClient, acquisition);

  // ── Helper: create fleet + subscription for a known user ID ─────────────────
  // Returns { ok: true } on success — the client signs in independently.
  async function createFleetForUser(userId: string): Promise<Response> {
    const { data: newFleet, error: fleetError } = await adminClient
      .from("fleets")
      .insert({
        name:                fleet_name.trim(),
        organization:        fleet_name.trim(),
        manager_id:          userId,
        preferred_language:  normalizedLanguage,
        ...acquisitionFields,
      })
      .select("id")
      .single();

    if (fleetError || !newFleet) {
      return err(`Fleet creation failed: ${fleetError?.message ?? "unknown"}`, 500);
    }

    await adminClient.from("subscriptions").upsert(
      {
        fleet_id:      newFleet.id,
        plan:          "trial",
        status:        "trial",
        max_vehicles:  2,
        max_drivers:   3,
        trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      { onConflict: "fleet_id", ignoreDuplicates: true }
    );

    // Return ok — the client will call signInWithPassword to establish the session.
    // Returning a server-side session and using setSession() on the client is
    // unreliable (onAuthStateChange doesn't always fire); a client-side signIn
    // is the single reliable path that loads the dashboard.
    return json({ ok: true });
  }

  // 1. Create the auth user, marking the email as confirmed so they can
  //    sign in immediately without needing an email confirmation link.
  const { data: { user }, error: createError } =
    await adminClient.auth.admin.createUser({
      email:         normalizedEmail,
      password,
      email_confirm: true,
    });

  if (createError) {
    if (createError.message.toLowerCase().includes("already")) {
      // The auth account exists — likely because the user previously deleted their
      // fleet but the auth.users row was kept.  Verify credentials by signing in:
      //   - If sign-in succeeds AND the user has no fleet  → create a new fleet
      //   - If sign-in succeeds AND the user has a fleet   → genuine conflict
      //   - If sign-in fails (wrong password)              → reject cleanly
      const { data: existingSignIn, error: signInErr } =
        await anonClient.auth.signInWithPassword({ email: normalizedEmail, password });

      if (signInErr || !existingSignIn?.user || !existingSignIn.session) {
        // Wrong password or other auth error — do not reveal details
        return err("An account with this email already exists. Please log in.", 409);
      }

      // Check whether this account still has a fleet
      const { data: existingFleet } = await adminClient
        .from("fleets")
        .select("id")
        .eq("manager_id", existingSignIn.user.id)
        .maybeSingle();

      if (existingFleet) {
        // Account has an active fleet — tell them to log in normally
        return err("An account with this email already exists. Please log in.", 409);
      }

      // No fleet — create one. Client will sign in with signInWithPassword.
      return createFleetForUser(existingSignIn.user.id);
    }
    return err(createError.message, 400);
  }

  if (!user) return err("Failed to create user account", 500);

  // Create fleet. If that fails, roll back the auth user.
  const fleetResponse = await createFleetForUser(user.id);
  if (!fleetResponse.ok) {
    await adminClient.auth.admin.deleteUser(user.id);
  }
  return fleetResponse;
});
