# Vehicle Telemetry Platform - Deployment Guide

## Overview

This guide covers deploying the complete Vehicle Telemetry Platform including the web dashboard, mobile app, and backend infrastructure.

---

## Prerequisites

- Supabase account (configured with project ID and keys)
- Node.js 18+ installed
- Flutter SDK (for mobile app)
- Python 3.9+ (for telemetry engine)
- Git installed

---

## Backend Deployment (Supabase)

### 1. Database Schema
Ensure all migrations in `supabase/migrations/` are applied to your project. This includes:
- Core telemetry schema (vehicles, sensor_data, etc.)
- Security and performance optimizations.
- Fleet and cost intelligence tables.

### 2. Edge Functions
Deploy all functions in `supabase/functions/` using the Supabase CLI:
```bash
supabase functions deploy vehicle-api
supabase functions deploy sensor-api
supabase functions deploy threshold-api
supabase functions deploy alert-api
supabase functions deploy fleet-intelligence
```

### 3. Environment Variables
Set the following secrets in Supabase:
```bash
supabase secrets set SERVICE_ROLE_KEY=your_service_role_key
```

---

## Web Dashboard Deployment

### Vercel / Netlify (Recommended)
1. Connect your repository to the platform.
2. Set environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Build Command: `npm run build`
4. Output Directory: `dist`

### Docker (Self-Hosted)
A Dockerfile is provided in the project root for containerized deployment.
```bash
docker build -t vehicle-telemetry-web .
docker run -p 80:80 -e VITE_SUPABASE_URL=... vehicle-telemetry-web
```

---

## Mobile App Deployment (Flutter)

### Android
1. Configure `android/key.properties` for signing.
2. Build Release APK:
```bash
flutter build apk --release
```

### iOS
1. Open `ios/Runner.xcworkspace` in Xcode.
2. Configure "Signing & Capabilities".
3. Build Archive:
```bash
flutter build ios --release
```

---

## Telemetry Engine Deployment (Python)

For deployment on embedded systems (e.g., Raspberry Pi):
1. Install dependencies: `pip install -r requirements.txt`
2. Configure environment variables for Supabase URL and Key.
3. Run as a system service:
```bash
python telemetry_service.py
```

---

## Post-Deployment Checklist

- [ ] Verify Row Level Security (RLS) is enabled on all tables.
- [ ] Test real-time WebSocket connectivity on both Web and Mobile.
- [ ] Confirm `fleet-intelligence` function is processing trips and scores.
- [ ] Verify SSL/HTTPS is active on all endpoints.
