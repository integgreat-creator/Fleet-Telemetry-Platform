import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';

class AuthProvider extends ChangeNotifier {
  final _client = SupabaseConfig.client;

  User?   _user;
  bool    _isLoading      = false;
  String? _errorMessage;

  // Driver-specific fields loaded after sign-in
  String? _driverVehicleId;
  String? _driverFleetId;
  bool    _hasDriverAccount = false;

  User?   get user             => _user;
  bool    get isLoading        => _isLoading;
  String? get errorMessage     => _errorMessage;
  bool    get isAuthenticated  => _user != null;
  String? get driverVehicleId  => _driverVehicleId;
  String? get driverFleetId    => _driverFleetId;
  bool    get isDriver         => _hasDriverAccount;

  AuthProvider() {
    _user = _client.auth.currentUser;
    // Restore driver account state on app restart with persisted session
    if (_user != null) {
      _loadDriverAccount().then((_) => notifyListeners());
    }
    _client.auth.onAuthStateChange.listen((data) {
      final prev = _user?.id;
      _user = data.session?.user;
      if (_user != null && _user!.id != prev) {
        _loadDriverAccount().then((_) => notifyListeners());
      } else if (_user == null) {
        _clearDriverAccount();
        notifyListeners();
      } else {
        notifyListeners();
      }
    });
  }

  /// Fetches the driver_accounts row for the current user (if any).
  /// Called after every sign-in and on app restart with a persisted session.
  Future<void> _loadDriverAccount() async {
    if (_user == null) return;
    try {
      final rows = await _client
          .from('driver_accounts')
          .select('vehicle_id, fleet_id')
          .eq('user_id', _user!.id)
          .limit(1);

      if (rows.isNotEmpty) {
        _driverVehicleId  = rows.first['vehicle_id'] as String?;
        _driverFleetId    = rows.first['fleet_id']   as String?;
        _hasDriverAccount = true;
      } else {
        _clearDriverAccount();
      }
    } catch (_) {
      _clearDriverAccount();
    }
  }

  void _clearDriverAccount() {
    _driverVehicleId  = null;
    _driverFleetId    = null;
    _hasDriverAccount = false;
  }

  Future<bool> signIn(String email, String password) async {
    try {
      _isLoading    = true;
      _errorMessage = null;
      notifyListeners();

      final response = await _client.auth.signInWithPassword(
        email:    email,
        password: password,
      );

      _user = response.user;
      await _loadDriverAccount();

      _isLoading = false;
      notifyListeners();
      return true;
    } on AuthException catch (e) {
      _errorMessage = e.message;
      _isLoading    = false;
      notifyListeners();
      return false;
    } catch (_) {
      _errorMessage = 'An unexpected error occurred';
      _isLoading    = false;
      notifyListeners();
      return false;
    }
  }

  Future<void> signOut() async {
    try {
      await _client.auth.signOut();
      _user = null;
      _clearDriverAccount();
      notifyListeners();
    } catch (e) {
      debugPrint('Sign out error: $e');
    }
  }

  void clearError() {
    _errorMessage = null;
    notifyListeners();
  }
}
