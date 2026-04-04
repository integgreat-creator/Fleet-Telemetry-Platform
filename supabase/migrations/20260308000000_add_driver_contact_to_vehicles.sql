-- Add driver contact info to vehicles table
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS driver_phone text;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS driver_email text;

-- Ensure RLS allows inserting fleet_id
-- The existing policy for INSERT is:
-- CREATE POLICY "Users can create their own vehicles"
--   ON vehicles FOR INSERT
--   TO authenticated
--   WITH CHECK (owner_id = auth.uid());
-- This is fine, but we might want to ensure they can only assign to fleets they manage.

-- We'll add a helper function to send invitations (mock for now, could be integrated with Twilio/messagebird)
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE,
  phone text NOT NULL,
  fleet_id uuid REFERENCES fleets(id),
  sent_at timestamptz DEFAULT now()
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers can view invitations for their fleets" ON invitations
  FOR SELECT TO authenticated USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );
