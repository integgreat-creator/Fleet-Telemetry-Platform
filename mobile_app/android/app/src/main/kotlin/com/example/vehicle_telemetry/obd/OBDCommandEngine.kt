package com.example.vehicle_telemetry.obd

import com.example.vehicle_telemetry.bluetooth.BluetoothService
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * OBDCommandEngine – polls all 70 supported OBD-II Mode 01 PIDs across three
 * priority tiers so the dashboard can display readings for the full 121-sensor
 * model without overwhelming the ELM327 adapter or the CAN bus.
 *
 * Tier 1 (15 PIDs) – polled every cycle  (~2 s refresh)
 * Tier 2 (25 PIDs) – polled every 5th cycle (~10 s refresh)
 * Tier 3 (30 PIDs) – polled every 30th cycle (~60 s refresh)
 *
 * After the init sequence but BEFORE polling begins, the engine reads the
 * vehicle VIN via Mode 09 PID 02 (0902).  The decoded VIN string is delivered
 * to the caller via [onVinRead].  If the vehicle does not support Mode 09 or
 * the response times out, [onVinRead] is invoked with null so the caller can
 * fall back gracefully.
 *
 * Sensor names match SensorType enum values in sensor_data.dart exactly,
 * so OBDService can resolve them with a single enum lookup.
 */
