-- ════════════════════════════════════════════════════════════════════════════
-- Migration: fleets.acquisition_source + UTM capture (Phase 4.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Acquisition attribution for the operator dashboard. Until now every
-- fleet row was opaque about how it got here — ops couldn't answer "what
-- % of MRR comes from referrals" or "is the LinkedIn campaign worth
-- continuing." Adding four columns:
--
--   acquisition_source         — normalized enum, see CHECK below
--   acquisition_source_raw     — raw `utm_source` string for forensics
--   acquisition_utm            — full {utm_source, utm_medium, utm_campaign,
--                                       utm_content, utm_term, ref} JSONB blob
--   acquisition_referrer_fleet_id — FK to fleets, populated only when
--                                   source='referral' and the ref token
--                                   resolved to an existing fleet (Phase 4.6)
--
-- The CHECK enforces a closed enum on `acquisition_source` so operator
-- dashboards can render a stable bucket list. The raw + JSONB fields are
-- intentionally permissive — they're forensic columns, not display
-- columns. If an operator finds a UTM combination that should map to a
-- new bucket, that's a fleet-signup-side classifier change, not a
-- migration.
--
-- Backfill: every existing fleet row gets `acquisition_source = 'direct'`.
-- That's the most-conservative-honest answer — we don't know how they
-- arrived (no UTM was captured at the time), and 'direct' as a default
-- doesn't pollute later "% from referral" or "% from paid" metrics.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS acquisition_source            TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_source_raw        TEXT,
  ADD COLUMN IF NOT EXISTS acquisition_utm               JSONB,
  ADD COLUMN IF NOT EXISTS acquisition_referrer_fleet_id UUID
    REFERENCES fleets(id) ON DELETE SET NULL;

-- ── Backfill existing rows to 'direct' ──────────────────────────────────────
-- Honest fallback: anyone who signed up before this migration didn't
-- send a source, so we can't know. 'direct' is the closest match for
-- "self-initiated, no campaign attached." Bucket count for older fleets
-- skews 'direct' until we have enough post-migration cohorts to render
-- attribution with confidence.
UPDATE fleets SET acquisition_source = 'direct' WHERE acquisition_source IS NULL;

-- ── Enforce the closed enum ────────────────────────────────────────────────
-- After backfill so existing rows pass the check. NOT NULL is also
-- enforced post-backfill, which means signup must ALWAYS set this — the
-- edge function defaults to 'direct' too, so the contract is consistent.
ALTER TABLE fleets
  ALTER COLUMN acquisition_source SET NOT NULL;

ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_acquisition_source_enum;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_acquisition_source_enum
  CHECK (acquisition_source IN (
    'organic',       -- inbound, no campaign attached (e.g. SEO direct landing)
    'referral',      -- existing-customer share link (?ref=<fleet_id>)
    'paid_search',   -- utm_medium in {cpc, ppc} on search-engine sources
    'paid_social',   -- utm_medium in {cpc, ppc, paid} on social sources
    'partner',       -- utm_source matches a known partner co-marketing source
    'direct',        -- no UTM, no ref, no inbound signal — the "we don't know" bucket
    'other'          -- captured a UTM source that didn't fit any other bucket
  ));

-- ── Cross-field coherence ──────────────────────────────────────────────────
-- referrer_fleet_id is only meaningful for source='referral'. Enforcing
-- this at the DB level keeps the bucket counts honest: a row with
-- source='paid_social' AND a referrer_fleet_id would be ambiguous.
ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_acquisition_referrer_only_when_referral;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_acquisition_referrer_only_when_referral
  CHECK (
    (acquisition_source = 'referral' AND acquisition_referrer_fleet_id IS NOT NULL)
    OR
    (acquisition_source <> 'referral' AND acquisition_referrer_fleet_id IS NULL)
  );

-- Index the common operator-dashboard filter dimension.
CREATE INDEX IF NOT EXISTS idx_fleets_acquisition_source
  ON fleets(acquisition_source);

-- Index the referrer FK so "show me everyone fleet X has referred" is fast.
CREATE INDEX IF NOT EXISTS idx_fleets_acquisition_referrer_fleet_id
  ON fleets(acquisition_referrer_fleet_id)
  WHERE acquisition_referrer_fleet_id IS NOT NULL;

COMMENT ON COLUMN fleets.acquisition_source IS
  'Normalized enum bucket for how this fleet arrived. Set by '
  'fleet-signup classifier from URL params at signup. Phase 4.1.';
COMMENT ON COLUMN fleets.acquisition_source_raw IS
  'Raw utm_source string captured at signup. Forensic only — not for '
  'display.';
COMMENT ON COLUMN fleets.acquisition_utm IS
  'Full {utm_source, utm_medium, utm_campaign, utm_content, utm_term, '
  'ref} blob from signup URL params. Forensic only.';
COMMENT ON COLUMN fleets.acquisition_referrer_fleet_id IS
  'When acquisition_source=referral, the fleet whose share link drove '
  'this signup. Used by the referral credit flow (Phase 4.6) to credit '
  'the referrer on first paid charge.';
