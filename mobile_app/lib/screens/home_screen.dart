import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/activity_screen.dart';
import 'package:vehicle_telemetry/screens/alerts_screen.dart';
import 'package:vehicle_telemetry/screens/maintenance_screen.dart';
import 'package:vehicle_telemetry/screens/bluetooth_scan_screen.dart';
import 'package:vehicle_telemetry/screens/dashboard_screen.dart';
import 'package:vehicle_telemetry/screens/profile_screen.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';
import 'package:vehicle_telemetry/services/obd_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';
import 'package:vehicle_telemetry/services/vin_decoder_service.dart';
import 'package:vehicle_telemetry/services/subscription_service.dart';
import 'package:vehicle_telemetry/providers/subscription_provider.dart';
import 'package:vehicle_telemetry/widgets/connection_status.dart';
import 'package:vehicle_telemetry/widgets/locked_screen.dart';
import 'package:vehicle_telemetry/widgets/upgrade_bottom_sheet.dart';
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

  // Bottom navigation tab index
  int _selectedTab = 0;

  // Subscription banner dismiss state (trial-only banners can be dismissed)
  bool _bannerDismissed = false;

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
      final vehicleProvider      = context.read<VehicleProvider>();
      final subscriptionProvider = context.read<SubscriptionProvider>();
      await Future.wait([
        vehicleProvider.loadVehicles(),
        subscriptionProvider.loadForUser(),
      ]);
      // ❸ Drivers are no longer fixed to one vehicle — they connect dynamically
      // via OBD each session. No auto-selection on login.
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

    final prefs         = await SharedPreferences.getInstance();
    final authProvider  = context.read<AuthProvider>();
    // SharedPreferences has fleet_id only from the invite-accept flow.
    // Email/password drivers get it from AuthProvider.
    final fleetId = prefs.getString('fleet_id') ?? authProvider.driverFleetId;

    try {
      // ── Vehicle limit check ──────────────────────────────────────────────
      // Fleet managers go through createOrFindVehicleByVin (direct INSERT).
      // The DB has no trigger for that path, so we check here first.
      // Drivers use the create_vehicle_for_driver RPC which enforces the limit
      // server-side, but we do a pre-check here for a better UX error message.
      if (fleetId != null) {
        final limitResult =
            await SubscriptionService.instance.checkVehicleLimit(fleetId);
        if (!limitResult.allowed) {
          if (!mounted) return;
          final subProvider = context.read<SubscriptionProvider>();
          await UpgradeBottomSheet.show(
            context:         context,
            result:          limitResult,
            planDisplayName: subProvider.planDisplayName,
            isManager:       !authProvider.isDriver,
          );
          return;
        }
      }

      final supabaseService = SupabaseService();
      final Vehicle vehicle;

      if (authProvider.isDriver) {
        // ── Drivers: restricted RLS → must use SECURITY DEFINER RPC ──────
        // Requires migration 20260413 to be applied on the Supabase project.
        vehicle = await supabaseService.getOrCreateVehicleByVin(
          userId:  user.id,
          vin:     vin,
          name:    name,
          make:    make,
          model:   model,
          year:    year,
          fleetId: fleetId,
        );
      } else {
        // ── Fleet managers: full RLS access → direct DB upsert ────────────
        // No migration needed; works even before 20260413 is applied.
        vehicle = await supabaseService.createOrFindVehicleByVin(
          vin:     vin,
          name:    name,
          make:    make,
          model:   model,
          year:    year,
          ownerId: user.id,
          fleetId: fleetId,
        );
      }

      final vehicleProvider = context.read<VehicleProvider>();
      await vehicleProvider.loadVehicles();
      await vehicleProvider.selectVehicle(vehicle);

      // OBD is already connected — start monitoring now that vehicle is known
      if (_connectionState == BtConnectionState.connected) {
        _startMonitoring();
      }

      if (mounted) {
        _showSnackbar('Vehicle registered: ${vehicle.name}', isError: false);
      }
    } catch (e) {
      if (mounted) {
        // Strip nested "Exception:" prefix for a cleaner error message
        final msg = e.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
        _showSnackbar(msg, isError: true);
      }
    }
  }

  // ── Change 6g: Snackbar helper ────────────────────────────────────────────

  void _showSnackbar(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(
        message,
        style: const TextStyle(color: AppColors.textPrimary),
      ),
      backgroundColor:
          isError ? AppColors.statusError : AppColors.accentTeal,
      behavior: SnackBarBehavior.floating,
      duration: Duration(seconds: isError ? 6 : 3),
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

      if (mounted) {
        if (result == true) {
          // Connection confirmed — snackbar is informational; the AppBar badge
          // and dashboard body update automatically via connectionStateStream.
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Row(
                children: [
                  const Icon(Icons.bluetooth_connected,
                      color: Colors.white, size: 18),
                  const SizedBox(width: 8),
                  Text(
                    'Connected to OBD-II adapter'
                    '${_bluetoothService.connectedDeviceName != null ? ': ${_bluetoothService.connectedDeviceName}' : ''}',
                  ),
                ],
              ),
              backgroundColor: const Color(0xFF00BFA5),
              behavior: SnackBarBehavior.floating,
              duration: const Duration(seconds: 4),
            ),
          );
        }
        // result == false → BluetoothScanScreen already showed its own snackbar;
        // the _connectionState stream will have moved to `error` which causes
        // _buildObdConnectPrompt to render the "Connection Failed / Try Again" UI.
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
    return Consumer<SubscriptionProvider>(
      builder: (context, sub, _) {
        final hardExpired = sub.isExpired && !sub.isInGrace;

        return Scaffold(
          backgroundColor: AppColors.bgPrimary,
          appBar: _buildAppBar(),
          body: Column(
            children: [
              // ── Subscription status banner ─────────────────────────────
              _buildSubscriptionBanner(sub),

              // ── Main content ───────────────────────────────────────────
              Expanded(
                child: IndexedStack(
                  index: _selectedTab,
                  children: [
                    // Tab 0 — Dashboard
                    Consumer<VehicleProvider>(
                      builder: (context, vp, _) {
                        if (vp.selectedVehicle == null &&
                            _connectionState != BtConnectionState.connected) {
                          return _buildObdConnectPrompt(hardExpired: hardExpired);
                        }
                        return const DashboardScreen();
                      },
                    ),
                    // Tab 1 — Activity (gated: trip_history)
                    sub.featureAccess('trip_history') != 'none'
                        ? const ActivityScreen()
                        : const LockedScreen(featureName: 'Activity History'),
                    // Tab 2 — Alerts (gated: overspeed_alerts)
                    sub.featureAccess('overspeed_alerts') != 'none'
                        ? const AlertsScreen()
                        : const LockedScreen(featureName: 'Alerts'),
                    // Tab 3 — Maintenance (gated: maintenance_alerts)
                    sub.featureAccess('maintenance_alerts') != 'none'
                        ? const MaintenanceScreen()
                        : const LockedScreen(featureName: 'Maintenance'),
                    // Tab 4 — Profile (always accessible)
                    const ProfileScreen(),
                  ],
                ),
              ),
            ],
          ),
          // FAB: disabled when subscription is hard-expired and not connected
          floatingActionButton: _selectedTab == 0
              ? Consumer<VehicleProvider>(
                  builder: (context, vp, _) {
                    final showPrompt = vp.selectedVehicle == null &&
                        _connectionState != BtConnectionState.connected;
                    if (showPrompt) return const SizedBox.shrink();
                    // Disable connect (but not disconnect) when hard expired
                    final canConnect = !hardExpired ||
                        _connectionState == BtConnectionState.connected;
                    return FloatingActionButton.extended(
                      onPressed: canConnect
                          ? (_connectionState == BtConnectionState.connected
                              ? _disconnect
                              : _connectToBluetooth)
                          : null,
                      icon: Icon(
                        _connectionState == BtConnectionState.connected
                            ? Icons.bluetooth_connected_rounded
                            : Icons.bluetooth_rounded,
                      ),
                      label: Text(
                        _connectionState == BtConnectionState.connected
                            ? 'Disconnect'
                            : hardExpired
                                ? 'Subscription expired'
                                : 'Connect OBD-II',
                      ),
                      backgroundColor: _connectionState ==
                              BtConnectionState.connected
                          ? AppColors.statusError
                          : hardExpired
                              ? AppColors.textLabel
                              : AppColors.accentBlue,
                      foregroundColor: AppColors.textPrimary,
                      elevation: 4,
                    );
                  },
                )
              : null,
          bottomNavigationBar: _buildBottomNav(),
        );
      },
    );
  }

  // ── Subscription status banner ───────────────────────────────────────────────

  Widget _buildSubscriptionBanner(SubscriptionProvider sub) {
    // Nothing to show while loading or if subscription is healthy
    if (sub.loading) return const SizedBox.shrink();

    final hardExpired = sub.isExpired && !sub.isInGrace;
    final days        = sub.trialDaysLeft;
    final isTrial     = sub.status == 'trial';

    // Hard expired — persistent red (non-dismissible)
    if (hardExpired) {
      return _BannerStrip(
        color:       const Color(0xFFEF4444),
        icon:        Icons.lock_rounded,
        message:     'Fleet subscription has expired. Some features are unavailable.',
        dismissible: false,
      );
    }

    // Grace period — persistent orange (non-dismissible)
    if (sub.isInGrace) {
      return _BannerStrip(
        color:       const Color(0xFFF97316),
        icon:        Icons.warning_amber_rounded,
        message:     'Fleet subscription expired. Contact your manager — '
                     'access will be restricted soon.',
        dismissible: false,
      );
    }

    // Trial with ≤ 7 days left — dismissible
    if (isTrial && days != null && days <= 7 && !_bannerDismissed) {
      final color = days <= 1
          ? const Color(0xFFEF4444)   // red
          : days <= 3
              ? const Color(0xFFF97316) // orange
              : const Color(0xFFF59E0B); // amber
      final text = days == 0
          ? 'Your fleet\'s trial expires today. Contact your fleet manager.'
          : 'Your fleet\'s trial ends in $days day${days == 1 ? '' : 's'}. '
            'Contact your fleet manager.';
      return _BannerStrip(
        color:       color,
        icon:        Icons.schedule_rounded,
        message:     text,
        dismissible: true,
        onDismiss:   () => setState(() => _bannerDismissed = true),
      );
    }

    return const SizedBox.shrink();
  }

  PreferredSizeWidget _buildAppBar() {
    return AppBar(
      backgroundColor: AppColors.bgSurface,
      elevation: 0,
      title: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: AppColors.iconBg,
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Icon(
              Icons.directions_car_rounded,
              color: AppColors.accentBlue,
              size: 20,
            ),
          ),
          const SizedBox(width: 10),
          const Text(
            'FTPGo',
            style: TextStyle(
              color: AppColors.textPrimary,
              fontSize: 18,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
            ),
          ),
        ],
      ),
      actions: [
        if (_isCreatingVehicle)
          const Padding(
            padding: EdgeInsets.only(right: 8),
            child: Center(
              child: SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(right: 12),
          child: ConnectionStatusWidget(
            connectionState: _connectionState,
            deviceName: _bluetoothService.connectedDeviceName,
          ),
        ),
      ],
    );
  }

  Widget _buildBottomNav() {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.bgSurface,
        border: Border(
          top: BorderSide(color: AppColors.divider, width: 1),
        ),
      ),
      child: BottomNavigationBar(
        currentIndex: _selectedTab,
        onTap: (index) => setState(() => _selectedTab = index),
        backgroundColor: Colors.transparent,
        elevation: 0,
        selectedItemColor: AppColors.accentBlue,
        unselectedItemColor: AppColors.textLabel,
        type: BottomNavigationBarType.fixed,
        selectedLabelStyle: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
        unselectedLabelStyle: const TextStyle(fontSize: 11),
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.grid_view_rounded),
            activeIcon: Icon(Icons.grid_view_rounded),
            label: 'Dashboard',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.bar_chart_rounded),
            activeIcon: Icon(Icons.bar_chart_rounded),
            label: 'Activity',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.notifications_outlined),
            activeIcon: Icon(Icons.notifications_rounded),
            label: 'Alerts',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.build_outlined),
            activeIcon: Icon(Icons.build_rounded),
            label: 'Maintenance',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.person_outline_rounded),
            activeIcon: Icon(Icons.person_rounded),
            label: 'Profile',
          ),
        ],
      ),
    );
  }

  // ❸ Shown on every login until driver plugs in their OBD adapter.
  // Adapts its UI to reflect the current connection state.
  Widget _buildObdConnectPrompt({ bool hardExpired = false }) {
    final isConnecting = _connectionState == BtConnectionState.connecting;
    final isError      = _connectionState == BtConnectionState.error;

    // Icon + colour for each state
    final iconData  = isConnecting
        ? Icons.bluetooth_searching
        : isError
            ? Icons.bluetooth_disabled
            : Icons.bluetooth_searching;
    final iconColor = isConnecting
        ? Colors.orange
        : isError
            ? Colors.red
            : Colors.blue;
    final bgColor = iconColor.withOpacity(0.12);

    final headline = isConnecting
        ? 'Connecting…'
        : isError
            ? 'Connection Failed'
            : 'Connect your OBD adapter';

    final subtitle = isConnecting
        ? 'Establishing link with the OBD-II adapter.\nPlease wait…'
        : isError
            ? 'Could not connect to the adapter.\nMake sure it is powered on and within range, then try again.'
            : 'Tap the button below to scan for and connect to your vehicle\'s OBD-II adapter. '
              'Your vehicle will be identified automatically.';

    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // State icon
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(color: bgColor, shape: BoxShape.circle),
              child: isConnecting
                  ? Padding(
                      padding: const EdgeInsets.all(22),
                      child: CircularProgressIndicator(
                        strokeWidth: 3,
                        color: iconColor,
                      ),
                    )
                  : Icon(iconData, size: 44, color: iconColor),
            ),
            const SizedBox(height: 24),

            // Headline
            Text(
              headline,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 20,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),

            // Subtitle
            Text(
              subtitle,
              style: TextStyle(color: Colors.grey[400], fontSize: 14, height: 1.5),
              textAlign: TextAlign.center,
            ),

            // Error detail from device name (if any)
            if (isError && _bluetoothService.connectedDeviceName != null) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.red.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _bluetoothService.connectedDeviceName!,
                  style: const TextStyle(color: Colors.redAccent, fontSize: 12),
                  textAlign: TextAlign.center,
                ),
              ),
            ],

            const SizedBox(height: 32),

            // Action button — hidden while connecting
            if (!isConnecting)
              ElevatedButton.icon(
                onPressed: hardExpired ? null : _connectToBluetooth,
                icon: Icon(
                  hardExpired
                      ? Icons.lock_rounded
                      : isError
                          ? Icons.refresh
                          : Icons.bluetooth,
                ),
                label: Text(
                  hardExpired
                      ? 'Subscription expired'
                      : isError
                          ? 'Try Again'
                          : 'Connect OBD-II',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: hardExpired
                      ? Colors.grey[800]
                      : isError
                          ? Colors.red
                          : Colors.blue,
                  padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
          ],
        ),
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
              style: const TextStyle(color: Colors.white, fontSize: 15),
              cursorColor: const Color(0xFF00BFA5),
              decoration: _inputDecoration('Make', 'e.g. Maruti, Tata, Hyundai'),
              validator: (v) =>
                  v == null || v.trim().isEmpty ? 'Required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _modelCtrl,
              style: const TextStyle(color: Colors.white, fontSize: 15),
              cursorColor: const Color(0xFF00BFA5),
              decoration: _inputDecoration('Model', 'e.g. Swift, Nexon, i20'),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _yearCtrl,
              style: const TextStyle(color: Colors.white, fontSize: 15),
              cursorColor: const Color(0xFF00BFA5),
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
        labelText:  label,
        hintText:   hint,
        // Explicit fill so the field always has a dark background regardless
        // of the app/system theme — white typed text stays visible.
        filled:     true,
        fillColor:  const Color(0xFF2A2A40),
        labelStyle: TextStyle(color: Colors.grey[400]),
        hintStyle:  TextStyle(color: Colors.grey[600]),
        // Tighten content padding so it looks balanced in the bottom sheet
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide:   BorderSide(color: Colors.grey[700]!),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide:   const BorderSide(color: Color(0xFF00BFA5), width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide:   const BorderSide(color: Colors.red),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(8),
          borderSide:   const BorderSide(color: Colors.red, width: 1.5),
        ),
        errorStyle: const TextStyle(color: Colors.redAccent, fontSize: 12),
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// _BannerStrip — thin coloured status strip shown below the AppBar
// ─────────────────────────────────────────────────────────────────────────────

class _BannerStrip extends StatelessWidget {
  final Color        color;
  final IconData     icon;
  final String       message;
  final bool         dismissible;
  final VoidCallback? onDismiss;

  const _BannerStrip({
    required this.color,
    required this.icon,
    required this.message,
    required this.dismissible,
    this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width:   double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      color:   color.withOpacity(0.18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                color:    color,
                fontSize: 12,
                height:   1.4,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          if (dismissible && onDismiss != null) ...[
            const SizedBox(width: 8),
            GestureDetector(
              onTap:   onDismiss,
              child: Icon(Icons.close_rounded, size: 15, color: color),
            ),
          ],
        ],
      ),
    );
  }
}
