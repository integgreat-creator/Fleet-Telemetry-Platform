import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/bluetooth_scan_screen.dart';
import 'package:vehicle_telemetry/screens/dashboard_screen.dart';
import 'package:vehicle_telemetry/screens/login_screen.dart';
import 'package:vehicle_telemetry/screens/vehicle_list_screen.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/services/vin_decoder_service.dart';
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

  // VIN decoder + vehicle creation state (Change 6b)
  final VinDecoderService _vinDecoder = VinDecoderService();
  bool _isCreatingVehicle = false;

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
        _onOBDConnected(); // Change 6c
      } else if (state == BtConnectionState.disconnected) {
        _stopMonitoring();
      }
    });

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final vehicleProvider = context.read<VehicleProvider>();
      final authProvider    = context.read<AuthProvider>();
      await vehicleProvider.loadVehicles();
      // Path B (Create Driver): auto-select the vehicle assigned to this driver
      // Change 6i: null-safety check instead of !
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
    final sensorProvider  = context.read<SensorProvider>();
    final authProvider    = context.read<AuthProvider>();
    final vehicle         = vehicleProvider.selectedVehicle;

    if (vehicle != null) {
      sensorProvider.startMonitoring(
        vehicle.id,
        vehicle.name,
        vehicleProvider.selectedVehicleThresholds,
        driverAccountId: authProvider.driverAccountId,  // MOB-2: attribute data to driver
      );
    }
  }

  void _stopMonitoring() {
    context.read<SensorProvider>().stopMonitoring();
  }

  // ── Change 6d: Post-OBD connection VIN read + vehicle creation ──────────

  Future<void> _onOBDConnected() async {
    final vehicleProvider = context.read<VehicleProvider>();
    // If driver already has a vehicle selected, skip registration
    if (vehicleProvider.selectedVehicle != null) return;

    setState(() => _isCreatingVehicle = true);

    try {
      // Step 1: attempt to read VIN from OBD via Mode 09 PID 02
      String? vin;
      try {
        vin = await OBDService().readVin();
      } catch (_) {
        vin = null;
      }

      if (!mounted) return;

      if (vin != null && vin.length >= 11) {
        // Step 2a: decode VIN
        final result = await _vinDecoder.decode(vin);
        if (!mounted) return;

        if (!result.isPartialDecode && result.make != null && result.model != null) {
          // Full decode — create vehicle automatically
          await _createVehicleRecord(
            vin: vin,
            name: result.displayName ?? 'My Vehicle',
            make: result.make,
            model: result.model,
            year: result.year,
          );
          _showSnackbar('Vehicle registered: ${result.displayName ?? vin}');
        } else {
          // Partial decode (WMI only) — show bottom sheet with make pre-filled
          _showVehicleDetailsSheet(
            vin: vin,
            prefilledMake: result.make,
          );
        }
      } else {
        // No VIN — show full manual entry sheet
        _showVehicleDetailsSheet(vin: null, prefilledMake: null);
      }
    } finally {
      if (mounted) setState(() => _isCreatingVehicle = false);
    }
  }

  // ── Change 6e: Vehicle details bottom sheet ──────────────────────────────

  void _showVehicleDetailsSheet({String? vin, String? prefilledMake}) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1E1E2E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => _VehicleEntrySheet(
        prefilledMake: prefilledMake,
        onSave: (make, model, year) {
          Navigator.pop(ctx);
          final effectiveVin = vin ??
              'DRIVER-${Supabase.instance.client.auth.currentUser?.id ?? 'unknown'}';
          final name =
              '${year != null ? '$year ' : ''}$make${model.isNotEmpty ? ' $model' : ''}';
          _createVehicleRecord(
            vin: effectiveVin,
            name: name.trim().isEmpty ? 'My Vehicle' : name.trim(),
            make: make.isEmpty ? null : make,
            model: model.isEmpty ? null : model,
            year: year,
          );
        },
        onSkip: () {
          Navigator.pop(ctx);
          final effectiveVin =
              'DRIVER-${Supabase.instance.client.auth.currentUser?.id ?? 'unknown'}';
          _createVehicleRecord(
            vin: effectiveVin,
            name: 'My Vehicle',
            make: null,
            model: null,
            year: null,
          );
        },
      ),
    );
  }

  // ── Change 6f: Create vehicle record ─────────────────────────────────────

  Future<void> _createVehicleRecord({
    required String vin,
    required String name,
    String? make,
    String? model,
    int? year,
  }) async {
    final user = Supabase.instance.client.auth.currentUser;
    if (user == null) return;

    final prefs = await SharedPreferences.getInstance();
    final fleetId = prefs.getString('fleet_id');

    try {
      final supabaseService = SupabaseService();
      final vehicle = await supabaseService.getOrCreateVehicleByVin(
        userId: user.id,
        vin: vin,
        name: name,
        make: make,
        model: model,
        year: year,
        fleetId: fleetId,
      );

      final vehicleProvider = context.read<VehicleProvider>();
      await vehicleProvider.loadVehicles();
      await vehicleProvider.selectVehicle(vehicle);

      if (mounted) {
        _showSnackbar('Vehicle registered: ${vehicle.name}', isError: false);
      }
    } catch (e) {
      if (mounted) {
        _showSnackbar('Failed to register vehicle: $e', isError: true);
      }
    }
  }

  // ── Change 6g: Snackbar helper ────────────────────────────────────────────

  void _showSnackbar(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: isError ? Colors.red[700] : const Color(0xFF00BFA5),
      behavior: SnackBarBehavior.floating,
    ));
  }

  // ─────────────────────────────────────────────────────────────────────────

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
          if (_isCreatingVehicle)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: Center(
                child: SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white70,
                  ),
                ),
              ),
            ),
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

