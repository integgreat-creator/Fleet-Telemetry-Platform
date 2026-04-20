import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart' as fbp;
import 'package:flutter_bluetooth_serial/flutter_bluetooth_serial.dart' as classic;
import '../services/bluetooth_service.dart';

class BluetoothScanScreen extends StatefulWidget {
  const BluetoothScanScreen({super.key});

  static Future<bool?> show(BuildContext context) {
    return Navigator.of(context).push<bool?>(
      MaterialPageRoute(builder: (_) => const BluetoothScanScreen()),
    );
  }

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
                  Text("Scanning for OBD-II adapters…"),
                  SizedBox(height: 8),
                  Padding(
                    padding: EdgeInsets.symmetric(horizontal: 40),
                    child: Text(
                      "Make sure your OBD-II adapter is plugged in and powered on.",
                      style: TextStyle(fontSize: 12, color: Colors.grey),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
              ),
            );
          }

          final results = snapshot.data!;

          return Column(
            children: [
              // Tip banner
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(12, 10, 12, 4),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A2D4D),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFF3B82F6).withOpacity(0.4)),
                ),
                child: Row(
                  children: const [
                    Icon(Icons.info_outline, color: Color(0xFF3B82F6), size: 18),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'ELM327 OBD-II adapters use Classic BT. '
                        'Select "Classic BT" if your adapter appears twice.',
                        style: TextStyle(
                          color: Color(0xFF8994B0),
                          fontSize: 12,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView.builder(
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

              // Determine if device is bonded (Classic only)
              final isBonded = device is classic.BluetoothDevice && (device.isBonded ?? false);

              return ListTile(
                leading: Icon(
                  isBle ? Icons.bluetooth_audio : Icons.bluetooth,
                  color: isBonded ? const Color(0xFF3B82F6) : null,
                ),
                title: Row(
                  children: [
                    Expanded(child: Text(name, style: const TextStyle(fontWeight: FontWeight.w500))),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: isBle
                            ? const Color(0xFF1565C0)
                            : const Color(0xFF6A1B9A),
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
                subtitle: Text(
                  isBonded ? '$id  •  Paired' : id,
                  style: TextStyle(
                    color: isBonded
                        ? const Color(0xFF3B82F6)
                        : null,
                    fontSize: 12,
                  ),
                ),
                trailing: isBonded
                    ? const Icon(Icons.link_rounded, color: Color(0xFF3B82F6))
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
                    Navigator.of(context).pop(); // Close connecting dialog
                    if (success) {
                      Navigator.of(context).pop(true); // Return success to Home
                    } else {
                      // Show brief snackbar, then also pop so Home shows error state
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Row(
                            children: [
                              const Icon(Icons.bluetooth_disabled,
                                  color: Colors.white, size: 18),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  'Could not connect to $name. Make sure it is powered on.',
                                ),
                              ),
                            ],
                          ),
                          backgroundColor: Colors.red[700],
                          behavior: SnackBarBehavior.floating,
                          duration: const Duration(seconds: 3),
                        ),
                      );
                      // Pop with false so HomeScreen can show the error state
                      Future.delayed(const Duration(milliseconds: 400), () {
                        if (mounted) Navigator.of(context).pop(false);
                      });
                    }
                  }
                },
              );
            },
          ),
                ),
              ],
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
