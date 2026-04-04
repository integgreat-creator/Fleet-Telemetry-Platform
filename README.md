# Vehicle Telemetry & Fleet Management Platform

A comprehensive, production-ready fleet management and vehicle telemetry platform. This multi-platform solution provides real-time sensor monitoring, threshold-based alerts, driver behavior analytics, and autonomous cost insights using a unified cloud backend.

## Platform Components

### 1. Web Dashboard (React)
A sophisticated administrative interface for fleet managers to monitor all vehicles, analyze driver behavior, and manage fleet-wide settings.
- **Location:** Root directory
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Lucide React

### 2. Mobile Application (Flutter)
A full-featured mobile app designed for field use, connecting directly to vehicles via Bluetooth OBD-II.
- **Location:** `mobile_app/`
- **Stack:** Flutter, Dart, Supabase Flutter, Flutter Blue Plus, Syncfusion Gauges

### 3. Telemetry Engine (Python)
A high-performance bridge for desktop or embedded systems to interface with ELM327 adapters and stream data directly to the cloud.
- **Location:** `telemetry_engine/`
- **Stack:** Python, python-obd, Requests

### 4. Cloud Backend (Supabase)
A unified backend-as-a-service providing authentication, real-time database, and serverless logic.
- **Stack:** PostgreSQL, Supabase Edge Functions (Deno), JWT Auth, Realtime WebSockets

---

## Core Features

### Real-time Sensor Monitoring
Monitor 18 critical vehicle metrics with sub-second latency:
- **Engine Performance:** RPM, Speed, Engine Load, Throttle Position, MAF, Timing Advance.
- **Fluid & Temp:** Coolant Temp, Fuel Level, Intake Air Temp, Ambient Temp.
- **Electrical:** Battery Voltage, Control Module Voltage.
- **Diagnostics:** Short/Long Term Fuel Trims, Manifold Pressure, Fuel Pressure, Distance since MIL, Engine Runtime.

### Fleet Intelligence
Autonomous analytics driven by serverless edge functions:
- **Trip Detection:** Automatic detection of trip starts and ends based on telemetry.
- **Driver Scoring:** 0-100 score based on harsh braking, acceleration, and speeding.
- **Cost Insights:** Autonomous identification of "idle waste" and potential fuel savings.

### Threshold-Based Alerts
- Configurable thresholds (Min/Max) per vehicle and sensor.
- Real-time push notifications (Mobile) and dashboard alerts (Web).
- Three severity levels: Info, Warning, Critical.

### Predictive Maintenance
- AI-based component failure prediction.
- Maintenance scheduling recommendations based on engine load patterns and runtime.

---

## Quick Start

### 1. Web Dashboard
```bash
npm install
npm run dev
```
Access at `http://localhost:5173`

### 2. Mobile App
```bash
cd mobile_app
flutter pub get
flutter run
```

### 3. Telemetry Engine (Python)
```bash
cd telemetry_engine
pip install -r requirements.txt # (Create this if needed: obd, requests)
python telemetry_service.py
```

---

## Documentation Index

- **[QUICK_START.md](./QUICK_START.md)** - 5-minute guide to the web dashboard.
- **[MOBILE_APP_QUICK_START.md](./MOBILE_APP_QUICK_START.md)** - Quick setup for Flutter developers.
- **[PLATFORM_OVERVIEW.md](./PLATFORM_OVERVIEW.md)** - Technical architecture and feature deep-dive.
- **[API_DOCUMENTATION.md](./API_DOCUMENTATION.md)** - Complete REST API and Edge Function reference.
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Production deployment guide for Web and Backend.
- **[MOBILE_APP_GUIDE.md](./MOBILE_APP_GUIDE.md)** - Comprehensive user guide for the mobile app.
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - Solutions for common issues across all components.
- **[PLATFORM_SUMMARY.md](./PLATFORM_SUMMARY.md)** - Executive summary of the platform capabilities.

---

## Security

The platform implements enterprise-grade security:
- **Authentication:** Supabase Auth with JWT.
- **Authorization:** Row Level Security (RLS) ensures users only access their own fleet data.
- **Data Protection:** HTTPS/WSS encryption for all data in transit.

## Future Roadmap

- **Geofencing:** Real-time location tracking and zone alerts.
- **Offline Mode:** Local data caching in mobile app for remote areas.
- **Advanced Diagnostics:** Support for Mode 03 (DTC) reading and clearing.
- **Multi-tenant Support:** Advanced organizational structures for large enterprises.

---

**Built with modern technologies for the future of fleet management.**
