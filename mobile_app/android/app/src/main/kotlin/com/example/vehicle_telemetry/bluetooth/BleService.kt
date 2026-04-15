package com.example.vehicle_telemetry.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.UUID

/**
 * BleService — BLE GATT transport for ELM327-compatible OBD-II adapters.
 *
 * Targets service UUID FFE0 / characteristic FFE1 (standard ELM327 BLE profile).
 * Callback signatures mirror BluetoothService (Classic) so OBDChannelHandler can
 * route to either transport transparently.
 *
 * Threading: all GATT callbacks arrive on a Binder thread.  Status and data
 * events are posted to the main thread via Handler before being delivered
 * to the caller.
 */
@SuppressLint("MissingPermission")
class BleService(private val context: Context) {

    // ── Caller-supplied callbacks ────────────────────────────────────────────
    var onDataReceived:  ((String) -> Unit)? = null
    var onStatusChanged: ((String) -> Unit)? = null
    var onScanResults:   ((List<Map<String, String>>) -> Unit)? = null

    // ── BT handles ───────────────────────────────────────────────────────────
    private val bluetoothAdapter =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    private val leScanner get() = bluetoothAdapter?.bluetoothLeScanner

    private var gatt:      BluetoothGatt?               = null
    private var writeChar: BluetoothGattCharacteristic? = null

    private val responseBuffer = StringBuilder()
    private val bleDeviceMap   = mutableMapOf<String, String>() // addr → name
    private val mainHandler    = Handler(Looper.getMainLooper())
    @Volatile private var reconnectAddress: String? = null

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("0000FFE0-0000-1000-8000-00805F9B34FB")
        val CHAR_UUID:    UUID = UUID.fromString("0000FFE1-0000-1000-8000-00805F9B34FB")
        val CCCD_UUID:    UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB")
    }

    // ── Scanning ──────────────────────────────────────────────────────────────

    fun startScan() {
        bleDeviceMap.clear()
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try { leScanner?.startScan(null, settings, scanCallback) } catch (_: Exception) {}
    }

    fun stopScan() {
        try { leScanner?.stopScan(scanCallback) } catch (_: Exception) {}
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device = result.device
            val name   = device.name?.takeIf { it.isNotBlank() } ?: return
            if (bleDeviceMap[device.address] == name) return          // no change — skip

            bleDeviceMap[device.address] = name
            val snapshot = bleDeviceMap.map { (addr, n) ->
                mapOf(
                    "name"       to n,
                    "address"    to addr,
                    "type"       to "ble_available",
                    "deviceType" to "ble"
                )
            }
            mainHandler.post { onScanResults?.invoke(snapshot) }
        }

        override fun onScanFailed(errorCode: Int) {
            mainHandler.post { onStatusChanged?.invoke("scan_failed") }
        }
    }

    // ── Connection ────────────────────────────────────────────────────────────

    fun connect(address: String) {
        stopScan()
        reconnectAddress = address
        val device = bluetoothAdapter?.getRemoteDevice(address) ?: return
        mainHandler.post { onStatusChanged?.invoke("connecting") }

        // Close any stale GATT handle before opening a new one
        gatt?.close()
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            @Suppress("DEPRECATION")
            device.connectGatt(context, false, gattCallback)
        }
    }

    fun disconnect() {
        reconnectAddress = null
        gatt?.disconnect()
        gatt?.close()
        gatt      = null
        writeChar = null
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    fun write(data: String) {
        val char  = writeChar ?: return
        val bytes = data.toByteArray()
        // FFE1 on ELM327 BLE adapters uses WRITE_TYPE_NO_RESPONSE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt?.writeCharacteristic(
                char, bytes, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            )
        } else {
            @Suppress("DEPRECATION")
            char.value     = bytes
            char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            @Suppress("DEPRECATION")
            gatt?.writeCharacteristic(char)
        }
    }

    fun isConnected(): Boolean = writeChar != null

    // ── GATT callbacks ────────────────────────────────────────────────────────

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    mainHandler.post { onStatusChanged?.invoke("connecting") }
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    writeChar = null
                    mainHandler.post { onStatusChanged?.invoke("disconnected") }
                    scheduleReconnect()
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                mainHandler.post { onStatusChanged?.invoke("failed") }
                return
            }

            val service = gatt.getService(SERVICE_UUID) ?: run {
                mainHandler.post { onStatusChanged?.invoke("failed") }
                return
            }
            val char = service.getCharacteristic(CHAR_UUID) ?: run {
                mainHandler.post { onStatusChanged?.invoke("failed") }
                return
            }

            writeChar = char

            // Enable incoming notifications so OBD responses arrive via
            // onCharacteristicChanged
            gatt.setCharacteristicNotification(char, true)
            char.getDescriptor(CCCD_UUID)?.let { descriptor ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    gatt.writeDescriptor(
                        descriptor,
                        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    )
                } else {
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    gatt.writeDescriptor(descriptor)
                }
            }

            mainHandler.post { onStatusChanged?.invoke("connected") }
        }

        // Invoked on API < 33
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            @Suppress("DEPRECATION")
            handleChunk(String(characteristic.value ?: return))
        }

        // Invoked on API >= 33
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            handleChunk(String(value))
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private fun handleChunk(chunk: String) {
        responseBuffer.append(chunk)
        // ELM327 terminates each complete response with '>'
        if (chunk.contains('>')) {
            val response = responseBuffer.toString()
            responseBuffer.setLength(0)
            mainHandler.post { onDataReceived?.invoke(response) }
        }
    }

    private fun scheduleReconnect() {
        val address = reconnectAddress ?: return
        mainHandler.postDelayed({
            if (reconnectAddress != null) connect(address)
        }, 5_000L)
    }
}
