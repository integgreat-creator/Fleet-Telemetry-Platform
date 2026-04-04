# Vehicle Telemetry Platform - Technical Overview

## System Architecture

The platform is a multi-layered ecosystem designed for high-frequency data ingestion and autonomous analysis.

### 1. Data Ingestion Layer
- **Mobile App (Flutter):** Direct Bluetooth interface for drivers and field technicians. Supports 18 unique PIDs.
- **Telemetry Engine (Python):** Robust bridge for desktop/embedded systems using `python-obd`.
- **Web Simulator (React):** Built-in simulation for testing 18 sensors without physical hardware.

### 2. Processing & Storage Layer (Supabase)
- **PostgreSQL:** Time-series optimized storage for sensor data.
- **Edge Functions:** Serverless logic for CRUD operations and intelligence.
- **Realtime:** WebSocket layer for sub-100ms UI updates.

### 3. Intelligence Layer (Fleet Intelligence)
- **Trip Detection:** Analyzes speed vectors to identify start/stop events.
- **Driver Scoring:** Deductive scoring engine based on harsh braking, acceleration, and speeding.
- **Autonomous Insights:** Identifies cost-saving opportunities like "Idle Waste" (fuel consumed while stationary).

---

## Component Deep Dive

### Web Dashboard
- **React 18** with **TypeScript** for type-safe UI development.
- **Vite** for optimized HMR and builds.
- **Tailwind CSS** for a responsive, modern dark-themed interface.
- **Dynamic Sensor Rendering:** Automatically renders cards for any of the 18 supported sensors received via telemetry or simulation.

### Mobile Application
- **Flutter** for cross-platform performance.
- **Syncfusion Gauges** for high-fidelity real-time visualizations.
- **Bluetooth OBD-II:** Support for ELM327 protocol (Mode 01 PIDs).
- **Push Notifications:** Immediate alerts for threshold violations.

### Telemetry Engine (Python)
- **PID Discovery:** Dynamic detection of supported vehicle sensors.
- **Polling Strategy:** Dual-frequency polling (1s for high-priority like RPM/Speed, 5s for low-priority).

---

## Supported Sensors (18 Total)

1.  **Engine RPM**
2.  **Vehicle Speed**
3.  **Coolant Temperature**
4.  **Fuel Level**
5.  **Battery Voltage**
6.  **Throttle Position**
7.  **Intake Air Temperature**
8.  **Engine Load**
9.  **MAF (Mass Air Flow)**
10. **Timing Advance**
11. **Short-Term Fuel Trim**
12. **Long-Term Fuel Trim**
13. **Manifold Pressure**
14. **Fuel Pressure**
15. **Distance Since MIL**
16. **Engine Runtime**
17. **Control Module Voltage**
18. **Ambient Temperature**

---

## Data Schema Highlights

- **`sensor_data`**: Stores both individual readings and batch JSONB payloads.
- **`driver_behavior`**: Historical log of events (harsh braking, etc.) per trip.
- **`cost_insights`**: Actionable recommendations for fleet efficiency.
- **`thresholds`**: Per-vehicle configuration for the alert engine.

---

## Security Model

- **JWT Authentication**: Secured by Supabase Auth.
- **Row Level Security (RLS)**: Fine-grained access control ensuring data privacy between fleet owners.
- **Service Role Processing**: Backend intelligence functions use `service_role` keys to process data across the platform securely.

---

## Scalability & Performance

- **WebSocket Streaming**: Eliminates polling overhead for live dashboards.
- **Database Indexing**: Optimized for time-series range queries (timestamps + vehicle IDs).
- **Edge Scaling**: Functions scale horizontally to handle thousands of concurrent telemetry streams.
