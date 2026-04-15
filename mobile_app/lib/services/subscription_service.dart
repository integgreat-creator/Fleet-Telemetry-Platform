import 'package:flutter/foundation.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';

// ─── Result from check_vehicle_limit RPC ─────────────────────────────────────

class VehicleLimitResult {
  final bool   allowed;
  final String? reason;
  final int?   limit;  // -1 = unlimited
  final int?   used;
  final String? plan;

  const VehicleLimitResult({
    required this.allowed,
    this.reason,
    this.limit,
    this.used,
    this.plan,
  });

  factory VehicleLimitResult.fromJson(Map<String, dynamic> json) =>
      VehicleLimitResult(
        allowed: json['allowed'] as bool? ?? false,
        reason:  json['reason']  as String?,
        limit:   json['limit']   as int?,
        used:    json['used']    as int?,
        plan:    json['plan']    as String?,
      );

  static const permitted = VehicleLimitResult(allowed: true);
}

// ─── Subscription state snapshot ─────────────────────────────────────────────

class SubscriptionState {
  final String? plan;
  final String  planDisplayName;
  final String? status;
  final int     vehicleLimit;   // -1 = unlimited
  final int     driverLimit;
  final int     vehiclesUsed;
  final int     driversUsed;
  final bool    canAddVehicle;
  final DateTime? trialEndsAt;
  final int?      trialDaysLeft;  // null when not on trial
  final DateTime? gracePeriodEnd;
  final bool    isExpired;
  final bool    isInGrace;
  final Map<String, dynamic> featureFlags;

  const SubscriptionState({
    this.plan,
    this.planDisplayName  = '',
    this.status,
    this.vehicleLimit     = 2,
    this.driverLimit      = 3,
    this.vehiclesUsed     = 0,
    this.driversUsed      = 0,
    this.canAddVehicle    = true,
    this.trialEndsAt,
    this.trialDaysLeft,
    this.gracePeriodEnd,
    this.isExpired        = false,
    this.isInGrace        = false,
    this.featureFlags     = const {},
  });

  /// Returns 'full', 'limited', or 'none' for a feature key.
  String feature(String name) {
    if (status == 'suspended') return 'none';
    if (isExpired && !isInGrace) return 'none';
    final flag = featureFlags[name];
    if (flag == true || flag == 'full') return 'full';
    if (flag == 'limited')             return 'limited';
    return 'none';
  }

  /// Default state — shown while loading or when unauthenticated.
  static const empty = SubscriptionState();
}

// ─── Service (singleton) ──────────────────────────────────────────────────────

class SubscriptionService {
  SubscriptionService._();
  static final SubscriptionService instance = SubscriptionService._();

  final _client = SupabaseConfig.client;

  /// Loads subscription state for [fleetId].
  /// [fleetId] may come from either the fleet manager's own fleet or a driver's
  /// assigned fleet; the caller resolves which to pass in.
  Future<SubscriptionState> load(String fleetId) async {
    try {
      // ── Fetch subscription row ──────────────────────────────────────────────
      final subData = await _client
          .from('subscriptions')
          .select('*')
          .eq('fleet_id', fleetId)
          .maybeSingle() as Map<String, dynamic>?;

      if (subData == null) return SubscriptionState.empty;

      // ── Fetch plan definition (feature flags + limits) ──────────────────────
      final planDef = await _client
          .from('plan_definitions')
          .select('*')
          .eq('plan_name', subData['plan'] as String)
          .maybeSingle() as Map<String, dynamic>?;

      // ── Merge feature flags (custom overrides win) ──────────────────────────
      final planFlags   = (planDef?['feature_flags']  as Map<String, dynamic>?) ?? {};
      final customFlags = (subData['features']         as Map<String, dynamic>?) ?? {};
      final merged      = { ...planFlags, ...customFlags };

      // ── Vehicle / driver counts (select ids → count in Dart) ────────────────
      final vehicleRows = await _client
          .from('vehicles')
          .select('id')
          .eq('fleet_id', fleetId) as List<dynamic>;
      final driverRows = await _client
          .from('driver_accounts')
          .select('id')
          .eq('fleet_id', fleetId) as List<dynamic>;

      final vehiclesUsed = vehicleRows.length;
      final driversUsed  = driverRows.length;

      // ── Timing ──────────────────────────────────────────────────────────────
      final trialEndsAt = subData['trial_ends_at'] != null
          ? DateTime.tryParse(subData['trial_ends_at'] as String)
          : null;
      final gracePeriodEnd = subData['grace_period_end'] != null
          ? DateTime.tryParse(subData['grace_period_end'] as String)
          : null;
      final now       = DateTime.now();
      final isExpired = subData['status'] == 'expired';
      final isInGrace = isExpired && gracePeriodEnd != null && gracePeriodEnd.isAfter(now);

      int? trialDaysLeft;
      if (subData['status'] == 'trial' && trialEndsAt != null && trialEndsAt.isAfter(now)) {
        trialDaysLeft = (trialEndsAt.difference(now).inHours / 24).ceil().clamp(0, 999);
      } else if (subData['status'] == 'trial') {
        trialDaysLeft = 0;
      }

      // ── Limits ──────────────────────────────────────────────────────────────
      final vehicleLimit =
          (subData['max_vehicles'] as int?) ?? (planDef?['vehicle_limit'] as int?) ?? 2;
      final driverLimit  =
          (subData['max_drivers']  as int?) ?? (planDef?['driver_limit']  as int?) ?? 3;

      final canAddVehicle = !isExpired &&
          subData['status'] != 'suspended' &&
          (vehicleLimit < 0 || vehiclesUsed < vehicleLimit);

      return SubscriptionState(
        plan:            subData['plan']                        as String?,
        planDisplayName: (planDef?['display_name'] as String?) ??
                         subData['plan']                        as String? ?? '',
        status:          subData['status']                      as String?,
        vehicleLimit:    vehicleLimit,
        driverLimit:     driverLimit,
        vehiclesUsed:    vehiclesUsed,
        driversUsed:     driversUsed,
        canAddVehicle:   canAddVehicle,
        trialEndsAt:     trialEndsAt,
        trialDaysLeft:   trialDaysLeft,
        gracePeriodEnd:  gracePeriodEnd,
        isExpired:       isExpired,
        isInGrace:       isInGrace,
        featureFlags:    merged,
      );
    } catch (e) {
      debugPrint('[SubscriptionService] load error: $e');
      return SubscriptionState.empty;
    }
  }

  /// Calls the `check_vehicle_limit` Postgres RPC.
  /// On network / RPC error, fails open (returns `allowed = true`) so the DB
  /// constraint on the server is the final gatekeeper.
  Future<VehicleLimitResult> checkVehicleLimit(String fleetId) async {
    try {
      final res = await _client.rpc(
        'check_vehicle_limit',
        params: { 'p_fleet_id': fleetId },
      );
      return VehicleLimitResult.fromJson(
        Map<String, dynamic>.from(res as Map<dynamic, dynamic>),
      );
    } catch (e) {
      debugPrint('[SubscriptionService] checkVehicleLimit error: $e');
      return VehicleLimitResult.permitted;
    }
  }
}
