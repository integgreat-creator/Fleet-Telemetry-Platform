# Quick Start Guide - Vehicle Telemetry Platform

## Getting Started in 5 Minutes

Follow these steps to access and use the Fleet Management Dashboard. This guide covers the Web interface, which acts as the central hub for your fleet.

---

## Step 1: Start the Web Dashboard

Open a terminal in the project root directory and run:

```bash
npm run dev
```

Navigate to `http://localhost:5173` in your browser.

---

## Step 2: Create an Account

1. Click **"Sign Up"**.
2. Enter your email and a password (minimum 6 characters).
3. Click **"Sign Up"** to enter the Fleet Overview.

---

## Step 3: Add Your First Vehicle

1. Navigate to the **"Vehicles"** page.
2. Click **"Add Vehicle"**.
3. Enter details (e.g., Name: `Fleet Unit 01`, VIN, Make, Model).
4. Click **"Add Vehicle"**.

---

## Step 4: Choose Your Data Source

The platform supports three ways to get data into the system:

### A. Built-in Simulator (Easiest for Testing)
1. Click on your vehicle card.
2. Click **"Start Simulation"**.
3. Watch the dashboard populate with live, simulated sensor data.

### B. Mobile App (For Field Use)
1. Set up the Flutter app in `mobile_app/`.
2. Connect your phone to an ELM327 Bluetooth adapter in a vehicle.
3. Your data will sync to this dashboard in real-time.

### C. Telemetry Engine (For Embedded Systems)
1. Run the Python service in `telemetry_engine/`.
2. Connect a PC/Raspberry Pi to an OBD-II adapter.
3. Data streams directly to the cloud backend.

---

## Step 5: Monitor Alerts & Analytics

1. **Alerts:** Navigate to the **Alerts** page to see threshold violations (e.g., Speed > 120km/h). Acknowledge them to clear the feed.
2. **Analytics:** Visit the **Analytics** page to see your **Driver Score**, harsh driving events, and **Cost Insights** (like fuel waste from idling).
3. **Intelligence:** The platform automatically detects **Trips**. Check the vehicle details after a simulation/drive to see trip history.

---

## Next Steps

- **Mobile Setup:** See [MOBILE_APP_QUICK_START.md](./MOBILE_APP_QUICK_START.md).
- **Advanced Features:** Explore [PLATFORM_OVERVIEW.md](./PLATFORM_OVERVIEW.md).
- **API Integration:** Read [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).

---

**Enjoy monitoring your fleet!** 🚗📊
