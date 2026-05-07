-- ════════════════════════════════════════════════════════════════════════════
-- Migration: fleets.billing_email (Phase 3.7)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Customer can specify a separate email for invoices / receipts, distinct
-- from their auth email. Real B2B need — finance teams typically want
-- accounts@company.com on the invoice trail, not the fleet manager's
-- personal address.
--
-- Distinct from the existing customer-side fields:
--   - fleets.gstin           → tax identity (Phase 1.3.1)
--   - fleets.billing_address → invoice address line (Phase 1.3.1)
--   - fleets.state_code      → for tax intra/inter-state split
--   - fleets.billing_email   → NEW. Where to send the invoice itself.
--
-- The CHECK constraint here is intentionally permissive — full email
-- validation happens client-side and at the admin-api action; the DB
-- only blocks lengths and obviously-wrong formats so a typo (missing @)
-- doesn't silently land. We mirror the same approach we used for GSTIN:
-- DB constraint catches gross errors, app layer catches subtleties.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
--   - 20260526000000_gst_invoice_schema.sql               (gstin / billing_address)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS billing_email TEXT;

ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_billing_email_format;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_billing_email_format
  CHECK (
    billing_email IS NULL
    OR (
      char_length(billing_email) BETWEEN 6 AND 320            -- RFC 5321 hard cap
      AND billing_email LIKE '%_@_%._%'                       -- has @, has dot after
    )
  );

COMMENT ON COLUMN fleets.billing_email IS
  'Optional separate email address for invoices / receipts. NULL means '
  'fall back to the manager''s auth email when sending. The DB CHECK is '
  'a sanity gate; full RFC validation happens at admin-api / client.';
