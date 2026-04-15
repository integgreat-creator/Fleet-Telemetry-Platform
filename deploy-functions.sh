#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy-functions.sh
#
# Run this once you have a valid Supabase Personal Access Token:
#   1. Go to https://supabase.com/dashboard/account/tokens
#   2. Generate a new token (name it e.g. "FTPGo deploy")
#   3. Export it:  export SUPABASE_PAT=sbp_xxxxxxxxxxxx
#   4. Run:        bash deploy-functions.sh
# ═══════════════════════════════════════════════════════════════════════════

set -e

PROJECT_REF="wjyetgfmltupikzsypdr"

if [ -z "$SUPABASE_PAT" ]; then
  echo "ERROR: SUPABASE_PAT is not set."
  echo "  export SUPABASE_PAT=sbp_<your_token>"
  exit 1
fi

echo "→ Logging in to Supabase CLI..."
supabase login --token "$SUPABASE_PAT"

echo "→ Deploying geofence-monitor..."
supabase functions deploy geofence-monitor --project-ref "$PROJECT_REF"

echo "→ Deploying generate-predictions..."
supabase functions deploy generate-predictions --project-ref "$PROJECT_REF"

echo "→ Deploying sensor-api (updated API key auth)..."
supabase functions deploy sensor-api --project-ref "$PROJECT_REF"

echo "→ Deploying invite-api..."
supabase functions deploy invite-api --project-ref "$PROJECT_REF"

echo ""
echo "✓ All functions deployed."
echo ""
echo "NEXT: Create the Database Webhook in the Supabase Dashboard:"
echo "  Dashboard → Database → Webhooks → Create a new hook"
echo "  Name:     geofence-monitor"
echo "  Table:    vehicle_logs"
echo "  Event:    INSERT only"
echo "  Type:     Supabase Edge Functions"
echo "  Function: geofence-monitor"
