import 'sensor_data.dart';

class Threshold {
  final String id;
  final String vehicleId;
  final SensorType sensorType;
  final double? minValue;
  final double? maxValue;
  // FIX: DB column is 'alert_enabled', not 'enabled'
  final bool alertEnabled;
  final DateTime createdAt;
  final DateTime updatedAt;

  Threshold({
    required this.id,
    required this.vehicleId,
    required this.sensorType,
    this.minValue,
    this.maxValue,
    required this.alertEnabled,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Threshold.fromJson(Map<String, dynamic> json) {
    return Threshold(
      id:           json['id']           as String,
      vehicleId:    json['vehicle_id']   as String,
      sensorType:   SensorType.values.firstWhere(
        (e) => e.name == json['sensor_type'],
        orElse: () => SensorType.rpm,
      ),
      minValue:     json['min_value'] != null
          ? (json['min_value'] as num).toDouble()
          : null,
      maxValue:     json['max_value'] != null
          ? (json['max_value'] as num).toDouble()
          : null,
      // FIX: was json['enabled'] — DB column is 'alert_enabled'
      alertEnabled: json['alert_enabled'] as bool? ?? true,
      createdAt:    DateTime.parse(json['created_at'] as String),
      updatedAt:    DateTime.tryParse(json['updated_at'] as String? ?? '') ??
                    DateTime.parse(json['created_at'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id':            id,
      'vehicle_id':    vehicleId,
      'sensor_type':   sensorType.name,
      'min_value':     minValue,
      'max_value':     maxValue,
      // FIX: was 'enabled' — DB column is 'alert_enabled'
      'alert_enabled': alertEnabled,
      'created_at':    createdAt.toIso8601String(),
      'updated_at':    updatedAt.toIso8601String(),
    };
  }

  Map<String, dynamic> toUpsertJson() {
    return {
      'vehicle_id':    vehicleId,
      'sensor_type':   sensorType.name,
      'min_value':     minValue,
      'max_value':     maxValue,
      'alert_enabled': alertEnabled,
    };
  }

  bool isViolated(double value) {
    if (!alertEnabled) return false;
    if (minValue != null && value < minValue!) return true;
    if (maxValue != null && value > maxValue!) return true;
    return false;
  }

  Threshold copyWith({
    String? id,
    String? vehicleId,
    SensorType? sensorType,
    double? minValue,
    double? maxValue,
    bool? alertEnabled,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Threshold(
      id:           id           ?? this.id,
      vehicleId:    vehicleId    ?? this.vehicleId,
      sensorType:   sensorType   ?? this.sensorType,
      minValue:     minValue     ?? this.minValue,
      maxValue:     maxValue     ?? this.maxValue,
      alertEnabled: alertEnabled ?? this.alertEnabled,
      createdAt:    createdAt    ?? this.createdAt,
      updatedAt:    updatedAt    ?? this.updatedAt,
    );
  }
}
