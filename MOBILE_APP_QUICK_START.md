# Mobile App Quick Start Guide

Get your Flutter mobile app running and connected to your vehicle in minutes.

## Prerequisites

- [Flutter SDK](https://docs.flutter.dev/get-started/install) (v3.0.0+)
- Android Studio / Xcode
- A physical Android or iOS device (Emulators do not support Bluetooth)
- ELM327 Bluetooth OBD-II Adapter

---

## 1. Environment Setup

The mobile app requires connectivity to the Supabase backend. Copy the `.env` file from the root project to the `mobile_app` directory:

```bash
cp .env mobile_app/.env
```

Ensure it contains:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## 2. Install Dependencies

Navigate to the mobile app directory and fetch the required packages:

```bash
cd mobile_app
flutter pub get
```

## 3. Run the Application

Connect your physical device via USB and run:

```bash
flutter run
```

## 4. Connecting to your Vehicle

1. **Plug in Adapter:** Connect the ELM327 adapter to your vehicle's OBD-II port.
2. **Ignition:** Turn the vehicle ignition to 'ON' (engine start recommended for full data).
3. **Login:** Use your Fleet Telemetry credentials or sign up in the app.
4. **Scan:** Tap **"Connect OBD-II"** on the dashboard.
5. **Select Device:** Choose your adapter (e.g., "OBDII") from the scan results.
6. **Monitor:** Once the status shows "Connected", live sensor data will begin streaming to your dashboard.

---

## Troubleshooting Quick Tips

- **Bluetooth permissions:** Ensure the app has "Nearby Devices" (Android 12+) or "Bluetooth" (iOS) permissions enabled.
- **Location services:** Android requires Location to be ON for Bluetooth scanning.
- **"No Data":** If the dashboard is empty while connected, verify that your vehicle is OBD-II compliant and the engine is running.

For a detailed guide, see **[MOBILE_APP_GUIDE.md](./MOBILE_APP_GUIDE.md)**.
