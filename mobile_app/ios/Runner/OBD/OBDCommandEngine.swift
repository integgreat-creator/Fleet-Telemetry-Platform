import Foundation

// MARK: - OBDCommandEngine
// Full 70-PID, 3-tier SAE J1979 polling engine matching the Android implementation.
// Tier 1 (15 PIDs) polls every ~2 s cycle.
// Tier 2 (25 PIDs) polls every 5th cycle  (~10 s).
// Tier 3 (30 PIDs) polls every 30th cycle (~60 s).

class OBDCommandEngine {

    private let bluetoothManager: BluetoothManager
    private var isPolling = false
    private var cycleCount  = 0

    // Thread-safe sensor buffer — written by handleResponse (BT delegate thread),
    // read+cleared by the poll loop (background queue).
    private var sensorBuffer: [String: Double] = [:]
    private let bufferLock = NSLock()

    private let initCommands = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"]

    // ── Tier 1: 15 PIDs, every cycle ─────────────────────────────────────────
    private let tier1Pids: [(pid: String, name: String)] = [
        ("010C", "rpm"),
        ("010D", "speed"),
        ("0104", "engineLoad"),
        ("0105", "coolantTemp"),
        ("010F", "intakeAirTemp"),
        ("0111", "throttlePosition"),
        ("0110", "maf"),
        ("012F", "fuelLevel"),
        ("0142", "controlModuleVoltage"),
        ("0106", "shortFuelTrim"),
        ("0107", "longFuelTrim"),
        ("010B", "manifoldPressure"),
        ("0145", "relativeThrottlePosition"),
        ("0149", "acceleratorPedalPositionD"),
        ("015C", "engineOilTemp"),
    ]

    // ── Tier 2: 25 PIDs, every 5th cycle ─────────────────────────────────────
    private let tier2Pids: [(pid: String, name: String)] = [
        ("0114", "o2Sensor1Voltage"),
        ("0115", "o2Sensor2Voltage"),
        ("011F", "engineRuntime"),
        ("0121", "distanceSinceMIL"),
        ("012E", "commandedEvapPurge"),
        ("0130", "warmupsSinceDTCCleared"),
        ("0131", "distanceSinceDTCCleared"),
        ("0133", "barometricPressure"),
        ("0143", "absoluteLoad"),
        ("0144", "commandedAirFuelRatio"),
        ("0146", "ambientTemp"),
        ("010A", "fuelPressure"),
        ("010E", "timingAdvance"),
        ("012C", "commandedEGR"),
        ("012D", "egrError"),
        ("015A", "hybridBatteryLife"),
        ("015D", "fuelInjectionTiming"),
        ("015E", "engineFuelRate"),
        ("0147", "absoluteThrottlePositionB"),
        ("014C", "commandedThrottleActuator"),
        ("014D", "runTimeWithMIL"),
        ("014E", "timeSinceDTCCleared"),
        ("0152", "ethanolFuelPercent"),
        ("0161", "driverDemandTorque"),
        ("0162", "actualEngineTorque"),
    ]

    // ── Tier 3: 30 PIDs, every 30th cycle ────────────────────────────────────
    private let tier3Pids: [(pid: String, name: String)] = [
        ("0116", "o2Sensor3Voltage"),
        ("0117", "o2Sensor4Voltage"),
        ("0118", "o2Sensor5Voltage"),
        ("0119", "o2Sensor6Voltage"),
        ("011A", "o2Sensor7Voltage"),
        ("011B", "o2Sensor8Voltage"),
        ("013C", "catalystTempBank1"),
        ("013D", "catalystTempBank2"),
        ("0163", "engineReferenceTorque"),
        ("0167", "coolantTemp2"),
        ("011C", "emissionRequirements"),
        ("0151", "fuelType"),
        ("0132", "evapSystemVaporPressure"),
        ("0153", "absoluteEvapSystemPressure"),
        ("0155", "shortTermSecondaryO2TrimB1"),
        ("0156", "longTermSecondaryO2TrimB1"),
        ("0157", "shortTermSecondaryO2TrimB2"),
        ("0158", "longTermSecondaryO2TrimB2"),
        ("0123", "fuelRailAbsolutePressure"),
        ("0148", "absoluteThrottlePositionC"),
        ("014B", "relativeAcceleratorPosition"),
        ("0173", "exhaustGasTempBank1"),
        ("0174", "exhaustGasTempBank2"),
        ("0178", "exhaustGasTempSensor"),
        ("017C", "dieselParticulateFilterTemp"),
        ("018C", "boostPressureControl"),
        ("018D", "variableGeometryTurboControl"),
        ("018E", "wastegateControl"),
        ("01A2", "cylinderFuelRate"),
        ("01A6", "odometerReading"),
    ]

    // O(1) response-prefix → (pid, name) lookup, built once at init.
    // Key: "41XX" (uppercase) where XX is the last two hex chars of the PID.
    private var prefixToEntry: [String: (pid: String, name: String)] = [:]

    var onBatchResult: (([String: Any]) -> Void)?

