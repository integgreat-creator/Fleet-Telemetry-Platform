import 'dart:convert';
import 'package:http/http.dart' as http;

/// Result from a VIN decode attempt.
class VinDecodeResult {
  final bool success;
  final String? make;
  final String? model;
  final int? year;
  final String? displayName;
  /// True when only the WMI (first 3 chars) could be matched — model/year unknown.
  final bool isPartialDecode;

  const VinDecodeResult({
    required this.success,
    this.make,
    this.model,
    this.year,
    this.displayName,
    this.isPartialDecode = false,
  });

  static const VinDecodeResult empty = VinDecodeResult(success: false);
}

/// Decodes a VIN using NHTSA API first, then falls back to an Indian WMI map.
class VinDecoderService {
  static const String _nhtsaBase =
      'https://vpic.nhtsa.dot.gov/api/vehicles/decodevin';

  /// Map of WMI prefix (first 3 chars) → manufacturer name for Indian-market vehicles.
  static const Map<String, String> _indianWmi = {
    'MA1': 'Maruti Suzuki', 'MA3': 'Maruti Suzuki', 'MA6': 'Maruti Suzuki',
    'MA7': 'Bajaj Auto',    'MAB': 'Maruti Suzuki', 'MAC': 'Maruti Suzuki',
    'MAH': 'Maruti Suzuki', 'MAJ': 'Maruti Suzuki',
    'MAT': 'Tata Motors',   'MAP': 'Tata Motors',
    'MBH': 'Honda',         'MBJ': 'Toyota',
    'MBR': 'Hyundai',       'MBT': 'Hyundai',
    'MEC': 'Mercedes-Benz', 'MEE': 'Renault',
    'MEF': 'Fiat',          'MEG': 'Skoda',
    'MHF': 'Toyota',        'MHR': 'Honda',
    'MNB': 'Mahindra',      'MNC': 'Mahindra',
    'MNT': 'Ashok Leyland', 'MYS': 'Force Motors',
    'AAV': 'Volkswagen',    'WVW': 'Volkswagen',
  };

  /// Attempt to decode [vin]. Returns [VinDecodeResult.empty] on total failure.
  Future<VinDecodeResult> decode(String vin) async {
    if (vin.length < 3) return VinDecodeResult.empty;

    try {
      final uri = Uri.parse('$_nhtsaBase/$vin?format=json');
      final response = await http.get(uri).timeout(const Duration(seconds: 8));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        final results = (data['Results'] as List<dynamic>? ?? []);

        String? make, model;
        int? year;
        for (final r in results) {
          final variable = (r['Variable'] as String? ?? '').toLowerCase();
          final value = r['Value'] as String?;
          if (value == null || value.isEmpty || value == 'null') continue;
          if (variable == 'make') make = _toTitleCase(value);
          if (variable == 'model') model = _toTitleCase(value);
          if (variable == 'model year') year = int.tryParse(value);
        }

        if (make != null && make.isNotEmpty) {
          final name = [year?.toString(), make, model]
              .whereType<String>()
              .join(' ');
          return VinDecodeResult(
            success: true,
            make: make,
            model: model,
            year: year,
            displayName: name,
          );
        }
      }
    } catch (_) {
      // Fall through to WMI lookup
    }

    // WMI fallback for Indian-market VINs
    final wmi = vin.substring(0, 3).toUpperCase();
    final manufacturer = _indianWmi[wmi];
    if (manufacturer != null) {
      return VinDecodeResult(
        success: true,
        make: manufacturer,
        isPartialDecode: true,
      );
    }

    return VinDecodeResult.empty;
  }

  static String _toTitleCase(String s) {
    if (s.isEmpty) return s;
    return s
        .split(' ')
        .map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1).toLowerCase()}')
        .join(' ');
  }
}