// ---------------------------------------------------------------------------
// Change 6h: _VehicleEntrySheet — private StatefulWidget
// ---------------------------------------------------------------------------

class _VehicleEntrySheet extends StatefulWidget {
  final String? prefilledMake;
  final void Function(String make, String model, int? year) onSave;
  final VoidCallback onSkip;

  const _VehicleEntrySheet({
    this.prefilledMake,
    required this.onSave,
    required this.onSkip,
  });

  @override
  State<_VehicleEntrySheet> createState() => _VehicleEntrySheetState();
}

class _VehicleEntrySheetState extends State<_VehicleEntrySheet> {
  late final TextEditingController _makeCtrl;
  final TextEditingController _modelCtrl = TextEditingController();
  final TextEditingController _yearCtrl = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  @override
  void initState() {
    super.initState();
    _makeCtrl = TextEditingController(text: widget.prefilledMake ?? '');
    _yearCtrl.text = DateTime.now().year.toString();
  }

  @override
  void dispose() {
    _makeCtrl.dispose();
    _modelCtrl.dispose();
    _yearCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
          24, 24, 24, MediaQuery.of(context).viewInsets.bottom + 24),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Vehicle Details',
              style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                  color: Colors.white),
            ),
            const SizedBox(height: 8),
            Text(
              widget.prefilledMake != null
                  ? 'We identified the manufacturer. Please fill in the model and year.'
                  : 'Enter your vehicle details to register it with the fleet.',
              style: TextStyle(color: Colors.grey[400], fontSize: 14),
            ),
            const SizedBox(height: 20),
            TextFormField(
              controller: _makeCtrl,
              style: const TextStyle(color: Colors.white),
              decoration: _inputDecoration('Make', 'e.g. Maruti, Tata, Hyundai'),
              validator: (v) =>
                  v == null || v.trim().isEmpty ? 'Required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _modelCtrl,
              style: const TextStyle(color: Colors.white),
              decoration: _inputDecoration('Model', 'e.g. Swift, Nexon, i20'),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _yearCtrl,
              style: const TextStyle(color: Colors.white),
              keyboardType: TextInputType.number,
              decoration: _inputDecoration('Year', 'e.g. 2022'),
              validator: (v) {
                if (v == null || v.isEmpty) return null;
                final y = int.tryParse(v);
                if (y == null || y < 1980 || y > DateTime.now().year + 1) {
                  return 'Invalid year';
                }
                return null;
              },
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF00BFA5),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    onPressed: () {
                      if (_formKey.currentState!.validate()) {
                        widget.onSave(
                          _makeCtrl.text.trim(),
                          _modelCtrl.text.trim(),
                          int.tryParse(_yearCtrl.text.trim()),
                        );
                      }
                    },
                    child: const Text(
                      'Save',
                      style: TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(
                  onPressed: widget.onSkip,
                  child: Text(
                    'Skip',
                    style: TextStyle(color: Colors.grey[400]),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  InputDecoration _inputDecoration(String label, String hint) =>
      InputDecoration(
        labelText: label,
        hintText: hint,
        labelStyle: TextStyle(color: Colors.grey[400]),
        hintStyle: TextStyle(color: Colors.grey[600]),
        enabledBorder: OutlineInputBorder(
            borderSide: BorderSide(color: Colors.grey[700]!)),
        focusedBorder: const OutlineInputBorder(
            borderSide: BorderSide(color: Color(0xFF00BFA5))),
        errorBorder:
            const OutlineInputBorder(borderSide: BorderSide(color: Colors.red)),
        focusedErrorBorder:
            const OutlineInputBorder(borderSide: BorderSide(color: Colors.red)),
      );
}
