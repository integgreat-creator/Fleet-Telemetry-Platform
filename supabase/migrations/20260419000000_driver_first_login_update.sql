-- ─────────────────────────────────────────────────────────────────────────────
-- Allow drivers to stamp their own first_login_at timestamp.
--
-- The mobile app calls this UPDATE in AuthProvider._loadDriverAccount() on
-- every sign-in. Without this policy the UPDATE is silently rejected by RLS,
-- leaving first_login_at = NULL forever and the web dashboard showing
-- "Awaiting first login" even for active drivers.
--
-- The policy is intentionally narrow:
--   • Only the driver who owns the row can update it (user_id = auth.uid())
--   • Only the first_login_at column is updated (the app never touches others)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "drivers_stamp_first_login"
  ON driver_accounts
  FOR UPDATE
  TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
