import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';

class AuthProvider extends ChangeNotifier {
  final _client = SupabaseConfig.client;

  User?   _user;
  bool    _isLoading      = false;
  String? _errorMessage;

  // Driver-specific fields loaded after sign-in
  String? _driverAccountId;   // driver_accounts.id (not auth user id)
  String? _driverVehicleId;
  String? _driverFleetId;
  bool    _hasDriverAccount = false;

  User?   get user              => _user;
  bool    get isLoading         => _isLoading;
  String? get errorMessage      => _errorMessage;
  bool    get isAuthenticated   => _user != null;
  String? get driverAccountId   => _driverAccountId;  // for sensor/log attribution
  String? get driverVehicleId   => _driverVehicleId;
  String? get driverFleetId     => _driverFleetId;
  bool    get isDriver          => _hasDriverAccount;

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
  /// Also records first_login_at on the very first successful login.
  Future<void> _loadDriverAccount() async {
    if (_user == null) return;
    try {
      final rows = await _client
          .from('driver_accounts')
          .select('id, vehicle_id, fleet_id, first_login_at')
          .eq('user_id', _user!.id)
          .limit(1);

      if (rows.isNotEmpty) {
        _driverAccountId  = rows.first['id']            as String?;
        _driverVehicleId  = rows.first['vehicle_id']    as String?;
        _driverFleetId    = rows.first['fleet_id']      as String?;
        _hasDriverAccount = true;

        // MOB-1: stamp first_login_at on the driver's very first login
        final firstLoginAt = rows.first['first_login_at'];
        if (firstLoginAt == null && _driverAccountId != null) {
          try {
            await _client
                .from('driver_accounts')
                .update({'first_login_at': DateTime.now().toIso8601String()})
                .eq('id', _driverAccountId!);
          } catch (_) {
            // Non-fatal — analytics only
          }
        }
      } else {
        _clearDriverAccount();
      }
    } catch (_) {
      _clearDriverAccount();
    }
  }

  void _clearDriverAccount() {
    _driverAccountId  = null;
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

  /// MOB-3: Sign in using phone number.
  /// Looks up the driver_accounts table for a matching phone number,
  /// retrieves the associated email, then calls signInWithPassword.
  /// This is a client-safe lookup — phone is not a secret identifier.
  Future<bool> signInWithPhone(String phone, String password) async {
    try {
      _isLoading    = true;
      _errorMessage = null;
      notifyListeners();

      // Normalise phone: keep digits and leading +
      final normalised = phone.trim();

      // Look up email from driver_accounts by phone
      final rows = await _client
          .from('driver_accounts')
          .select('email')
          .eq('phone', normalised)
          .limit(1);

      if (rows.isEmpty) {
        _errorMessage = 'No driver account found with this phone number';
        _isLoading    = false;
        notifyListeners();
        return false;
      }

      final email = rows.first['email'] as String?;
      if (email == null || email.isEmpty) {
        _errorMessage = 'Driver account has no email — use email to sign in';
        _isLoading    = false;
        notifyListeners();
        return false;
      }

      // Delegate to existing email sign-in
      _isLoading = false;  // reset before calling signIn (it sets it again)
      return signIn(email, password);
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
