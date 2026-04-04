package com.example.vehicle_telemetry

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts GPS tracking after a device reboot.
 *
 * Flutter's shared_preferences plugin writes to a SharedPreferences file
 * named "FlutterSharedPreferences" with all keys prefixed "flutter.".
 * We read that file directly to check whether a tracking session was active
 * before the device shut down.
 *
 * If a vehicle ID is found (and is not blank), we launch MainActivity so the
 * Dart side can pick up the persisted state via TrackingPersistenceService
 * and call LocationService.startTrip() again automatically.
 *
 * Registered in AndroidManifest.xml with RECEIVE_BOOT_COMPLETED permission.
 */
class TrackingBootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = context.getSharedPreferences(
            "FlutterSharedPreferences",
            Context.MODE_PRIVATE
        )

        // Flutter shared_preferences prefixes all keys with "flutter."
        val vehicleId = prefs.getString("flutter.tracking_vehicle_id", null)
        if (vehicleId.isNullOrBlank()) return

        val launch = context.packageManager
            .getLaunchIntentForPackage(context.packageName) ?: return

        launch.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
            Intent.FLAG_ACTIVITY_SINGLE_TOP or
            Intent.FLAG_ACTIVITY_CLEAR_TOP
        )
        // Extra read by HomeScreen to suppress the "connect OBD" prompt and
        // go straight to restoring GPS tracking for this vehicle.
        launch.putExtra("RESTORE_TRACKING", true)
        launch.putExtra("RESTORE_VEHICLE_ID", vehicleId)

        context.startActivity(launch)
    }
}
