import 'package:shared_preferences/shared_preferences.dart';

/// Persists the active vehicle ID to SharedPreferences so GPS tracking can be
/// resumed automatically after the app is killed or the device reboots.
class TrackingPersistenceService {
  TrackingPersistenceService._();

  static const _key = 'active_tracking_vehicle_id';

  static Future<void> save(String vehicleId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, vehicleId);
  }

  /// Returns the persisted vehicle ID from the last active trip, or null if
  /// no trip was in progress when the app was last killed.
  static Future<String?> restore() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_key);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}
