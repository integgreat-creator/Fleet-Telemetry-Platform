package com.example.vehicle_telemetry

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.*

class BluetoothService(private val onDataReceived: (String) -> Unit, private val onStatusChanged: (String) -> Unit) {
    private val uuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private var bluetoothAdapter: BluetoothAdapter? = BluetoothAdapter.getDefaultAdapter()
    private var connectThread: ConnectThread? = null
    private var connectedThread: ConnectedThread? = null

    @SuppressLint("MissingPermission")
    fun connect(address: String) {
        val device = bluetoothAdapter?.getRemoteDevice(address) ?: return
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
                try {
                    socket?.close()
                } catch (e2: IOException) {}
                onStatusChanged("disconnected")
            }
        }

        fun cancel() {
            try {
                socket?.close()
            } catch (e: IOException) {}
        }
    }

    private inner class ConnectedThread(private val socket: BluetoothSocket) : Thread() {
        private val inputStream: InputStream = socket.inputStream
        private val outputStream: OutputStream = socket.outputStream
        private var isRunning = true

        override fun run() {
            val buffer = ByteArray(1024)
            var bytes: Int
            val stringBuilder = StringBuilder()

            while (isRunning) {
                try {
                    bytes = inputStream.read(buffer)
                    val readData = String(buffer, 0, bytes)
                    stringBuilder.append(readData)
                    
                    if (readData.contains(">")) {
                        val response = stringBuilder.toString()
                        Handler(Looper.getMainLooper()).post {
                            onDataReceived(response)
                        }
                        stringBuilder.setLength(0)
                    }
                } catch (e: IOException) {
                    onStatusChanged("disconnected")
                    break
                }
            }
        }

        fun write(bytes: ByteArray) {
            try {
                outputStream.write(bytes)
            } catch (e: IOException) {}
        }

        fun cancel() {
            isRunning = false
            try {
                socket.close()
            } catch (e: IOException) {}
        }
    }

    private fun connected(socket: BluetoothSocket) {
        connectedThread?.cancel()
        connectedThread = ConnectedThread(socket)
        connectedThread?.start()
        onStatusChanged("connected")
    }
}
