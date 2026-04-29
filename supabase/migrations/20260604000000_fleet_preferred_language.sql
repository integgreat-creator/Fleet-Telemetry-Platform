-- ════════════════════════════════════════════════════════════════════════════
-- Migration: fleets.preferred_language (Phase 1.8)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Closes the i18n loop on the out-of-app side. The in-app i18next state
-- (Phase 1.5) persists to localStorage on the client, but server-side code
-- (subscription-reminders, future email templates) had no way to know which
-- language a customer prefers. This column gives them one.
--
-- Set on:
--   1. LanguageSwitcher writes through via admin-api on every toggle.
--   2. fleet-signup edge fn captures the browser's i18next.language at the
--      moment of signup (small follow-up — this migration just adds the
--      column).
--
-- Read by:
--   - subscription-reminders/index.ts → switches copyForReminder branch
--     between en and ta. Falls back to 'en' when null (covers existing
--     fleets pre-migration and customers who never explicitly toggle).
--
-- Deliberately keeps the column nullable. Null is the "no opinion expressed"
-- sentinel and triggers the en fallback. Setting a default of 'en' would
-- mean every new row claims an explicit preference even when the customer
-- never expressed one — useful distinction for analytics later.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS preferred_language TEXT;

ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_preferred_language_supported;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_preferred_language_supported
  CHECK (preferred_language IS NULL OR preferred_language IN ('en', 'ta'));

COMMENT ON COLUMN fleets.preferred_language IS
  'Customer-chosen UI language. Server-side reminder copy (WhatsApp, email) '
  'reads this to localize. NULL means no explicit preference — code falls '
  'back to English. Updated by admin-api when LanguageSwitcher toggles.';
