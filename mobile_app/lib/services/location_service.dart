import 'dart:async';
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

/// Streams GPS position every [intervalSeconds] seconds.
/// Requires location permissions to already be granted before calling [start()].
class LocationService {
  static final LocationService _instance = LocationService._internal();
  factory LocationService() => _instance;
  LocationService._internal();

  static const int intervalSeconds = 15;

  final _controller = StreamController<LocationReading>.broadcast();
  Timer? _timer;
  LocationReading? _lastReading;

  Stream<LocationReading> get locationStream => _controller.stream;
  LocationReading? get lastReading => _lastReading;

  /// Start emitting GPS readings every [intervalSeconds] seconds.
  Future<void> start() async {
    if (_timer != null && _timer!.isActive) return;

    // Verify permissions
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

    _timer = Timer.periodic(Duration(seconds: intervalSeconds), (_) => _poll());
    // Emit first reading immediately
    _poll();
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _poll() async {
    try {
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );

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

      // Persist last known location for offline recovery
      final prefs = await SharedPreferences.getInstance();
      await prefs.setDouble('last_lat', reading.latitude);
      await prefs.setDouble('last_lng', reading.longitude);
      await prefs.setString('last_location_time', reading.timestamp.toIso8601String());
    } catch (e) {
      print('LocationService poll error: $e');
    }
  }

  /// Returns last known location from SharedPreferences (for boot recovery).
  static Future<Map<String, dynamic>?> getLastKnownLocation() async {
    final prefs = await SharedPreferences.getInstance();
    final lat  = prefs.getDouble('last_lat');
    final lng  = prefs.getDouble('last_lng');
    final time = prefs.getString('last_location_time');
    if (lat == null || lng == null) return null;
    return { 'latitude': lat, 'longitude': lng, 'timestamp': time };
  }

  void dispose() {
    stop();
    _controller.close();
  }
}
