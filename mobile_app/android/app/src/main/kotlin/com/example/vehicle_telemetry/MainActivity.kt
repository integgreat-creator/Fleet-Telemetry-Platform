package com.example.vehicle_telemetry

import com.example.vehicle_telemetry.channels.OBDChannelHandler
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        OBDChannelHandler(flutterEngine.dartExecutor.binaryMessenger, this)
    }
}
