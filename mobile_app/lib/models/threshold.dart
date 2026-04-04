import 'sensor_data.dart';

class Threshold {
  final String id;
  final String vehicleId;
  final SensorType sensorType;
  final double? minValue;
  final double? maxValue;
  final bool enabled;
  final DateTime createdAt;
  final DateTime updatedAt;

  Threshold({
    required this.id,
    required this.vehicleId,
    required this.sensorType,
    this.minValue,
    this.maxValue,
    required this.enabled,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Threshold.fromJson(Map<String, dynamic> json) {
    return Threshold(
      id: json['id'] as String,
      vehicleId: json['vehicle_id'] as String,
      sensorType: SensorType.values.firstWhere(
        (e) => e.name == json['sensor_type'],
        orElse: () => SensorType.rpm,
      ),
      minValue: json['min_value'] != null ? (json['min_value'] as num).toDouble() : null,
      maxValue: json['max_value'] != null ? (json['max_value'] as num).toDouble() : null,
      enabled: json['enabled'] as bool,
      createdAt: DateTime.parse(json['created_at'] as String),
      updatedAt: DateTime.parse(json['updated_at'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'vehicle_id': vehicleId,
      'sensor_type': sensorType.name,
      'min_value': minValue,
      'max_value': maxValue,
      'enabled': enabled,
      'created_at': createdAt.toIso8601String(),
      'updated_at': updatedAt.toIso8601String(),
    };
  }

  bool isViolated(double value) {
    if (!enabled) return false;
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
    bool? enabled,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Threshold(
      id: id ?? this.id,
      vehicleId: vehicleId ?? this.vehicleId,
      sensorType: sensorType ?? this.sensorType,
      minValue: minValue ?? this.minValue,
      maxValue: maxValue ?? this.maxValue,
      enabled: enabled ?? this.enabled,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}
