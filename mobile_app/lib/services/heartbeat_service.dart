import 'dart:async';
import 'package:vehicle_telemetry/services/location_service.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';

/// Sends a periodic heartbeat to Supabase every 10 seconds while a trip is
/// active.  The backend uses missing heartbeats to detect unexpected silence
/// (crash, connectivity loss, or device death).
class HeartbeatService {
  static final HeartbeatService _instance = HeartbeatService._internal();
  factory HeartbeatService() => _instance;
  HeartbeatService._internal();

  final _supabase  = SupabaseService();
  final _location  = LocationService();
  Timer? _timer;

  void start(String vehicleId) {
    stop();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) {
      final pos = _location.lastPosition;
      _supabase.sendHeartbeat(
        vehicleId:    vehicleId,
        lat:          pos?.latitude,
        lng:          pos?.longitude,
        gpsAvailable: pos != null,
      );
    });
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }
}
