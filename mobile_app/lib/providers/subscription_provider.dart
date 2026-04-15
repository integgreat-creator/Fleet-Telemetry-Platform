import 'package:flutter/foundation.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/services/subscription_service.dart';

/// Flutter provider that wraps [SubscriptionService] and exposes
/// subscription state to the widget tree.
///
/// Call [loadForUser()] once after authentication (e.g. in HomeScreen.initState)
/// to populate the state. Subsequent calls to [refresh()] re-fetch and notify.
class SubscriptionProvider extends ChangeNotifier {
  final _client = SupabaseConfig.client;

  SubscriptionState _state   = SubscriptionState.empty;
  bool              _loading = false;
  String?           _fleetId;

  SubscriptionState get state   => _state;
  bool              get loading => _loading;

  /// The resolved fleet ID for the current user (fleet manager or driver).
  /// Available after [loadForUser()] completes successfully.
  String? get fleetId => _fleetId;

  // ── Convenience pass-throughs ───────────────────────────────────────────────

  String  get plan            => _state.plan            ?? '';
  String  get planDisplayName => _state.planDisplayName;
  String  get status          => _state.status          ?? '';
  bool    get canAddVehicle   => _state.canAddVehicle;
  bool    get isExpired       => _state.isExpired;
  bool    get isInGrace       => _state.isInGrace;
  int?    get trialDaysLeft   => _state.trialDaysLeft;
  int     get vehicleLimit    => _state.vehicleLimit;
  int     get vehiclesUsed    => _state.vehiclesUsed;

  String featureAccess(String name) => _state.feature(name);

  // ── Load / refresh ──────────────────────────────────────────────────────────

  /// Resolves the fleet ID for the signed-in user, then loads the full
  /// subscription state. Safe to call multiple times — subsequent calls
  /// refresh the state.
  Future<void> loadForUser() async {
    _loading = true;
    notifyListeners();

    try {
      final user = _client.auth.currentUser;
      if (user == null) return;

      // ── Resolve fleet ID ────────────────────────────────────────────────────
      // Priority 1: driver account (driver's assigned fleet)
      String? resolvedFleetId;

      final driverRows = await _client
          .from('driver_accounts')
          .select('fleet_id')
          .eq('user_id', user.id)
          .limit(1) as List<dynamic>;

      if (driverRows.isNotEmpty) {
        resolvedFleetId = driverRows.first['fleet_id'] as String?;
      } else {
        // Priority 2: fleet manager owns the fleet
        final fleet = await _client
            .from('fleets')
            .select('id')
            .eq('manager_id', user.id)
            .maybeSingle() as Map<String, dynamic>?;
        resolvedFleetId = fleet?['id'] as String?;
      }

      if (resolvedFleetId == null) return;

      _fleetId = resolvedFleetId;
      _state   = await SubscriptionService.instance.load(resolvedFleetId);
    } catch (e) {
      debugPrint('[SubscriptionProvider] loadForUser error: $e');
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<void> refresh() => loadForUser();
}
