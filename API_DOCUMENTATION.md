# Vehicle Telemetry Platform - API Documentation

## Overview

The Vehicle Telemetry Platform provides REST API endpoints for managing vehicles, sensor data, thresholds, and alerts. It also includes autonomous fleet intelligence for trip detection and driver scoring.

## Base URL

```
https://[your-project-id].supabase.co/functions/v1
```

## Authentication

All API requests must include the following headers:

```
Authorization: Bearer [SUPABASE_ANON_KEY]
```

For authenticated requests, include the user's session token:

```
Authorization: Bearer [USER_SESSION_TOKEN]
```

---

## Vehicle API

### Create Vehicle
**Endpoint:** `POST /vehicle-api`
**Body:** `{ "name": "...", "vin": "...", "make": "...", "model": "...", "year": 2024 }`

### Get All Vehicles
**Endpoint:** `GET /vehicle-api`

### Get Vehicle by ID
**Endpoint:** `GET /vehicle-api/{vehicle_id}`

---

## Sensor Data API

### Submit Sensor Reading
**Endpoint:** `POST /sensor-api`
**Body:** 
```json
{
  "vehicle_id": "uuid",
  "sensor_type": "rpm",
  "value": 2500,
  "unit": "RPM",
  "timestamp": "ISO-8601"
}
```

**Supported Sensor Types:**
- `rpm`, `speed`, `coolant_temperature`, `fuel_level`, `battery_voltage`, `throttle_position`, `intake_air_temperature`, `engine_load`
- `maf`, `timing_advance`, `short_fuel_trim`, `long_fuel_trim`, `manifold_pressure`, `fuel_pressure`, `distance_since_mil`, `engine_runtime`, `control_module_voltage`, `ambient_temperature`

### Get Sensor History
**Endpoint:** `GET /sensor-api?vehicle_id=uuid&sensor_type=rpm&limit=100`

---

## Threshold API

### Create/Update Threshold
**Endpoint:** `POST /threshold-api`
**Body:** `{ "vehicle_id": "uuid", "sensor_type": "rpm", "min_value": 600, "max_value": 3000, "alert_enabled": true }`

---

## Alert API

### Get Alerts
**Endpoint:** `GET /alert-api?vehicle_id=uuid&acknowledged=false`

### Acknowledge Alert
**Endpoint:** `PUT /alert-api/{alert_id}`
**Body:** `{ "acknowledged": true }`

---

## Fleet Intelligence API (Autonomous)

These endpoints are typically triggered by a scheduler or background worker.

### Detect Trips
**Endpoint:** `GET /fleet-intelligence?action=detect-trips`
**Description:** Processes recent telemetry to identify trip start/end events.

### Calculate Driver Scores
**Endpoint:** `GET /fleet-intelligence?action=calculate-scores`
**Description:** Updates driver behavior scores based on harsh events and speeding.

### Generate Cost Insights
**Endpoint:** `GET /fleet-intelligence?action=generate-insights`
**Description:** Analyzes idle time and fuel waste to provide potential savings recommendations.

---

## Real-time Subscriptions (Supabase Realtime)

### Sensor Data
```javascript
supabase.channel('sensor_data')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sensor_data' }, payload => { ... })
  .subscribe();
```

---

## Best Practices

1. **Batching:** Use the Python Telemetry Engine or Mobile App to batch high-frequency sensor readings before submission.
2. **Real-time:** Prefer WebSockets for live dashboard updates to reduce API overhead.
3. **Caching:** Cache vehicle metadata on the client to avoid redundant API calls.
