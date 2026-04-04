import Foundation
import CoreBluetooth

class BluetoothManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    // MARK: - BLE state
    private var centralManager: CBCentralManager!
    private var connectedPeripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?

    // ELM327 BLE adapters typically advertise service FFE0, characteristic FFE1.
    private let serviceUUID = CBUUID(string: "FFE0")
    private let charUUID    = CBUUID(string: "FFE1")

    // MARK: - Scanning state
    // Peripherals found during the current scan window (identifier → device dict).
    private var discoveredDevices: [String: [String: String]] = [:]
    private var scanCompletion: (([[String: String]]) -> Void)?
    private let scanDuration: TimeInterval = 5.0

    // MARK: - Connection state
    private var lastIdentifier:    String?
    private var isManualDisconnect = false

    // MARK: - Callbacks (consumed by OBDCommandEngine via FlutterChannelHandler)
    var onDataReceived:   ((String) -> Void)?
    var onStatusChanged:  ((String) -> Void)?

    // MARK: - Init

    override init() {
        super.init()
        // Initialise on the main queue so CBCentralManagerDelegate callbacks arrive
        // on main and can safely dispatch UI work if needed.
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    // MARK: - Public API

    /// Scans for nearby BLE peripherals for `scanDuration` seconds, then calls
    /// `completion` with an array of `["id": UUID, "name": device name]` dictionaries.
    /// If Bluetooth is not yet powered-on the scan starts as soon as it becomes ready.
    func scanForDevices(completion: @escaping ([[String: String]]) -> Void) {
        scanCompletion = completion
        discoveredDevices.removeAll()

        if centralManager.state == .poweredOn {
            startScan()
        }
        // If not powered-on yet, centralManagerDidUpdateState will call startScan()
        // once the radio is ready — or the 5-second timer will fire with whatever
        // was accumulated up to that point.

        DispatchQueue.main.asyncAfter(deadline: .now() + scanDuration) { [weak self] in
            self?.finishScan()
        }
    }

    func connect(identifier: String) {
        lastIdentifier     = identifier
        isManualDisconnect = false

        guard let uuid       = UUID(uuidString: identifier) else { return }
        let peripherals      = centralManager.retrievePeripherals(withIdentifiers: [uuid])
        if let peripheral    = peripherals.first {
            connectedPeripheral          = peripheral
            connectedPeripheral?.delegate = self
            centralManager.connect(peripheral, options: nil)
            onStatusChanged?("connecting")
        } else {
            // Peripheral not in cache — start a targeted scan to find it.
            centralManager.scanForPeripherals(withServices: nil, options: nil)
            onStatusChanged?("connecting")
        }
    }

    func disconnect() {
        isManualDisconnect = true
        if let peripheral = connectedPeripheral {
            centralManager.cancelPeripheralConnection(peripheral)
        }
    }

    func write(_ data: String) {
        guard let peripheral = connectedPeripheral,
              let char       = writeCharacteristic,
              let bytes      = data.data(using: .utf8) else { return }
        peripheral.writeValue(bytes, for: char, type: .withResponse)
    }

    // MARK: - Private helpers

    private func startScan() {
        // Scan for all peripherals — we filter by service UUID after discovery so
        // that adapters that don't advertise their service UUIDs are still found.
        centralManager.scanForPeripherals(withServices: nil,
                                          options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    private func finishScan() {
        centralManager.stopScan()
        let devices = Array(discoveredDevices.values)
        scanCompletion?(devices)
        scanCompletion = nil
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            // If a scan is pending (scanCompletion set but scan not yet started), begin now.
            if scanCompletion != nil {
                startScan()
            }
        case .poweredOff, .unauthorized, .unsupported:
            onStatusChanged?("powered_off")
            // Return empty result if a scan was waiting.
            finishScan()
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let identifier = peripheral.identifier.uuidString
        let name = peripheral.name
            ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? "Unknown Device"
        discoveredDevices[identifier] = ["id": identifier, "name": name]

        // If we were scanning to locate a specific peripheral for connect(), connect now.
        if let target = lastIdentifier, target == identifier, connectedPeripheral == nil {
            centralManager.stopScan()
            connectedPeripheral          = peripheral
            connectedPeripheral?.delegate = self
            centralManager.connect(peripheral, options: nil)
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didConnect peripheral: CBPeripheral) {
        onStatusChanged?("connected")
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager,
                        didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        connectedPeripheral = nil
        onStatusChanged?("failed")
    }

    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        connectedPeripheral    = nil
        writeCharacteristic    = nil
        onStatusChanged?("disconnected")

        // Auto-reconnect unless the user explicitly disconnected.
        guard !isManualDisconnect, let id = lastIdentifier else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { [weak self] in
            guard let self = self, !self.isManualDisconnect else { return }
            self.connect(identifier: id)
        }
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverServices error: Error?) {
        guard let services = peripheral.services else { return }
        for service in services {
            peripheral.discoverCharacteristics([charUUID], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        guard let characteristics = service.characteristics else { return }
        for characteristic in characteristics where characteristic.uuid == charUUID {
            writeCharacteristic = characteristic
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard let data     = characteristic.value,
              let response = String(data: data, encoding: .utf8) else { return }
        onDataReceived?(response)
    }
}
