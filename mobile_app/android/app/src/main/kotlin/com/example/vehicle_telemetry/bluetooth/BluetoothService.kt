package com.example.vehicle_telemetry.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

class BluetoothService(
    private val context: Context,
    private val onDataReceived: (String) -> Unit,
    private val onStatusChanged: (String) -> Unit
) {
    private val uuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private val bluetoothAdapter: BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private var connectThread: ConnectThread? = null
    private var connectedThread: ConnectedThread? = null

    /**
     * Returns all discoverable Bluetooth Classic devices:
     *  • Already-bonded/paired devices are included immediately.
     *  • A BroadcastReceiver catches ACTION_FOUND during active discovery so
     *    new (unpaired) devices that are powered on and visible are also listed.
     * The callback is invoked once when ACTION_DISCOVERY_FINISHED fires (~12 s),
     * or immediately if startDiscovery() cannot be started.
     */
    @SuppressLint("MissingPermission")
    fun startDiscovery(callback: (List<Map<String, String>>) -> Unit) {
        val found = mutableListOf<Map<String, String>>()

        // Seed with already-bonded devices so they appear even before discovery ends.
        val bonded = bluetoothAdapter?.bondedDevices ?: emptySet()
        bonded.mapTo(found) { device ->
            mapOf(
                "name"       to (device.name ?: "Unknown"),
                "address"    to device.address,
                "deviceType" to "classic"
            )
        }

        // BroadcastReceiver that accumulates ACTION_FOUND hits and fires the
        // callback when discovery finishes.
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (intent.action) {
                    BluetoothDevice.ACTION_FOUND -> {
                        @Suppress("DEPRECATION")
                        val device: BluetoothDevice? =
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                                intent.getParcelableExtra(
                                    BluetoothDevice.EXTRA_DEVICE,
                                    BluetoothDevice::class.java
                                )
                            else
                                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)

                        device?.let {
                            // Deduplicate by MAC address
                            if (found.none { f -> f["address"] == it.address }) {
                                found.add(
                                    mapOf(
                                        "name"       to (it.name ?: "Unknown"),
                                        "address"    to it.address,
                                        "deviceType" to "classic"
                                    )
                                )
                            }
                        }
                    }

                    BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                        try { ctx.unregisterReceiver(this) } catch (_: Exception) {}
                        Handler(Looper.getMainLooper()).post { callback(found) }
                    }
                }
            }
        }

        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        context.registerReceiver(receiver, filter)

        // Cancel any in-progress scan, then start a fresh one.
        bluetoothAdapter?.cancelDiscovery()
        val started = bluetoothAdapter?.startDiscovery() ?: false
        if (!started) {
            // Discovery couldn't start (Bluetooth off, permissions missing, etc.)
            // Unregister immediately and return only the bonded devices.
            try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
            Handler(Looper.getMainLooper()).post { callback(found) }
        }
        // else: wait for ACTION_DISCOVERY_FINISHED (~12 s typical)
    }

    @SuppressLint("MissingPermission")
    fun connect(address: String) {
        val device: BluetoothDevice = bluetoothAdapter?.getRemoteDevice(address) ?: return
        onStatusChanged("connecting")
        connectThread?.cancel()
        connectThread = ConnectThread(device)
        connectThread?.start()
    }

    fun disconnect() {
        connectThread?.cancel()
        connectedThread?.cancel()
        onStatusChanged("disconnected")
    }

    fun write(data: String) {
        connectedThread?.write(data.toByteArray())
    }

    @SuppressLint("MissingPermission")
    private inner class ConnectThread(private val device: BluetoothDevice) : Thread() {
        private val socket: BluetoothSocket? by lazy(LazyThreadSafetyMode.NONE) {
            device.createRfcommSocketToServiceRecord(uuid)
        }

        override fun run() {
            bluetoothAdapter?.cancelDiscovery()
            try {
                socket?.let {
                    it.connect()
                    connected(it)
                }
            } catch (e: IOException) {
                try { socket?.close() } catch (_: IOException) {}
                onStatusChanged("failed")
            }
        }

        fun cancel() {
            try { socket?.close() } catch (_: IOException) {}
        }
    }

    private inner class ConnectedThread(private val socket: BluetoothSocket) : Thread() {
        private val inputStream: InputStream = socket.inputStream
        private val outputStream: OutputStream = socket.outputStream
        private var isRunning = true

        override fun run() {
            val buffer = ByteArray(1024)
            val stringBuilder = StringBuilder()

            while (isRunning) {
                try {
                    val bytes = inputStream.read(buffer)
                    val chunk = String(buffer, 0, bytes)
                    stringBuilder.append(chunk)

                    // OBD adapters terminate each response with '>'
                    if (chunk.contains(">")) {
                        val response = stringBuilder.toString()
                        Handler(Looper.getMainLooper()).post {
                            onDataReceived(response)
                        }
                        stringBuilder.setLength(0)
                    }
                } catch (e: IOException) {
                    if (isRunning) onStatusChanged("disconnected")
                    break
                }
            }
        }

        fun write(bytes: ByteArray) {
            try { outputStream.write(bytes) } catch (_: IOException) {}
        }

        fun cancel() {
            isRunning = false
            try { socket.close() } catch (_: IOException) {}
        }
    }

    private fun connected(socket: BluetoothSocket) {
        connectedThread?.cancel()
        connectedThread = ConnectedThread(socket)
        connectedThread?.start()
        onStatusChanged("connected")
    }
}