class OBDCommandEngine(
    private val bluetoothService: BluetoothService,
    private val onBatchResult: (JSONObject) -> Unit,
    private val onVinRead: ((String?) -> Unit)? = null
) {
    private var isPolling = false
    private var cycleCount = 0
    private val scheduler = Executors.newSingleThreadScheduledExecutor()

    // Thread-safe buffer shared between the scheduler thread (poll) and the
    // Bluetooth receive thread (handleResponse).
    private val sensorBuffer = ConcurrentHashMap<String, Any>()

    // ── VIN reading state ────────────────────────────────────────────────────
    // Accessed from both the init thread (readVin) and the BT receive thread
    // (handleResponse), so flags are @Volatile and the StringBuilder is guarded
    // by its own monitor.
    private val vinChars = StringBuilder()
    @Volatile private var vinReadingMode = false
    @Volatile private var vinResolved = false

    // ── Initialisation sequence ──────────────────────────────────────────────
    // ATE0 is sent twice; cheap clone adapters often need a second echo-off.
    private val initCommands = listOf("ATZ", "ATE0", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0")

    // ── Tier 1: Critical real-time sensors (polled every cycle, ~2 s) ────────
    private val tier1Pids = linkedMapOf(
        "010C" to "rpm",
        "010D" to "speed",
        "0104" to "engineLoad",
        "0105" to "coolantTemp",
        "010F" to "intakeAirTemp",
        "0111" to "throttlePosition",
        "0110" to "maf",
        "012F" to "fuelLevel",
        "0142" to "controlModuleVoltage",
        "0106" to "shortFuelTrim",
        "0107" to "longFuelTrim",
        "010B" to "manifoldPressure",
        "0145" to "relativeThrottlePosition",
        "0149" to "acceleratorPedalPositionD",
        "015C" to "engineOilTemp"
    )

    // ── Tier 2: Standard sensors (polled every 5th cycle, ~10 s) ────────────
    private val tier2Pids = linkedMapOf(
        "010E" to "timingAdvance",
        "010A" to "fuelPressure",
        "0133" to "barometricPressure",
        "0143" to "absoluteLoad",
        "0144" to "commandedAirFuelRatio",
        "0146" to "ambientTemp",
        "0147" to "absoluteThrottlePositionB",
        "0148" to "absoluteThrottlePositionC",
        "014B" to "commandedThrottleActuator",
        "015A" to "relativeAcceleratorPosition",
        "015B" to "hybridBatteryLife",
        "015D" to "fuelInjectionTiming",
        "015E" to "engineFuelRate",
        "0161" to "driverDemandTorque",
        "0162" to "actualEngineTorque",
        "0163" to "engineReferenceTorque",
        "012C" to "commandedEGR",
        "012D" to "egrError",
        "012E" to "commandedEvapPurge",
        "0114" to "o2Sensor1Voltage",
        "0115" to "o2Sensor2Voltage",
        "0116" to "o2Sensor3Voltage",
        "0117" to "o2Sensor4Voltage",
        "0118" to "o2Sensor5Voltage",
        "0119" to "o2Sensor6Voltage",
        "011A" to "o2Sensor7Voltage",
        "011B" to "o2Sensor8Voltage",
        "013C" to "catalystTempBank1",
        "013D" to "catalystTempBank2"
    )

    // ── Tier 3: Diagnostic / low-frequency sensors (every 30th cycle, ~60 s) ─
    private val tier3Pids = linkedMapOf(
        "0121" to "distanceSinceMIL",
        "011F" to "engineRuntime",
        "0130" to "warmupsSinceDTCCleared",
        "0131" to "distanceSinceDTCCleared",
        "0132" to "evapSystemVaporPressure",
        "0153" to "absoluteEvapSystemPressure",
        "0154" to "evapSystemPressure2",
        "0152" to "ethanolFuelPercent",
        "0159" to "fuelRailAbsolutePressure",
        "014C" to "runTimeWithMIL",
        "014D" to "timeSinceDTCCleared",
        "0151" to "fuelType",
        "015F" to "emissionRequirements",
        "0155" to "shortTermSecondaryO2TrimB1",
        "0156" to "longTermSecondaryO2TrimB1",
        "0157" to "shortTermSecondaryO2TrimB2",
        "0158" to "longTermSecondaryO2TrimB2",
        "0179" to "exhaustPressure",
        "017E" to "exhaustGasTempBank1",
        "017F" to "exhaustGasTempBank2",
        "0175" to "turbochargerCompressorInlet",
        "0176" to "boostPressureControl",
        "0177" to "variableGeometryTurboControl",
        "0178" to "wastegateControl",
        "0191" to "transmissionGear",
        "0193" to "odometerReading",
        "019D" to "noxSensorConcentration",
        "018D" to "cylinderFuelRate",
        "016C" to "fuelSystemControl",
        "0173" to "fuelPressureControlSystem",
        "0174" to "injectionPressureControlSystem",
        "0101" to "monitorStatusSinceDTCCleared",
        "0103" to "fuelSystemStatus",
        "0141" to "monitorStatusDriveCycle",
        "011E" to "auxiliaryInputStatus"
    )

    // Combined lookup: responsePrefix ("41XX") → (pid, sensorName)
    private val prefixToEntry: Map<String, Pair<String, String>> by lazy {
        val all = tier1Pids + tier2Pids + tier3Pids
        all.entries.associate { (pid, name) ->
            ("41" + pid.substring(2).uppercase()) to (pid to name)
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    fun start() {
        if (isPolling) return
        Thread {
            try {
                for ((index, cmd) in initCommands.withIndex()) {
                    bluetoothService.write("$cmd\r")
                    Thread.sleep(if (index == 0) 2000L else 500L)
                }

                // Read VIN before the first sensor poll.
                // Blocking: waits up to VIN_TIMEOUT_MS for the vehicle to respond.
                readVin()

                startPolling()
            } catch (e: Exception) {
                isPolling = false
            }
        }.start()
    }

    /**
     * Request the VIN via SAE J1979 Mode 09 PID 02 (command "0902").
     *
     * Blocks the init thread while waiting for response frames to arrive
     * through [handleResponse].  On success [onVinRead] is called with the
     * 17-char VIN string; on timeout it is called with null.
     */
    private fun readVin() {
        if (onVinRead == null) return

        synchronized(vinChars) { vinChars.clear() }
        vinResolved  = false
        vinReadingMode = true

        bluetoothService.write("0902\r")

        val deadline = System.currentTimeMillis() + VIN_TIMEOUT_MS
        while (!vinResolved && System.currentTimeMillis() < deadline) {
            Thread.sleep(100)
        }

        vinReadingMode = false

        if (!vinResolved) {
            // Vehicle doesn't support Mode 09, or adapter returned NO DATA.
            onVinRead.invoke(null)
        }
    }

    private fun startPolling() {
        isPolling = true
        scheduler.scheduleWithFixedDelay({
            if (isPolling) pollCycle()
        }, 0, 400, TimeUnit.MILLISECONDS)
    }

    private fun pollCycle() {
        if (sensorBuffer.isNotEmpty()) {
            val snapshot = JSONObject(HashMap(sensorBuffer))
            sensorBuffer.clear()
            onBatchResult(snapshot)
        }

        sendPids(tier1Pids)
        if (cycleCount % 5  == 0) sendPids(tier2Pids)
        if (cycleCount % 30 == 0) sendPids(tier3Pids)
        cycleCount++
    }

    private fun sendPids(pids: Map<String, String>) {
        for (pid in pids.keys) {
            bluetoothService.write("$pid\r")
            Thread.sleep(100)
        }
    }

    fun stop() {
        isPolling = false
    }

    // ── Response parsing ─────────────────────────────────────────────────────

    fun handleResponse(response: String) {
        val clean = response.replace(Regex("[\\r\\n\\s>]"), "").uppercase()

        val stripped = clean
            .replace("SEARCHING...", "")
            .replace("SEARCHING", "")

        if (stripped.isEmpty()) return

        // ── VIN mode: accumulate Mode 09 PID 02 response frames ─────────────
        //
        // SAE J1979 Mode 09 PID 02 response format (ATS0 + ATH0 = no spaces/headers):
        //
        //   4902 [item_num_2hex] [up to 4 VIN bytes as 8 hex chars]
        //
        // Example for VIN "1HGCM82633A004352":
        //   490201 31484743  → '1','H','G','C'
        //   490202 4D383236  → 'M','8','2','6'
        //   490203 33334130  → '3','3','A','0'
        //   490204 34333532  → '4','3','5','2'
        //   490205 00000000  → (VIN complete, padding)
        //
        if (vinReadingMode && stripped.contains("4902")) {
            synchronized(vinChars) {
                var searchFrom = 0
                while (true) {
                    val frameStart = stripped.indexOf("4902", searchFrom)
                    if (frameStart == -1) break

                    // Layout: "4902" (4) + item_num (2) + data bytes
                    val dataStart = frameStart + 6
                    if (dataStart >= stripped.length) break

                    // Take up to 8 hex chars (4 bytes) per frame
                    val segment = stripped.substring(dataStart).take(8)
                    var i = 0
                    while (i + 1 < segment.length) {
                        try {
                            val b = segment.substring(i, i + 2).toInt(16)
                            // Accept only printable ASCII — VIN chars are A-Z and 0-9
                            if (b in 0x21..0x7E) vinChars.append(b.toChar())
                        } catch (_: Exception) { /* malformed hex — skip */ }
                        i += 2
                    }

                    searchFrom = frameStart + 4
                }

                if (vinChars.length >= 17 && !vinResolved) {
                    vinResolved = true
                    onVinRead?.invoke(vinChars.toString().take(17))
                }
            }
            return // Do not fall through to sensor parsing
        }

        // Silently ignore stray 4902 frames outside VIN mode
        if (stripped.contains("4902")) return

        // ── Normal Mode 01 sensor response ───────────────────────────────────
        if (stripped.contains("NODATA")
            || stripped.contains("ERROR")
            || stripped.contains("UNABLE")
            || stripped.contains("STOPPED")) return

        for ((prefix, entry) in prefixToEntry) {
            if (stripped.contains(prefix)) {
                val (pid, name) = entry
                val dataStart = stripped.indexOf(prefix) + prefix.length
                if (dataStart >= stripped.length) break
                val hexData = stripped.substring(dataStart).take(8)
                try {
                    val value = decodePid(pid, hexData)
                    sensorBuffer[name] = value
                } catch (_: Exception) { }
                break
            }
        }
    }

    // ── PID decoders (SAE J1979 / ISO 15031-5) ───────────────────────────────

    private fun decodePid(pid: String, hex: String): Double {
        val bytes = hex.chunked(2)
            .filter { it.length == 2 }
            .map { it.toInt(16) }
        if (bytes.isEmpty()) return 0.0

        val a = bytes.getOrElse(0) { 0 }
        val b = bytes.getOrElse(1) { 0 }
        val c = bytes.getOrElse(2) { 0 }
        val d = bytes.getOrElse(3) { 0 }

        return when (pid.uppercase()) {
            "010C" -> ((a * 256) + b) / 4.0
            "010D" -> a.toDouble()
            "0104" -> a * 100.0 / 255.0
            "0105" -> (a - 40).toDouble()
            "010F" -> (a - 40).toDouble()
            "0111" -> a * 100.0 / 255.0
            "0110" -> (a * 256 + b) / 100.0
            "012F" -> a * 100.0 / 255.0
            "0142" -> (a * 256 + b) / 1000.0
            "0106" -> (a - 128) * 100.0 / 128.0
            "0107" -> (a - 128) * 100.0 / 128.0
            "010B" -> a.toDouble()
            "0145" -> a * 100.0 / 255.0
            "0149" -> a * 100.0 / 255.0
            "015C" -> (a - 40).toDouble()
            "010E" -> a / 2.0 - 64.0
            "010A" -> a * 3.0
            "0133" -> a.toDouble()
            "0143" -> (a * 256 + b) * 100.0 / 255.0
            "0144" -> (a * 256 + b) / 32768.0
            "0146" -> (a - 40).toDouble()
            "0147" -> a * 100.0 / 255.0
            "0148" -> a * 100.0 / 255.0
            "014B" -> a * 100.0 / 255.0
            "015A" -> a * 100.0 / 255.0
            "015B" -> a * 100.0 / 255.0
            "015D" -> (a * 256 + b) / 128.0 - 210.0
            "015E" -> (a * 256 + b) / 20.0
            "0161" -> (a - 125).toDouble()
            "0162" -> (a - 125).toDouble()
            "0163" -> (a * 256 + b).toDouble()
            "012C" -> a * 100.0 / 255.0
            "012D" -> (a - 128) * 100.0 / 128.0
            "012E" -> a * 100.0 / 255.0
            "0114", "0115", "0116", "0117",
            "0118", "0119", "011A", "011B" -> a / 200.0
            "013C", "013D" -> (a * 256 + b) / 10.0 - 40.0
            "0121" -> (a * 256 + b).toDouble()
            "011F" -> (a * 256 + b).toDouble()
            "0130" -> a.toDouble()
            "0131" -> (a * 256 + b).toDouble()
            "0132" -> (a * 256 + b) / 4.0 - 8192.0
            "0153" -> (a * 256 + b) / 200.0
            "0154" -> (a * 256 + b) / 4.0 - 8192.0
            "0152" -> a * 100.0 / 255.0
            "0159" -> (a * 256 + b) * 10.0
            "014C" -> (a * 256 + b).toDouble()
            "014D" -> (a * 256 + b).toDouble()
            "0151" -> a.toDouble()
            "015F" -> a.toDouble()
            "0155", "0156", "0157", "0158" -> (a - 128) * 100.0 / 128.0
            "0179" -> (a * 256 + b).toDouble()
            "017E" -> (a * 256 + b) / 10.0 - 40.0
            "017F" -> (a * 256 + b) / 10.0 - 40.0
            "0175" -> (a * 256 + b) / 10.0
            "0176" -> (a * 256 + b) / 10.0
            "0177" -> a * 100.0 / 255.0
            "0178" -> a * 100.0 / 255.0
            "0191" -> a.toDouble()
            "0193" -> (a.toLong() * 16_777_216L + b.toLong() * 65_536L
                     + c.toLong() * 256L + d.toLong()).toDouble()
            "019D" -> (a * 256 + b).toDouble()
            "018D" -> (a * 256 + b).toDouble()
            "016C" -> a.toDouble()
            "0173" -> a.toDouble()
            "0174" -> a.toDouble()
            "0101" -> a.toDouble()
            "0103" -> a.toDouble()
            "0141" -> a.toDouble()
            "011E" -> (a and 0x01).toDouble()
            else   -> 0.0
        }
    }

    companion object {
        private const val VIN_TIMEOUT_MS = 5_000L
    }
}
