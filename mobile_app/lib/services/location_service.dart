import 'dart:async';
import 'dart:io';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Result of a single GPS heartbeat reading.
class LocationReading {
  final double latitude;
  final double longitude;
  final double accuracy;
  final double altitude;
  final double speed;      // metres/second from GPS
  final bool isMockGps;
  final DateTime timestamp;

  const LocationReading({
    required this.latitude,
    required this.longitude,
    required this.accuracy,
    required this.altitude,
    required this.speed,
    required this.isMockGps,
    required this.timestamp,
  });

  /// Speed converted to km/h.
  double get speedKmh => speed * 3.6;
}

/// Streams GPS position continuously using [Geolocator.getPositionStream].
///
/// On Android a foreground-service notification keeps the service alive when
/// the app is in the background (required on API ≥ 26 to prevent suspension).
/// On iOS the activity type is set to [ActivityType.automotiveNavigation] so
/// iOS allows continuous background updates while driving.
///
/// Requires location permissions to already be granted before calling [start].
class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal();

  final _controller = StreamController<LocationReading>.broadcast();
  StreamSubscription<Position>? _positionSubscription;
  LocationReading? _lastReading;

  Stream<LocationReading> get locationStream => _controller.stream;
  LocationReading? get lastReading => _lastReading;

  /// Start emitting GPS readings continuously.
  /// Safe to call multiple times — subsequent calls are no-ops if already
  /// running.
  Future<void> start() async {
    if (_positionSubscription != null) return;

    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      print('LocationService: GPS service disabled');
      return;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        print('LocationService: permission denied');
        return;
      }
    }
    if (permission == LocationPermission.deniedForever) {
      print('LocationService: permission permanently denied');
      return;
    }

    final locationSettings = _buildLocationSettings();

    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: locationSettings,
    ).listen(
      _onPosition,
      onError: (e) => print('LocationService stream error: $e'),
    );
  }

  void stop() {
    _positionSubscription?.cancel();
    _positionSubscription = null;
  }

  // ── Platform-specific settings ────────────────────────────────────────────

  LocationSettings _buildLocationSettings() {
    if (Platform.isAndroid) {
      return AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 0,
        intervalDuration: const Duration(seconds: 15),
        // Foreground service keeps GPS alive when the screen is off.
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'FTPGo',
          notificationText:  'Tracking vehicle location in background',
          enableWakeLock:    true,
        ),
      );
    }

    if (Platform.isIOS) {
      return AppleSettings(
        accuracy:             LocationAccuracy.high,
        activityType:         ActivityType.automotiveNavigation,
        distanceFilter:       0,
        pauseLocationUpdatesAutomatically: false,
        // Shows the blue location indicator in the iOS status bar so the user
        // can see background location is active.
        showBackgroundLocationIndicator: true,
      );
    }

    // Fallback for desktop / web
    return const LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 0,
    );
  }

  // ── Position handler ──────────────────────────────────────────────────────

  Future<void> _onPosition(Position position) async {
    final reading = LocationReading(
      latitude:  position.latitude,
      longitude: position.longitude,
      accuracy:  position.accuracy,
      altitude:  position.altitude,
      speed:     position.speed < 0 ? 0 : position.speed,
      isMockGps: position.isMocked,
      timestamp: DateTime.now(),
    );

    _lastReading = reading;
    _controller.add(reading);

    // Persist last known location for boot-receiver recovery
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble('last_lat',  reading.latitude);
    await prefs.setDouble('last_lng',  reading.longitude);
    await prefs.setString('last_location_time', reading.timestamp.toIso8601String());
  }

  // ── Boot recovery ─────────────────────────────────────────────────────────

  /// Returns last known location from SharedPreferences (used by
  /// [TrackingBootReceiver] after device reboot).
  static Future<Map<String, dynamic>?> getLastKnownLocation() async {
    final prefs = await SharedPreferences.getInstance();
    final lat  = prefs.getDouble('last_lat');
    final lng  = prefs.getDouble('last_lng');
    final time = prefs.getString('last_location_time');
    if (lat == null || lng == null) return null;
    return {'latitude': lat, 'longitude': lng, 'timestamp': time};
  }

  void dispose() {
    stop();
    _controller.close();
  }
}
