package com.example.vehicle_telemetry.channels

import android.content.Context
import com.example.vehicle_telemetry.bluetooth.BleService
import com.example.vehicle_telemetry.bluetooth.BluetoothService
import com.example.vehicle_telemetry.obd.OBDCommandEngine
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class OBDChannelHandler(messenger: BinaryMessenger, context: Context) :
    MethodChannel.MethodCallHandler {

    private val methodChannel = MethodChannel(messenger, "obd_channel")
    private val eventChannel  = EventChannel(messenger, "obd_event_channel")
    private var eventSink: EventChannel.EventSink? = null

    private val classicService: BluetoothService
    private val bleService: BleService
    private val obdEngine: OBDCommandEngine

    // Populated during getAvailableDevices; consulted at connectAdapter time.
    private val deviceTypeMap = mutableMapOf<String, String>() // address → "ble"|"classic"
    private var activeBle     = false

    init {
        classicService = BluetoothService(
            context         = context,
            onDataReceived  = { data   -> obdEngine.handleResponse(data) },
            onStatusChanged = { status -> sendEvent(mapOf("type" to "status", "value" to status)) }
        )

        bleService = BleService(context).apply {
            onDataReceived  = { data   -> obdEngine.handleResponse(data) }
            onStatusChanged = { status -> sendEvent(mapOf("type" to "status", "value" to status)) }
        }

        obdEngine = OBDCommandEngine(
            writeCommand  = { cmd ->
                if (activeBle) bleService.write(cmd) else classicService.write(cmd)
            },
            onBatchResult = { batch ->
                sendEvent(mapOf("type" to "sensor_batch", "data" to batch.toString()))
            },
            onVinRead     = { vin ->
                sendEvent(mapOf("type" to "vin", "value" to (vin ?: "")))
            }
        )

        methodChannel.setMethodCallHandler(this)

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
                deviceTypeMap.clear()

                // ── BLE scan: results trickle in and are forwarded via EventChannel ──
                bleService.onScanResults = { bleDevices ->
                    bleDevices.forEach { d ->
                        d["address"]?.let { addr -> deviceTypeMap[addr] = "ble" }
                    }
                    sendEvent(mapOf("type" to "scan_update", "devices" to bleDevices))
                }
                bleService.startScan()

                // ── Classic discovery: one-shot callback when ~12 s scan finishes ──
                classicService.startDiscovery { classicDevices ->
                    bleService.stopScan()
                    val withType = classicDevices.map { d ->
                        d["address"]?.let { addr -> deviceTypeMap[addr] = "classic" }
                        d + mapOf("deviceType" to "classic")
                    }
                    result.success(withType)
                }
            }

            "connectAdapter" -> {
                val address = call.argument<String>("address") ?: run {
                    result.error("INVALID_ADDRESS", "Address is required", null)
                    return
                }
                activeBle = deviceTypeMap[address] == "ble"
                if (activeBle) bleService.connect(address) else classicService.connect(address)
                result.success(true)
            }

            "disconnectAdapter" -> {
                if (activeBle) bleService.disconnect() else classicService.disconnect()
                activeBle = false
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
