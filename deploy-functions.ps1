# ═══════════════════════════════════════════════════════════════════════════
# deploy-functions.ps1  —  Run from PowerShell in the project root
#
# 1. Go to https://supabase.com/dashboard/account/tokens
# 2. Generate a new token (name it e.g. "FTPGo deploy")
# 3. Run this script:
#       .\deploy-functions.ps1 -Pat "sbp_xxxxxxxxxxxx"
#    OR set the env var first:
#       $env:SUPABASE_PAT = "sbp_xxxxxxxxxxxx"
#       .\deploy-functions.ps1
# ═══════════════════════════════════════════════════════════════════════════

param(
    [string]$Pat = $env:SUPABASE_PAT
)

$PROJECT_REF = "wjyetgfmltupikzsypdr"

if (-not $Pat) {
    Write-Error "PAT is required. Pass -Pat 'sbp_...' or set `$env:SUPABASE_PAT"
    exit 1
}

$env:SUPABASE_ACCESS_TOKEN = $Pat

Write-Host "-> Logging in to Supabase CLI..." -ForegroundColor Cyan
supabase login --token $Pat
if ($LASTEXITCODE -ne 0) { Write-Error "Login failed"; exit 1 }

Write-Host ""
Write-Host "-> Deploying geofence-monitor..." -ForegroundColor Cyan
supabase functions deploy geofence-monitor --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Error "geofence-monitor deploy failed"; exit 1 }

Write-Host ""
Write-Host "-> Deploying generate-predictions..." -ForegroundColor Cyan
supabase functions deploy generate-predictions --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Error "generate-predictions deploy failed"; exit 1 }

Write-Host ""
Write-Host "-> Deploying sensor-api (updated API key auth)..." -ForegroundColor Cyan
supabase functions deploy sensor-api --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Error "sensor-api deploy failed"; exit 1 }

Write-Host ""
Write-Host "-> Deploying invite-api..." -ForegroundColor Cyan
supabase functions deploy invite-api --project-ref $PROJECT_REF
if ($LASTEXITCODE -ne 0) { Write-Error "invite-api deploy failed"; exit 1 }

Write-Host ""
Write-Host "All functions deployed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "NEXT: Create the Database Webhook in the Supabase Dashboard:" -ForegroundColor Yellow
Write-Host "  Dashboard -> Database -> Webhooks -> Create a new hook"
Write-Host "  Name:     geofence-monitor"
Write-Host "  Table:    vehicle_logs"
Write-Host "  Event:    INSERT only"
Write-Host "  Type:     Supabase Edge Functions"
Write-Host "  Function: geofence-monitor"
