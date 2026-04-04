# Vehicle Telemetry Mobile App

A Flutter mobile application for real-time vehicle monitoring via Bluetooth OBD-II connection.

## Features

- 🚗 **Bluetooth OBD-II Connection** - Connect to ELM327 adapters
- 📊 **Live Sensor Dashboard** - Real-time vehicle metrics with gauges
- ⚠️ **Smart Alerts** - Customizable thresholds with push notifications
- 🔧 **Vehicle Profiles** - Manage multiple vehicles
- 📡 **Cloud Sync** - Data synchronized with Supabase backend
- 🔄 **Auto-Reconnect** - Automatic Bluetooth reconnection

## Prerequisites

- Flutter SDK 3.0.0 or higher
- Android Studio / Xcode
- ELM327 Bluetooth OBD-II adapter
- Active Supabase project (already configured in this workspace)

## Setup

### 1. Install Flutter

Follow the official Flutter installation guide:
https://docs.flutter.dev/get-started/install

### 2. Install Dependencies

```bash
cd mobile_app
flutter pub get
```

### 3. Configure Environment

Create a `.env` file in the `mobile_app` directory:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
```

Or copy from the root project:

```bash
cp ../.env .env
```

### 4. Android Configuration

Add permissions to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.INTERNET" />
```

Update `android/app/build.gradle`:

```gradle
android {
    compileSdkVersion 34

    defaultConfig {
        minSdkVersion 21
        targetSdkVersion 34
    }
}
```

### 5. iOS Configuration

Add to `ios/Runner/Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app needs Bluetooth to connect to OBD-II adapter</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>This app needs Bluetooth to connect to OBD-II adapter</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>This app needs location for Bluetooth scanning</string>
```

## Running the App

### Android

```bash
flutter run
```

### iOS

```bash
cd ios
pod install
cd ..
flutter run
```

### Release Build

**Android APK:**
```bash
flutter build apk --release
```

**iOS:**
```bash
flutter build ios --release
```

## OBD-II Connection

### Supported Adapters

- ELM327 Bluetooth (v1.5 or higher recommended)
- Compatible OBD-II adapters using ELM327 protocol

### Connection Steps

1. Plug OBD-II adapter into vehicle's diagnostic port
2. Turn on vehicle ignition
3. Open app and tap "Connect to OBD-II"
4. Select your adapter from the list (usually named "OBDII" or "ELM327")
5. Wait for connection confirmation
6. Start monitoring live sensor data

### Supported Sensors

- Engine RPM
- Vehicle Speed (km/h)
- Coolant Temperature (°C)
- Fuel Level (%)
- Battery Voltage (V)
- Throttle Position (%)
- Intake Air Temperature (°C)
- Engine Load (%)

## Usage

### 1. First Time Setup

- Create account or login with Supabase credentials
- Add your first vehicle profile (name, VIN, make, model)

### 2. Connect to Vehicle

- Ensure OBD-II adapter is plugged in
- Tap "Connect" and select your Bluetooth device
- Wait for connection confirmation

### 3. Monitor Sensors

- View live sensor data on dashboard
- Data updates every 1 second
- Gauges show current values and normal ranges

### 4. Configure Alerts

- Tap on any sensor card
- Set custom threshold values
- Enable/disable alerts per sensor
- Receive push notifications when thresholds exceeded

### 5. Manage Vehicles

- Add multiple vehicle profiles
- Switch between vehicles
- Each vehicle maintains its own threshold settings

## Architecture

```
mobile_app/
├── lib/
│   ├── main.dart                 # App entry point
│   ├── config/
│   │   └── supabase_config.dart  # Supabase configuration
│   ├── models/
│   │   ├── vehicle.dart          # Vehicle model
│   │   ├── sensor_data.dart      # Sensor data model
│   │   └── threshold.dart        # Threshold model
│   ├── services/
│   │   ├── bluetooth_service.dart    # Bluetooth OBD-II
│   │   ├── obd_service.dart          # OBD-II protocol
│   │   ├── supabase_service.dart     # Backend sync
│   │   └── notification_service.dart # Push notifications
│   ├── providers/
│   │   ├── vehicle_provider.dart     # Vehicle state
│   │   ├── sensor_provider.dart      # Sensor state
│   │   └── auth_provider.dart        # Auth state
│   ├── screens/
│   │   ├── login_screen.dart
│   │   ├── home_screen.dart
│   │   ├── dashboard_screen.dart
│   │   ├── vehicle_list_screen.dart
│   │   ├── vehicle_form_screen.dart
│   │   ├── threshold_config_screen.dart
│   │   └── bluetooth_scan_screen.dart
│   └── widgets/
│       ├── sensor_card.dart
│       ├── gauge_widget.dart
│       └── connection_status.dart
```

## Troubleshooting

### Bluetooth Connection Issues

- Ensure Bluetooth is enabled on phone
- Check OBD-II adapter is powered (vehicle ignition on)
- Try unpairing and re-pairing the device
- Some adapters require PIN: try "0000" or "1234"

### Sensor Data Not Updating

- Verify OBD-II adapter is properly connected to vehicle
- Check vehicle's OBD-II port is functioning
- Some sensors may not be supported by all vehicles

### Push Notifications Not Working

- Grant notification permissions in app settings
- Check phone's notification settings
- Ensure app is not in battery optimization mode

## License

Proprietary - All rights reserved

## Support

For issues and questions, contact your development team.
