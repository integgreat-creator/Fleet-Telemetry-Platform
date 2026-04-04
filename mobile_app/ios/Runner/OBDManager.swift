import Foundation
import CoreBluetooth
import Flutter

class OBDManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var centralManager: CBCentralManager!
    private var connectedPeripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?

    private let serviceUUID = CBUUID(string: "FFE0") // Common for ELM327 BLE
    private let charUUID = CBUUID(string: "FFE1")

    var onDataReceived: ((String) -> Void)?
    var onStatusChanged: ((String) -> Void)?

    private var isPolling = false
    private let initCommands = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"]
    private let pids = ["010C": "RPM", "010D": "Speed", "0105": "CoolantTemp", "0111": "Throttle"]

    override init() {
        super.init()
        centralManager = CBCentralManager(delegate: self, queue: nil)
    }

    func connect(identifier: String) {
        guard let uuid = UUID(uuidString: identifier) else { return }
        let peripherals = centralManager.retrievePeripherals(withIdentifiers: [uuid])
        if let peripheral = peripherals.first {
            connectedPeripheral = peripheral
            connectedPeripheral?.delegate = self
            centralManager.connect(peripheral, options: nil)
            onStatusChanged?("connecting")
        }
    }

    func disconnect() {
        if let peripheral = connectedPeripheral {
            centralManager.cancelPeripheralConnection(peripheral)
        }
    }

    func sendCommand(_ command: String) {
        guard let peripheral = connectedPeripheral, let char = writeCharacteristic else { return }
        let fullCommand = command + "\r"
        if let data = fullCommand.data(using: .utf8) {
            peripheral.writeValue(data, for: char, type: .withResponse)
        }
    }

    func startPolling() {
        isPolling = true
        DispatchQueue.global().async {
            for cmd in self.initCommands {
                self.sendCommand(cmd)
                Thread.sleep(forTimeInterval: 0.5)
            }
            while self.isPolling {
                for pid in self.pids.keys {
                    self.sendCommand(pid)
                    Thread.sleep(forTimeInterval: 0.2)
                }
            }
        }
    }

    func stopPolling() {
        isPolling = false
    }

    // MARK: - CBCentralManagerDelegate
    func centralManagerDidUpdateState(_ central: CBCentralManager) {}

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        onStatusChanged?("connected")
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        onStatusChanged?("disconnected")
        connectedPeripheral = nil
        writeCharacteristic = nil
    }

    // MARK: - CBPeripheralDelegate
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let services = peripheral.services else { return }
        for service in services {
            peripheral.discoverCharacteristics([charUUID], for: service)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let characteristics = service.characteristics else { return }
        for characteristic in characteristics {
            if characteristic.uuid == charUUID {
                writeCharacteristic = characteristic
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let data = characteristic.value, let response = String(data: data, encoding: .utf8) {
            onDataReceived?(response)
        }
    }

    func decodeResponse(_ response: String) -> (String, Double)? {
        let clean = response.replacingOccurrences(of: "[\\r\\n\\s>]", with: "", options: .regularExpression)
        for (pid, name) in pids {
            let responsePrefix = String(pid.suffix(2))
            if clean.contains(responsePrefix) {
                let parts = clean.components(separatedBy: responsePrefix)
                if parts.count > 1 {
                    let hexData = String(parts[1].prefix(4))
                    if let value = decodePid(pid, hex: hexData) {
                        return (name, value)
                    }
                }
            }
        }
        return nil
    }

    private func decodePid(_ pid: String, hex: String) -> Double? {
        guard hex.count >= 2 else { return nil }
        let bytes = stride(from: 0, to: hex.count, by: 2).compactMap { i -> Int? in
            let start = hex.index(hex.startIndex, offsetBy: i)
            let end = hex.index(start, offsetBy: 2)
            return Int(hex[start..<end], radix: 16)
        }

        switch pid {
        case "010C":
            if bytes.count >= 2 { return Double((bytes[0] * 256) + bytes[1]) / 4.0 }
        case "010D":
            if bytes.count >= 1 { return Double(bytes[0]) }
        case "0105":
            if bytes.count >= 1 { return Double(bytes[0] - 40) }
        case "0111":
            if bytes.count >= 1 { return Double(bytes[0]) * 100.0 / 255.0 }
        default:
            return nil
        }
        return nil
    }
}
