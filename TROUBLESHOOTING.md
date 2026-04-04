# Vehicle Telemetry Platform - Troubleshooting Guide

This guide provides solutions for common issues across the Web Dashboard, Mobile App, Python Telemetry Engine, and Backend services.

---

## 🌐 Web Dashboard Issues

### Page is Blank or Won't Load
- **Cause:** Development server not running or browser cache issue.
- **Solution:** 
  1. Run `npm run dev` and ensure no errors in the terminal.
  2. Perform a hard refresh: `Ctrl + Shift + R` (Windows) or `Cmd + Shift + R` (Mac).
  3. Verify `.env` has correct `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

### "Unauthorized" or Login Fails
- **Cause:** Invalid credentials or expired session.
- **Solution:** 
  1. Clear browser cookies and site data.
  2. Check the browser console (F12) for "401 Unauthorized" errors.
  3. Ensure your password is at least 6 characters.

### No Sensor Data in Simulator
- **Cause:** Simulation not started or real-time connection failed.
- **Solution:** 
  1. Click "Start Simulation" in the vehicle details page.
  2. Check internet connection; real-time data requires WebSocket (WSS) access to Supabase.

---

## 📱 Mobile App (Flutter) Issues

### Bluetooth Device Not Found
- **Cause:** Missing permissions or Bluetooth disabled.
- **Solution:** 
  1. Ensure Bluetooth is ON and the OBD-II adapter is powered (Ignition ON).
  2. **Android:** Enable "Location" services (required for scanning) and "Nearby Devices" permissions.
  3. **iOS:** Grant Bluetooth permissions in Settings.

### Connected but "No Data"
- **Cause:** Engine not running or protocol mismatch.
- **Solution:** 
  1. Start the vehicle engine. Some PIDs only report data when the ECU is active.
  2. Ensure the adapter is a genuine ELM327 (v1.5 or v2.1).
  3. Check the "Supported Sensors" list in the app settings.

### Notifications Not Appearing
- **Cause:** Permission denied or thresholds not set.
- **Solution:** 
  1. Enable notifications for "Vehicle Telemetry" in phone settings.
  2. Verify that "Enable Alerts" is toggled ON for the specific sensor in the app.

---

## 🐍 Python Telemetry Engine Issues

### `ImportError: No module named 'obd'`
- **Solution:** Run `pip install obd requests`.

### "Failed to connect to OBD-II adapter"
- **Solution:** 
  1. Check the USB/Serial connection. 
  2. If using a serial port, specify it manually: `OBDReader(port='/dev/ttyUSB0')`.
  3. Ensure no other application (like Torque or a serial terminal) is using the port.

---

## ☁️ Backend & Intelligence Issues

### Trips Not Being Detected
- **Cause:** `fleet-intelligence` function not running or insufficient data.
- **Solution:** 
  1. Ensure the `fleet-intelligence` Edge Function is deployed.
  2. Trip detection requires speed data > 5km/h. Ensure the telemetry source is sending consistent speed readings.
  3. Check Supabase Edge Function logs for "Action not found" or processing errors.

### "Row Level Security (RLS) Violation"
- **Cause:** Missing or incorrect database policies.
- **Solution:** 
  1. Ensure migrations were applied successfully.
  2. Verify that the user owns the vehicle they are trying to monitor.

### High Latency in Real-time Updates
- **Solution:** 
  1. Check Supabase project region (should be close to your location).
  2. Batch sensor data rather than sending 10+ individual requests per second.

---

## 🛠️ General Debugging Steps

1. **Check the Logs:**
   - **Web:** Browser Console (F12).
   - **Mobile:** `flutter logs`.
   - **Backend:** Supabase Dashboard > Edge Functions > Logs.
2. **Verify Credentials:** Ensure `.env` files across all platforms are synchronized.
3. **Database Health:** Check the `sensor_data` table in Supabase. If no rows are appearing, the issue is at the ingestion source (Mobile/Python/Web).

For further assistance, please open an issue in the repository with your logs and environment details.
