import Flutter
import UIKit

class FlutterChannelHandler: NSObject, FlutterStreamHandler {
    private let methodChannel: FlutterMethodChannel
    private let eventChannel: FlutterEventChannel
    private var eventSink: FlutterEventSink?

    private let bluetoothManager = BluetoothManager()
    private let obdEngine: OBDCommandEngine

    init(messenger: FlutterBinaryMessenger) {
        methodChannel = FlutterMethodChannel(name: "obd_channel", binaryMessenger: messenger)
        eventChannel = FlutterEventChannel(name: "obd_event_channel", binaryMessenger: messenger)
        obdEngine = OBDCommandEngine(bluetoothManager: bluetoothManager)

        super.init()

        methodChannel.setMethodCallHandler(handle)
        eventChannel.setStreamHandler(self)

        setupCallbacks()
    }

    private func setupCallbacks() {
        bluetoothManager.onStatusChanged = { [weak self] status in
            self?.sendEvent(["type": "status", "value": status])
        }

        bluetoothManager.onDataReceived = { [weak self] data in
            self?.obdEngine.handleResponse(data)
        }

        obdEngine.onBatchResult = { [weak self] batch in
            // Convert dictionary to JSON string to match Android implementation if preferred,
            // or send as Map. The prompt asks for JSON objects.
            if let jsonData = try? JSONSerialization.data(withJSONObject: batch, options: []),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                self?.sendEvent(["type": "sensor_batch", "data": jsonString])
            }
        }
    }

    private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "getAvailableDevices":
            bluetoothManager.scanForDevices { devices in
                result(devices)
            }
        case "connectAdapter":
            if let args = call.arguments as? [String: Any],
               let address = args["address"] as? String {
                bluetoothManager.connect(identifier: address)
                result(true)
            } else {
                result(FlutterError(code: "INVALID_ARGUMENT", message: "Address is missing", details: nil))
            }
        case "disconnectAdapter":
            bluetoothManager.disconnect()
            result(true)
        case "startSensorPolling":
            obdEngine.start()
            result(true)
        case "stopSensorPolling":
            obdEngine.stop()
            result(true)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func sendEvent(_ data: Any) {
        DispatchQueue.main.async {
            self.eventSink?(data)
        }
    }

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        self.eventSink = events
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        self.eventSink = nil
        return nil
    }
}
