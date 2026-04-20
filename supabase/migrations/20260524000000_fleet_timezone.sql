-- ─────────────────────────────────────────────────────────────────────────────
-- L2: Add per-fleet timezone so WhatsApp alert timestamps are localised to
--     the fleet's operating region rather than hardcoded to Asia/Kolkata.
--
-- Defaults to 'Asia/Kolkata' so existing fleets are unchanged.
-- Accepts any IANA timezone string (e.g. 'America/New_York', 'Europe/London').
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata';
