import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart' as fbp;
import 'package:flutter_bluetooth_serial/flutter_bluetooth_serial.dart' as classic;
import '../services/bluetooth_service.dart';

class BluetoothScanScreen extends StatefulWidget {
  const BluetoothScanScreen({super.key});

  @override
  State<BluetoothScanScreen> createState() => _BluetoothScanScreenState();
}

class _BluetoothScanScreenState extends State<BluetoothScanScreen> {
  final BluetoothService _bluetoothService = BluetoothService();

  @override
  void initState() {
    super.initState();
    _bluetoothService.startScan();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Scan OBD-II Devices"),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => _bluetoothService.startScan(),
          )
        ],
      ),
      body: StreamBuilder<List<dynamic>>(
        stream: _bluetoothService.combinedScanResults,
        builder: (context, snapshot) {
          if (!snapshot.hasData || snapshot.data!.isEmpty) {
            return const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 16),
                  Text("Scanning for adapters (BLE & Classic)..."),
                ],
              ),
            );
          }

          final results = snapshot.data!;

          return ListView.builder(
            itemCount: results.length,
            itemBuilder: (context, index) {
              final device = results[index];
              String name = "Unknown Device";
              String id = "";
              bool isBle = false;

              if (device is fbp.BluetoothDevice) {
                name = device.platformName.isEmpty ? "Unknown BLE" : device.platformName;
                id = device.remoteId.toString();
                isBle = true;
              } else if (device is classic.BluetoothDevice) {
                name = device.name ?? "Unknown Classic";
                id = device.address;
                isBle = false;
              }

              return ListTile(
                leading: Icon(isBle ? Icons.bluetooth_audio : Icons.bluetooth),
                title: Row(
                  children: [
                    Expanded(child: Text(name)),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: isBle
                            ? const Color(0xFF1565C0)   // deep blue for BLE
                            : const Color(0xFF6A1B9A),  // deep purple for Classic BT
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        isBle ? 'BLE' : 'Classic BT',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 0.3,
                        ),
                      ),
                    ),
                  ],
                ),
                subtitle: Text(id),
                trailing: device is classic.BluetoothDevice && device.isBonded
                    ? const Icon(Icons.link, color: Colors.blue)
                    : null,
                onTap: () async {
                  _showConnectingDialog(name);
                  bool success = false;
                  if (isBle) {
                    success = await _bluetoothService.connectBle(device as fbp.BluetoothDevice);
                  } else {
                    success = await _bluetoothService.connectClassic(device as classic.BluetoothDevice);
                  }

                  if (mounted) {
                    Navigator.of(context).pop(); // Close dialog
                    if (success) {
                      Navigator.of(context).pop(true); // Return success to Home
                    } else {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text("Failed to connect. Ensure device is powered and in range.")),
                      );
                    }
                  }
                },
              );
            },
          );
        },
      ),
    );
  }

  void _showConnectingDialog(String name) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        content: Row(
          children: [
            const CircularProgressIndicator(),
            const SizedBox(width: 20),
            Text("Connecting to $name..."),
          ],
        ),
      ),
    );
  }
}
