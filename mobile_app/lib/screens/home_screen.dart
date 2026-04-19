import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:vehicle_telemetry/bluetooth/bt_connection_state.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/alerts_screen.dart';
import 'package:vehicle_telemetry/screens/bluetooth_scan_screen.dart';
import 'package:vehicle_telemetry/screens/dashboard_screen.dart';
import 'package:vehicle_telemetry/screens/settings_screen.dart';
import 'package:vehicle_telemetry/screens/trips_screen.dart';
import 'package:vehicle_telemetry/screens/vehicle_list_screen.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';
import 'package:vehicle_telemetry/services/heartbeat_service.dart';
import 'package:vehicle_telemetry/services/location_service.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/services/tracking_persistence_service.dart';
import 'package:vehicle_telemetry/services/vin_service.dart';
import 'package:vehicle_telemetry/theme/app_colors.dart';
import 'package:vehicle_telemetry/widgets/connection_status.dart';
import 'package:vehicle_telemetry/widgets/quick_vitals_strip.dart';
import 'package:vehicle_telemetry/widgets/vehicle_hero_card.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final BluetoothService _bluetoothService = BluetoothService();
  final OBDService _obdService = OBDService();
  final SupabaseService _supabaseService = SupabaseService();

  BtConnectionState _connectionState = BtConnectionState.disconnected;
  int _currentTab = 0;

  // Cached provider references — populated in didChangeDependencies() so they
  // are safe to use from dispose() and stream callbacks after widget unmount.
  late SensorProvider _sensorProvider;
  late VehicleProvider _vehicleProvider;
  late AuthProvider _authProvider;

  // VIN stream subscription — cancelled in dispose().
  StreamSubscription<String?>? _vinSubscription;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sensorProvider = context.read<SensorProvider>();
    _vehicleProvider = context.read<VehicleProvider>();
    _authProvider = context.read<AuthProvider>();
  }

  @override
  void initState() {
    super.initState();
    _requestPermissions();

    // Single EventChannel listener — OBDService owns the channel and
    // dispatches sensor data, connection status, and VIN events.
    _obdService.init();

    // ── Connection state stream ─────────────────────────────────────────────
    // NOTE: connectAdapter() in Kotlin returns result.success() immediately
    // (before the socket opens), so BluetoothScanScreen pops as soon as the
    // background thread confirms the socket is open.  startMonitoring() MUST
    // only be called here (when Kotlin confirms "connected") — not from
    // _connectToBluetooth() — to guarantee the OBD init sequence runs on a
    // live socket.
    _obdService.connectionStateStream.listen((status) {
      final state = _mapStatusToState(status);
      if (mounted) {
        setState(() => _connectionState = state);
        if (state == BtConnectionState.connected &&
            _authProvider.isAuthenticated) {
          _startMonitoring();
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Connected to OBD-II adapter — reading vehicle VIN…'),
              backgroundColor: kSuccess,
            ),
          );
        }
      }
      if (state == BtConnectionState.disconnected ||
          state == BtConnectionState.failed) {
        _stopMonitoring();
      }
    });

    // ── VIN auto-registration stream ────────────────────────────────────────
    _vinSubscription = _obdService.vinStream.listen((vin) async {
      String resolvedVin;
      String make = 'Unknown';
      String model = 'Vehicle';
      int year = DateTime.now().year;
      String displayName;

      if (vin != null && vin.isNotEmpty) {
        final info = await VinService.decode(vin);
        if (info != null) {
          resolvedVin = info.vin;
          make = info.make;
          model = info.model;
          year = info.year;
          displayName = info.displayName;
        } else {
          resolvedVin = vin;
          displayName = 'Vehicle ($vin)';
        }
      } else {
        final userId = _authProvider.user?.id ?? 'unknown';
        resolvedVin = 'DRIVER-$userId';
        displayName = 'My Vehicle';
      }

      if (!mounted) return;

      final vehicle = await _supabaseService.getOrCreateVehicleByVin(
        vin: resolvedVin,
        make: make,
        model: model,
        year: year,
        fleetId: _authProvider.driverFleetId,
      );

      if (vehicle == null || !mounted) return;

      await _vehicleProvider.loadVehicles();
      if (!mounted) return;
      await _vehicleProvider.selectVehicleById(vehicle.id);
      await _supabaseService.updateDriverVehicle(vehicle.id);

      _stopMonitoring();
      _startMonitoring();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Vehicle detected: $displayName'),
            backgroundColor: kSuccess,
            duration: const Duration(seconds: 4),
          ),
        );
      }
    });

    // ── Load vehicles on startup + restore tracking after kill/reboot ─────────
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _vehicleProvider.loadVehicles();

      if (!mounted) return;
      final driverVehicleId = _authProvider.driverVehicleId;
      if (driverVehicleId != null) {
        await _vehicleProvider.selectVehicleById(driverVehicleId);
      }

      if (mounted) await _restoreTrackingIfNeeded();
    });
  }

  BtConnectionState _mapStatusToState(String status) {
    switch (status) {
      case 'connected':
        return BtConnectionState.connected;
      case 'connecting':
        return BtConnectionState.connecting;
      case 'failed':
        return BtConnectionState.failed;
      default:
        return BtConnectionState.disconnected;
    }
  }

  Future<void> _requestPermissions() async {
    final statuses = await [
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
      Permission.location,
    ].request();

    if (statuses[Permission.bluetoothScan]?.isDenied ?? false) {
      _showPermissionDeniedSnack('Bluetooth Scan');
    }
    if (statuses[Permission.bluetoothConnect]?.isDenied ?? false) {
      _showPermissionDeniedSnack('Bluetooth Connect');
    }
    if (statuses[Permission.location]?.isDenied ?? false) {
      _showPermissionDeniedSnack('Location');
    }
  }

  void _showPermissionDeniedSnack(String permissionName) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
            '$permissionName permission is required for OBD-II connection.'),
        action: SnackBarAction(label: 'Settings', onPressed: openAppSettings),
      ),
    );
  }

  /// If the app was killed or the device rebooted while a trip was active,
  /// restart GPS tracking and heartbeats automatically — no OBD required.
  ///
  /// When OBD later connects, SensorProvider.startMonitoring() ends this
  /// GPS-only trip and creates a fresh one that includes OBD sensor data.
  Future<void> _restoreTrackingIfNeeded() async {
    final locationService = LocationService();
    if (locationService.isTracking) return; // Already live — nothing to do.

    final vehicleId = await TrackingPersistenceService.restore();
    if (vehicleId == null) return;

    final resumed = await locationService.startTrip(vehicleId);
    if (!resumed || !mounted) return;

    HeartbeatService().start(vehicleId);

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('GPS tracking resumed'),
        backgroundColor: Color(0xFF059669),
        duration: Duration(seconds: 3),
      ),
    );
    debugPrint('HomeScreen: tracking restored for vehicle $vehicleId after kill/reboot');
  }

  void _startMonitoring() {
    final vehicle = _vehicleProvider.selectedVehicle;
    _sensorProvider.startMonitoring(
      vehicle?.id,
      vehicle?.name,
      vehicle != null ? _vehicleProvider.selectedVehicleThresholds : const [],
    );
  }

  void _stopMonitoring() {
    _sensorProvider.stopMonitoring();
  }

  Future<void> _connectToBluetooth() async {
    if (await Permission.bluetoothScan.isDenied ||
        await Permission.bluetoothConnect.isDenied ||
        await Permission.location.isDenied) {
      await _requestPermissions();
    }

    if (await Permission.bluetoothScan.isGranted &&
        await Permission.bluetoothConnect.isGranted) {
      if (!mounted) return;
      final result = await BluetoothScanScreen.show(context);

      if (result == true && mounted) {
        // BT socket is now open (BluetoothScanScreen waited for the
        // 'connected' event before returning true).  startMonitoring() will
        // be called by the connectionStateStream listener above — no need to
        // call it here, and doing so would cause a race with the listener.
        setState(() => _connectionState = BtConnectionState.connected);
      }
    }
  }

  Future<void> _disconnect() async {
    await _bluetoothService.disconnect();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Disconnected from OBD-II adapter')),
      );
    }
  }

  Widget _buildDashboardTab(
    SensorProvider sensorProvider,
    VehicleProvider vehicleProvider,
  ) {
    return Column(
      children: [
        VehicleHeroCard(
          vehicle: vehicleProvider.selectedVehicle,
          isConnected: _connectionState == BtConnectionState.connected,
          activeCount: sensorProvider.latestSensorData.length,
          totalCount: 96,
        ),
        QuickVitalsStrip(sensorData: sensorProvider.latestSensorData),
        const SizedBox(height: 8),
        Expanded(
          child: DashboardScreen(
            isObdConnected: _connectionState == BtConnectionState.connected,
          ),
        ),
      ],
    );
  }

  Widget _buildAlertBadgeIcon(SensorProvider sensorProvider) {
    final hasWarning = sensorProvider.latestSensorData.values
        .any((data) => data.isWarning);

    return Stack(
      clipBehavior: Clip.none,
      children: [
        const Icon(Icons.notifications),
        if (hasWarning)
          Positioned(
            top: -2,
            right: -2,
            child: Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(
                color: kDanger,
                shape: BoxShape.circle,
              ),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Consumer2<SensorProvider, VehicleProvider>(
      builder: (context, sensorProvider, vehicleProvider, _) {
        return Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Image.asset(
                  'assets/images/logo.png',
                  height: 28,
                  fit: BoxFit.contain,
                ),
                if (vehicleProvider.selectedVehicle != null &&
                    _connectionState == BtConnectionState.connected)
                  Text(
                    vehicleProvider.selectedVehicle!.name,
                    style: const TextStyle(
                      fontSize: 12,
                      color: kMuted,
                    ),
                  ),
              ],
            ),
            actions: [
              Center(
                child: Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child:
                      ConnectionStatusWidget(connectionState: _connectionState),
                ),
              ),
            ],
          ),
          body: IndexedStack(
            index: _currentTab,
            children: [
              _buildDashboardTab(sensorProvider, vehicleProvider),
              const VehicleListScreen(),
              const AlertsScreen(),
              const TripsScreen(),
              const SettingsScreen(),
            ],
          ),
          floatingActionButton: _currentTab == 0
              ? FloatingActionButton.extended(
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
                  backgroundColor:
                      _connectionState == BtConnectionState.connected
                          ? kDanger
                          : kPrimary,
                )
              : null,
          bottomNavigationBar: BottomNavigationBar(
            currentIndex: _currentTab,
            onTap: (index) => setState(() => _currentTab = index),
            items: [
              const BottomNavigationBarItem(
                icon: Icon(Icons.dashboard),
                label: 'Dashboard',
              ),
              const BottomNavigationBarItem(
                icon: Icon(Icons.directions_car),
                label: 'Vehicles',
              ),
              BottomNavigationBarItem(
                icon: _buildAlertBadgeIcon(sensorProvider),
                label: 'Alerts',
              ),
              const BottomNavigationBarItem(
                icon: Icon(Icons.route_outlined),
                label: 'Trips',
              ),
              const BottomNavigationBarItem(
                icon: Icon(Icons.settings),
                label: 'Settings',
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  void dispose() {
    _vinSubscription?.cancel();
    _sensorProvider.stopMonitoring();
    super.dispose();
  }
}
