package com.example.vehicle_telemetry

import android.os.Handler
import android.os.Looper

class OBDCommandEngine(private val bluetoothService: BluetoothService, private val onResult: (String, Double) -> Unit) {
    private val handler = Handler(Looper.getMainLooper())
    private var isPolling = false
    
    private val initCommands = listOf("ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0")
    private val pids = mapOf(
        "010C" to "RPM",
        "010D" to "Speed",
        "0105" to "CoolantTemp",
        "0111" to "Throttle"
    )

    fun startEngine() {
        Thread {
            for (cmd in initCommands) {
                bluetoothService.write("$cmd\r")
                Thread.sleep(500)
            }
            startPolling()
        }.start()
    }

    private fun startPolling() {
        isPolling = true
        Thread {
            while (isPolling) {
                for (pid in pids.keys) {
                    bluetoothService.write("$pid\r")
                    Thread.sleep(200)
                }
            }
        }.start()
    }

    fun stopPolling() {
        isPolling = false
    }

    fun handleResponse(response: String) {
        val clean = response.replace(Regex("[\\r\\n\\s>]"), "")
        for ((pid, name) in pids) {
            val responsePrefix = pid.substring(2)
            if (clean.contains(responsePrefix)) {
                val parts = clean.split(responsePrefix)
                if (parts.size > 1) {
                    val hexData = parts[1].take(4)
                    try {
                        val value = decodePid(pid, hexData)
                        onResult(name, value)
                    } catch (e: Exception) {}
                }
            }
        }
    }

    private fun decodePid(pid: String, hex: String): Double {
        val bytes = hex.chunked(2).map { it.toInt(16) }
        return when (pid) {
            "010C" -> ((bytes[0] * 256) + bytes[1]) / 4.0
            "010D" -> bytes[0].toDouble()
            "0105" -> (bytes[0] - 40).toDouble()
            "0111" -> (bytes[0] * 100.0 / 255.0)
            else -> 0.0
        }
    }
}
