import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/bluetooth_scan_screen.dart';
import 'package:vehicle_telemetry/screens/dashboard_screen.dart';
import 'package:vehicle_telemetry/screens/login_screen.dart';
import 'package:vehicle_telemetry/screens/vehicle_list_screen.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';
import 'package:vehicle_telemetry/widgets/connection_status.dart';
import 'package:vehicle_telemetry/bluetooth/bt_connection_state.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({Key? key}) : super(key: key);

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final BluetoothService _bluetoothService = BluetoothService();
  BtConnectionState _connectionState = BtConnectionState.disconnected;

  @override
  void initState() {
    super.initState();
    _requestPermissions();
    _bluetoothService.connectionStateStream.listen((state) {
      if (mounted) {
        setState(() {
          _connectionState = state;
        });
      }

      if (state == BtConnectionState.connected) {
        _startMonitoring();
      } else if (state == BtConnectionState.disconnected) {
        _stopMonitoring();
      }
    });

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final vehicleProvider = context.read<VehicleProvider>();
      final authProvider    = context.read<AuthProvider>();
      await vehicleProvider.loadVehicles();
      // Path B (Create Driver): auto-select the vehicle assigned to this driver
      if (authProvider.isDriver && authProvider.driverVehicleId != null) {
        await vehicleProvider.selectVehicleById(authProvider.driverVehicleId!);
      }
    });
  }

  Future<void> _requestPermissions() async {
    Map<Permission, PermissionStatus> statuses = await [
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
      Permission.location,
    ].request();
    
    if (statuses[Permission.bluetoothScan]?.isDenied ?? false) {
      _showPermissionDeniedDialog('Bluetooth Scan');
    }
    if (statuses[Permission.bluetoothConnect]?.isDenied ?? false) {
      _showPermissionDeniedDialog('Bluetooth Connect');
    }
    if (statuses[Permission.location]?.isDenied ?? false) {
      _showPermissionDeniedDialog('Location');
    }
  }

  void _showPermissionDeniedDialog(String permissionName) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('$permissionName permission is required for OBD-II connection.'),
        action: SnackBarAction(
          label: 'Settings',
          onPressed: () => openAppSettings(),
        ),
      ),
    );
  }

  void _startMonitoring() {
    final vehicleProvider = context.read<VehicleProvider>();
    final sensorProvider = context.read<SensorProvider>();
    final vehicle = vehicleProvider.selectedVehicle;

    if (vehicle != null) {
      sensorProvider.startMonitoring(
        vehicle.id,
        vehicle.name,
        vehicleProvider.selectedVehicleThresholds,
      );
    }
  }

  void _stopMonitoring() {
    context.read<SensorProvider>().stopMonitoring();
  }

  Future<void> _connectToBluetooth() async {
    // Re-check permissions before scanning
    if (await Permission.bluetoothScan.isDenied || 
        await Permission.bluetoothConnect.isDenied || 
        await Permission.location.isDenied) {
      await _requestPermissions();
    }

    if (await Permission.bluetoothScan.isGranted && 
        await Permission.bluetoothConnect.isGranted) {
      if (!mounted) return;
      final result = await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const BluetoothScanScreen()),
      );

      if (result == true && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Connected to OBD-II adapter'),
            backgroundColor: Colors.green,
          ),
        );
      }
    }
  }

  Future<void> _disconnect() async {
    await _bluetoothService.disconnect();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Disconnected from OBD-II adapter'),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Consumer<VehicleProvider>(
          builder: (context, vehicleProvider, _) {
            final vehicle = vehicleProvider.selectedVehicle;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Vehicle Telemetry'),
                if (vehicle != null)
                  Text(
                    vehicle.name,
                    style: const TextStyle(fontSize: 12),
                  ),
              ],
            );
          },
        ),
        actions: [
          Center(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ConnectionStatusWidget(
                connectionState: _connectionState,
                deviceName: _bluetoothService.connectedDeviceName,
              ),
            ),
          ),
          PopupMenuButton(
            itemBuilder: (context) => [
              const PopupMenuItem(
                value: 'vehicles',
                child: Row(
                  children: [
                    Icon(Icons.directions_car),
                    SizedBox(width: 8),
                    Text('My Vehicles'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'logout',
                child: Row(
                  children: [
                    Icon(Icons.logout, color: Colors.red),
                    SizedBox(width: 8),
                    Text('Logout', style: TextStyle(color: Colors.red)),
                  ],
                ),
              ),
            ],
            onSelected: (value) {
              if (value == 'vehicles') {
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const VehicleListScreen()),
                );
              } else if (value == 'logout') {
                _logout();
              }
            },
          ),
        ],
      ),
      body: const DashboardScreen(),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _connectionState == BtConnectionState.connected
            ? _disconnect
            : _connectToBluetooth,
        icon: Icon(
          _connectionState == BtConnectionState.connected
              ? Icons.bluetooth_connected
              : Icons.bluetooth,
        ),
        label: Text(
          _connectionState == BtConnectionState.connected
              ? 'Disconnect'
              : 'Connect OBD-II',
        ),
        backgroundColor: _connectionState == BtConnectionState.connected
            ? Colors.red
            : Colors.blue,
      ),
    );
  }

  void _logout() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Logout'),
        content: const Text('Are you sure you want to logout?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () async {
              await context.read<AuthProvider>().signOut();
              if (mounted) {
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute(builder: (_) => const LoginScreen()),
                  (route) => false,
                );
              }
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Logout'),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _stopMonitoring();
    super.dispose();
  }
}
