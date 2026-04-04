package com.example.vehicle_telemetry.channels

import android.content.Context
import com.example.vehicle_telemetry.bluetooth.BluetoothService
import com.example.vehicle_telemetry.obd.OBDCommandEngine
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class OBDChannelHandler(messenger: BinaryMessenger, context: Context) : MethodChannel.MethodCallHandler {
    private val methodChannel = MethodChannel(messenger, "obd_channel")
    private val eventChannel = EventChannel(messenger, "obd_event_channel")
    
    private var eventSink: EventChannel.EventSink? = null
    private val bluetoothService: BluetoothService
    private val obdEngine: OBDCommandEngine

    init {
        methodChannel.setMethodCallHandler(this)
        
        bluetoothService = BluetoothService(
            context = context,
            onDataReceived = { data -> obdEngine.handleResponse(data) },
            onStatusChanged = { status ->
                sendEvent(mapOf("type" to "status", "value" to status))
            }
        )

        obdEngine = OBDCommandEngine(
            bluetoothService = bluetoothService,
            onBatchResult = { batch ->
                sendEvent(mapOf("type" to "sensor_batch", "data" to batch.toString()))
            },
            onVinRead = { vin ->
                // Send VIN to Flutter via the existing EventChannel.
                // vin is null when the vehicle doesn't support Mode 09 or timed out.
                sendEvent(mapOf("type" to "vin", "value" to (vin ?: "")))
            }
        )

        eventChannel.setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                eventSink = events
            }
            override fun onCancel(arguments: Any?) {
                eventSink = null
            }
        })
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getAvailableDevices" -> {
                bluetoothService.startDiscovery { devices ->
                    // Since startDiscovery is async, we send the first set of results
                    // and keep updating via EventChannel if needed, 
                    // but for this method call we'll return what we have immediately
                    result.success(devices)
                }
            }
            "connectAdapter" -> {
                val address = call.argument<String>("address")
                if (address != null) {
                    bluetoothService.connect(address)
                    result.success(true)
                } else {
                    result.error("INVALID_ADDRESS", "Address is required", null)
                }
            }
            "disconnectAdapter" -> {
                bluetoothService.disconnect()
                result.success(true)
            }
            "startSensorPolling" -> {
                obdEngine.start()
                result.success(true)
            }
            "stopSensorPolling" -> {
                obdEngine.stop()
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    private fun sendEvent(data: Any) {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            eventSink?.success(data)
        }
    }
}
