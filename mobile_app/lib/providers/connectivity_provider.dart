import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:vehicle_telemetry/repositories/vehicle_repository.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';

enum ConnectionStatus { online, offline, unknown }

class ConnectivityProvider extends ChangeNotifier {
  final VehicleRepository _repository;
  final SupabaseService _service = SupabaseService();

  ConnectionStatus _status = ConnectionStatus.unknown;
  int _offlineQueueLength = 0;
  bool _isFlushing = false;
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  ConnectionStatus get status => _status;
  int get offlineQueueLength => _offlineQueueLength;
  bool get isOnline => _status == ConnectionStatus.online;
  bool get isFlushing => _isFlushing;

  ConnectivityProvider({VehicleRepository? repository})
      : _repository = repository ?? SupabaseVehicleRepository() {
    _init();
  }

  Future<void> _init() async {
    // Check initial connectivity state
    final results = await Connectivity().checkConnectivity();
    _updateStatus(results);

    // Listen for changes
    _subscription =
        Connectivity().onConnectivityChanged.listen(_updateStatus);

    // Load queue count from SharedPreferences
    await _refreshQueueCount();
  }

  void _updateStatus(List<ConnectivityResult> results) {
    final isConnected = results.any(
      (r) =>
          r == ConnectivityResult.wifi ||
          r == ConnectivityResult.mobile ||
          r == ConnectivityResult.ethernet,
    );
    final newStatus =
        isConnected ? ConnectionStatus.online : ConnectionStatus.offline;

    if (newStatus != _status) {
      _status = newStatus;
      notifyListeners();

      // Auto-flush when coming back online
      if (newStatus == ConnectionStatus.online) {
        flushQueue();
      }
    }
  }

  Future<void> _refreshQueueCount() async {
    _offlineQueueLength = await _service.getOfflineQueueLength();
    notifyListeners();
  }

  Future<void> flushQueue() async {
    if (_isFlushing || !isOnline) return;
    _isFlushing = true;
    notifyListeners();

    try {
      await _repository.flushOfflineQueue();
    } finally {
      _isFlushing = false;
      await _refreshQueueCount();
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}
