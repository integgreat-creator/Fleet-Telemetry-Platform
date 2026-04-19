import 'package:vehicle_telemetry/services/vin_decoder_service.dart';

class VinInfo {
  final String vin;
  final String make;
  final String model;
  final int    year;
  final String displayName;

  const VinInfo({
    required this.vin,
    required this.make,
    required this.model,
    required this.year,
    required this.displayName,
  });
}

/// Static wrapper over [VinDecoderService] that returns a [VinInfo] (non-nullable
/// fields, includes the raw VIN) or null when decoding fails entirely.
class VinService {
  VinService._();

  static final _decoder = VinDecoderService();

  static Future<VinInfo?> decode(String vin) async {
    final result = await _decoder.decode(vin);
    if (!result.success) return null;
    return VinInfo(
      vin:         vin,
      make:        result.make        ?? 'Unknown',
      model:       result.model       ?? 'Vehicle',
      year:        result.year        ?? DateTime.now().year,
      displayName: result.displayName ?? 'Vehicle ($vin)',
    );
  }
}
