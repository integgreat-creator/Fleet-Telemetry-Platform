import 'package:flutter/services.dart';

/// Detects if the device is using a fake/mock GPS provider.
/// Uses Android Location.isFromMockProvider() via platform channel.
/// Always returns false on non-Android or if channel is unavailable.
class MockGpsDetector {
  static const _channel = MethodChannel('com.vehiclesense/mock_gps');

  /// Returns true if the last GPS position came from a mock provider.
  static Future<bool> isMockGps() async {
    try {
      final result = await _channel.invokeMethod<bool>('isMockGps');
      return result ?? false;
    } on MissingPluginException {
      return false;
    } on PlatformException {
      return false;
    }
  }
}
