# Vehicle Telemetry Mobile App Guide

Complete guide for the Flutter mobile application with Bluetooth OBD-II connectivity.

## Overview

The Vehicle Telemetry mobile app provides real-time vehicle monitoring via Bluetooth Low Energy (BLE) or Classic Bluetooth (depending on the adapter) using an ELM327 interface. Connect your phone directly to your vehicle's diagnostic port and monitor critical engine parameters in real-time.

## Key Features

### 1. Bluetooth OBD-II Connection
- Scan and discover Bluetooth OBD-II adapters.
- Powered by `flutter_blue_plus` for robust device communication.
- Automatic initialization of ELM327 protocols.
- Real-time connection status monitoring.

### 2. Live Sensor Dashboard
Monitor a wide range of vehicle sensors (up to 18 supported PIDs):
- **Core Sensors:** Engine RPM, Vehicle Speed, Coolant Temp, Fuel Level, Battery Voltage, Throttle Position, Intake Air Temp, Engine Load.
- **Advanced Diagnostics:** MAF Rate, Timing Advance, Short/Long Term Fuel Trims, Manifold Pressure, Fuel Pressure, Distance since MIL, Engine Runtime, Ambient Temp.

Data is visualized using high-fidelity gauges from the Syncfusion library.

### 3. Smart Alerts
- **Custom Thresholds:** Configure min/max alerts per vehicle.
- **Push Notifications:** Powered by `flutter_local_notifications` for immediate feedback even when the app is in the background.
- **Visual Cues:** Dynamic color changes on dashboard gauges when thresholds are breached.

### 4. Vehicle & Fleet Sync
- **Cloud Profiles:** All vehicles are synced with the Supabase backend.
- **Multi-Vehicle Support:** Seamlessly switch between different vehicles in your fleet.
- **Threshold Sync:** Alert settings are stored in the cloud and applied across devices.

---

## Hardware Requirements

### Supported OBD-II Adapters
- ELM327 Bluetooth (v1.5 or v2.1 recommended).
- Compatible with most OBD-II compliant vehicles (generally 1996+ for US, 2001+ for EU).

### Mobile Device Requirements
- **Android:** API 21+ (Android 5.0). Requires Bluetooth and Location permissions (for scanning).
- **iOS:** iOS 12.0+. Requires Bluetooth permissions.

---

## Installation & Setup

1. **Environment Config:**
   Ensure a `.env` file exists in the `mobile_app/` directory with:
   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   ```

2. **Build and Run:**
   ```bash
   cd mobile_app
   flutter pub get
   flutter run
   ```

---

## Usage Guide

### Connecting to your Vehicle
1. Plug the ELM327 adapter into the OBD-II port (usually under the steering wheel).
2. Turn the ignition to 'ON' or start the engine.
3. Open the app and navigate to **Connect OBD-II**.
4. Select your device from the list (usually named "OBDII", "ELM327", or similar).
5. Once connected, the dashboard will automatically start polling data.

### Configuring Thresholds
1. Go to the **Vehicle Details** or **Threshold Config** screen.
2. Select the sensor you wish to monitor.
3. Set your custom Minimum and Maximum values.
4. Enable the alert toggle.
5. Save. The app will now trigger notifications if these limits are hit.

---

## Technical Architecture

### OBD-II Protocol Implementation
The app uses standard Mode 01 PIDs to request data. The `OBDService` handles command queuing and response parsing:
- **RPM (010C):** `((A*256)+B)/4`
- **Speed (010D):** `A`
- **Coolant Temp (0105):** `A-40`

### State Management
The application uses the **Provider** pattern:
- `AuthProvider`: Manages user sessions.
- `VehicleProvider`: Handles vehicle list and selection.
- `SensorProvider`: Streams live data from the OBD service to the UI.

---

## Troubleshooting

- **No Data Appearing:** Ensure the ignition is on. Some adapters require the engine to be running to report certain PIDs.
- **Bluetooth Scanning Fails:** Check that Location services are enabled (required by Android for Bluetooth scanning).
- **"No Data" for specific sensors:** Not all vehicles support all PIDs. The app will gracefully skip unsupported sensors.

---

**Built for drivers and fleet managers who need reliable, real-time vehicle data.**