    // MARK: - Init

    init(bluetoothManager: BluetoothManager) {
        self.bluetoothManager = bluetoothManager
        buildPrefixMap()
    }

    private func buildPrefixMap() {
        for entry in tier1Pids + tier2Pids + tier3Pids {
            let prefix = ("41" + String(entry.pid.suffix(2))).uppercased()
            prefixToEntry[prefix] = entry
        }
    }

    // MARK: - Lifecycle

    func start() {
        guard !isPolling else { return }
        DispatchQueue.global(qos: .background).async { [weak self] in
            self?.runInit()
            self?.runPollLoop()
        }
    }

    func stop() {
        isPolling = false
    }

    // MARK: - Initialisation sequence

    private func runInit() {
        for cmd in initCommands {
            bluetoothManager.write(cmd + "\r")
            // ATZ (full chip reset) needs 2 s for cheap clone adapters; all others 500 ms.
            Thread.sleep(forTimeInterval: cmd == "ATZ" ? 2.0 : 0.5)
        }
    }

    // MARK: - Poll loop

    private func runPollLoop() {
        isPolling = true
        while isPolling {
            // Flush and emit any accumulated readings from the previous cycle.
            bufferLock.lock()
            let snapshot = sensorBuffer
            sensorBuffer.removeAll(keepingCapacity: true)
            bufferLock.unlock()

            if !snapshot.isEmpty {
                onBatchResult?(snapshot as [String: Any])
            }

            sendPids(tier1Pids)
            if cycleCount % 5  == 0 { sendPids(tier2Pids) }
            if cycleCount % 30 == 0 { sendPids(tier3Pids) }
            cycleCount += 1

            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    private func sendPids(_ entries: [(pid: String, name: String)]) {
        for entry in entries {
            guard isPolling else { return }
            bluetoothManager.write(entry.pid + "\r")
            Thread.sleep(forTimeInterval: 0.1) // 100 ms inter-PID gap
        }
    }

    // MARK: - Response parsing

    func handleResponse(_ response: String) {
        // Strip whitespace, prompt characters, and normalise to uppercase.
        let clean = response
            .components(separatedBy: CharacterSet.whitespacesAndNewlines)
            .joined()
            .replacingOccurrences(of: ">", with: "")
            .uppercased()

        guard clean.count >= 6,
              !clean.contains("NODATA"),
              !clean.contains("ERROR"),
              !clean.contains("SEARCHING"),
              !clean.contains("UNABLETOCONNECT") else { return }

        // Each ELM327 response starts with the mode+PID echo: "41XX..."
        // Use the first four chars as the dispatch key (O(1) lookup).
        guard clean.count >= 4 else { return }
        let prefix = String(clean.prefix(4))
        guard let entry = prefixToEntry[prefix] else { return }

        let hexData = String(clean.dropFirst(4).prefix(8)) // up to 4 payload bytes
        guard let value = decodePid(entry.pid, hex: hexData) else { return }

        bufferLock.lock()
        sensorBuffer[entry.name] = value
        bufferLock.unlock()
    }

    // MARK: - SAE J1979 decoders

    // swiftlint:disable cyclomatic_complexity function_body_length
    private func decodePid(_ pid: String, hex: String) -> Double? {
        // Parse up to 4 payload bytes from the hex string.
        let bytes: [Int] = stride(from: 0, to: min(hex.count, 8), by: 2).compactMap { i in
            let s = hex.index(hex.startIndex, offsetBy: i)
            let e = hex.index(s, offsetBy: min(2, hex.distance(from: s, to: hex.endIndex)))
            return Int(hex[s..<e], radix: 16)
        }
        guard !bytes.isEmpty else { return nil }

        let A = bytes.count > 0 ? bytes[0] : 0
        let B = bytes.count > 1 ? bytes[1] : 0
        let C = bytes.count > 2 ? bytes[2] : 0
        let D = bytes.count > 3 ? bytes[3] : 0

        switch pid {

        // ── Tier 1 ──────────────────────────────────────────────────────────
        case "010C": // rpm
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 4.0

        case "010D": return Double(A)                                  // speed km/h
        case "0104": return Double(A) * 100.0 / 255.0                 // engineLoad %
        case "0105": return Double(A) - 40.0                          // coolantTemp °C
        case "010F": return Double(A) - 40.0                          // intakeAirTemp °C
        case "0111": return Double(A) * 100.0 / 255.0                 // throttlePosition %

        case "0110": // maf g/s
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 100.0

        case "012F": return Double(A) * 100.0 / 255.0                 // fuelLevel %

        case "0142": // controlModuleVoltage V
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 1000.0

        case "0106": return Double(A - 128) * 100.0 / 128.0           // shortFuelTrim %
        case "0107": return Double(A - 128) * 100.0 / 128.0           // longFuelTrim %
        case "010B": return Double(A)                                  // manifoldPressure kPa
        case "0145": return Double(A) * 100.0 / 255.0                 // relativeThrottlePosition %
        case "0149": return Double(A) * 100.0 / 255.0                 // acceleratorPedalPositionD %
        case "015C": return Double(A) - 40.0                          // engineOilTemp °C

        // ── Tier 2 ──────────────────────────────────────────────────────────
        case "0114": return Double(A) / 200.0                         // o2Sensor1Voltage V
        case "0115": return Double(A) / 200.0                         // o2Sensor2Voltage V

        case "011F": // engineRuntime s
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "0121": // distanceSinceMIL km
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "012E": return Double(A) * 100.0 / 255.0                 // commandedEvapPurge %
        case "0130": return Double(A)                                  // warmupsSinceDTCCleared count

        case "0131": // distanceSinceDTCCleared km
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "0133": return Double(A)                                  // barometricPressure kPa

        case "0143": // absoluteLoad %
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) * 100.0 / 255.0

        case "0144": // commandedAirFuelRatio (λ × 2)
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) * 2.0 / 65536.0

        case "0146": return Double(A) - 40.0                          // ambientTemp °C
        case "010A": return Double(A) * 3.0                           // fuelPressure kPa
        case "010E": return Double(A) / 2.0 - 64.0                   // timingAdvance °BTDC
        case "012C": return Double(A) * 100.0 / 255.0                 // commandedEGR %
        case "012D": return Double(A - 128) * 100.0 / 128.0           // egrError %
        case "015A": return Double(A) * 100.0 / 255.0                 // hybridBatteryLife %

        case "015D": // fuelInjectionTiming °
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 32.0 - 210.0

        case "015E": // engineFuelRate L/h
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 20.0

        case "0147": return Double(A) * 100.0 / 255.0                 // absoluteThrottlePositionB %
        case "014C": return Double(A) * 100.0 / 255.0                 // commandedThrottleActuator %

        case "014D": // runTimeWithMIL s
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "014E": // timeSinceDTCCleared s
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "0152": return Double(A) * 100.0 / 255.0                 // ethanolFuelPercent %
        case "0161": return Double(A) - 125.0                         // driverDemandTorque %
        case "0162": return Double(A) - 125.0                         // actualEngineTorque %

        // ── Tier 3 ──────────────────────────────────────────────────────────
        case "0116": return Double(A) / 200.0                         // o2Sensor3Voltage V
        case "0117": return Double(A) / 200.0                         // o2Sensor4Voltage V
        case "0118": return Double(A) / 200.0                         // o2Sensor5Voltage V
        case "0119": return Double(A) / 200.0                         // o2Sensor6Voltage V
        case "011A": return Double(A) / 200.0                         // o2Sensor7Voltage V
        case "011B": return Double(A) / 200.0                         // o2Sensor8Voltage V

        case "013C": // catalystTempBank1 °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "013D": // catalystTempBank2 °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "0163": // engineReferenceTorque Nm
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B)

        case "0167": return Double(A) - 40.0                          // coolantTemp2 °C
        case "011C": return Double(A)                                  // emissionRequirements
        case "0151": return Double(A)                                  // fuelType

        case "0132": // evapSystemVaporPressure Pa (signed 16-bit / 4)
            guard bytes.count >= 2 else { return nil }
            let raw = (A * 256) + B
            return raw < 32768 ? Double(raw) / 4.0 : Double(raw - 65536) / 4.0

        case "0153": // absoluteEvapSystemPressure kPa
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 200.0

        case "0155": return Double(A - 128) * 100.0 / 128.0           // shortTermSecondaryO2TrimB1 %
        case "0156": return Double(A - 128) * 100.0 / 128.0           // longTermSecondaryO2TrimB1 %
        case "0157": return Double(A - 128) * 100.0 / 128.0           // shortTermSecondaryO2TrimB2 %
        case "0158": return Double(A - 128) * 100.0 / 128.0           // longTermSecondaryO2TrimB2 %

        case "0123": // fuelRailAbsolutePressure kPa
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) * 10.0

        case "0148": return Double(A) * 100.0 / 255.0                 // absoluteThrottlePositionC %
        case "014B": return Double(A) * 100.0 / 255.0                 // relativeAcceleratorPosition %

        case "0173": // exhaustGasTempBank1 °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "0174": // exhaustGasTempBank2 °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "0178": // exhaustGasTempSensor °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "017C": // dieselParticulateFilterTemp °C
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 10.0 - 40.0

        case "018C": // boostPressureControl kPa
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 200.0

        case "018D": return Double(A) * 100.0 / 255.0                 // variableGeometryTurboControl %
        case "018E": return Double(A) * 100.0 / 255.0                 // wastegateControl %

        case "01A2": // cylinderFuelRate mg/str
            guard bytes.count >= 2 else { return nil }
            return Double((A * 256) + B) / 32.0

        case "01A6": // odometerReading km (4-byte)
            guard bytes.count >= 4 else { return nil }
            return Double((A * 16_777_216) + (B * 65_536) + (C * 256) + D) / 10.0

        default:
            return nil
        }
    }
    // swiftlint:enable cyclomatic_complexity function_body_length
}
