class Vehicle {
  final String id;
  final String name;
  final String vin;
  final String make;
  final String model;
  final int year;
  // FIX: was 'user_id' — DB column is 'owner_id'
  final String ownerId;
  final String? fleetId;
  final bool isActive;
  final double healthScore;
  final DateTime? lastConnected;
  final double fuelPricePerLitre;
  final double avgKmPerLitre;
  final String? driverPhone;
  final String? driverEmail;
  final String fuelType;            // 'petrol' | 'diesel' | 'cng' | 'ev'
  final double? batteryCapacityKwh; // EV only
  final double? cngCapacityKg;      // CNG only
  final DateTime createdAt;
  final DateTime updatedAt;

  Vehicle({
    required this.id,
    required this.name,
    required this.vin,
    required this.make,
    required this.model,
    required this.year,
    required this.ownerId,
    this.fleetId,
    required this.isActive,
    required this.healthScore,
    this.lastConnected,
    required this.fuelPricePerLitre,
    required this.avgKmPerLitre,
    this.driverPhone,
    this.driverEmail,
    required this.fuelType,
    this.batteryCapacityKwh,
    this.cngCapacityKg,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Vehicle.fromJson(Map<String, dynamic> json) {
    return Vehicle(
      id:                  json['id']               as String,
      name:                json['name']             as String,
      vin:                 json['vin']              as String? ?? '',
      make:                json['make']             as String? ?? '',
      model:               json['model']            as String? ?? '',
      year:                (json['year']            as num?)?.toInt() ?? DateTime.now().year,
      // FIX: column is 'owner_id', NOT 'user_id'
      ownerId:             json['owner_id']         as String? ?? '',
      fleetId:             json['fleet_id']         as String?,
      isActive:            json['is_active']        as bool? ?? true,
      healthScore:         (json['health_score']    as num?)?.toDouble() ?? 100.0,
      lastConnected:       json['last_connected'] != null
          ? DateTime.tryParse(json['last_connected'] as String)
          : null,
      fuelPricePerLitre:   (json['fuel_price_per_litre'] as num?)?.toDouble() ?? 100.0,
      avgKmPerLitre:       (json['avg_km_per_litre']      as num?)?.toDouble() ?? 15.0,
      driverPhone:         json['driver_phone']     as String?,
      driverEmail:         json['driver_email']     as String?,
      fuelType:            json['fuel_type']        as String? ?? 'petrol',
      batteryCapacityKwh:  (json['battery_capacity_kwh'] as num?)?.toDouble(),
      cngCapacityKg:       (json['cng_capacity_kg']      as num?)?.toDouble(),
      createdAt:           DateTime.parse(json['created_at'] as String),
      updatedAt:           DateTime.tryParse(json['updated_at'] as String? ?? '') ??
                           DateTime.parse(json['created_at'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id':                    id,
      'name':                  name,
      'vin':                   vin,
      'make':                  make,
      'model':                 model,
      'year':                  year,
      // FIX: send 'owner_id', NOT 'user_id'
      'owner_id':              ownerId,
      'fleet_id':              fleetId,
      'is_active':             isActive,
      'health_score':          healthScore,
      'last_connected':        lastConnected?.toIso8601String(),
      'fuel_price_per_litre':  fuelPricePerLitre,
      'avg_km_per_litre':      avgKmPerLitre,
      'driver_phone':          driverPhone,
      'driver_email':          driverEmail,
      'fuel_type':             fuelType,
      'battery_capacity_kwh':  batteryCapacityKwh,
      'cng_capacity_kg':       cngCapacityKg,
      'created_at':            createdAt.toIso8601String(),
      'updated_at':            updatedAt.toIso8601String(),
    };
  }

  /// Returns a map containing only the fields that should be sent on INSERT
  /// (excludes id, created_at, updated_at — auto-managed by DB)
  Map<String, dynamic> toInsertJson() {
    return {
      'name':                  name,
      'vin':                   vin,
      'make':                  make,
      'model':                 model,
      'year':                  year,
      'owner_id':              ownerId,
      'fleet_id':              fleetId,
      'fuel_price_per_litre':  fuelPricePerLitre,
      'avg_km_per_litre':      avgKmPerLitre,
      'driver_phone':          driverPhone,
      'driver_email':          driverEmail,
      'fuel_type':             fuelType,
      'battery_capacity_kwh':  batteryCapacityKwh,
      'cng_capacity_kg':       cngCapacityKg,
    };
  }

  /// Returns a map of only fields allowed to change on UPDATE
  Map<String, dynamic> toUpdateJson() {
    return {
      'name':                  name,
      'make':                  make,
      'model':                 model,
      'year':                  year,
      'is_active':             isActive,
      'health_score':          healthScore,
      'last_connected':        lastConnected?.toIso8601String(),
      'fuel_price_per_litre':  fuelPricePerLitre,
      'avg_km_per_litre':      avgKmPerLitre,
      'driver_phone':          driverPhone,
      'driver_email':          driverEmail,
      'fuel_type':             fuelType,
      'battery_capacity_kwh':  batteryCapacityKwh,
      'cng_capacity_kg':       cngCapacityKg,
    };
  }

  Vehicle copyWith({
    String? id,
    String? name,
    String? vin,
    String? make,
    String? model,
    int? year,
    String? ownerId,
    String? fleetId,
    bool? isActive,
    double? healthScore,
    DateTime? lastConnected,
    double? fuelPricePerLitre,
    double? avgKmPerLitre,
    String? driverPhone,
    String? driverEmail,
    String? fuelType,
    double? batteryCapacityKwh,
    double? cngCapacityKg,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Vehicle(
      id:                 id               ?? this.id,
      name:               name             ?? this.name,
      vin:                vin              ?? this.vin,
      make:               make             ?? this.make,
      model:              model            ?? this.model,
      year:               year             ?? this.year,
      ownerId:            ownerId          ?? this.ownerId,
      fleetId:            fleetId          ?? this.fleetId,
      isActive:           isActive         ?? this.isActive,
      healthScore:        healthScore      ?? this.healthScore,
      lastConnected:      lastConnected    ?? this.lastConnected,
      fuelPricePerLitre:  fuelPricePerLitre ?? this.fuelPricePerLitre,
      avgKmPerLitre:      avgKmPerLitre    ?? this.avgKmPerLitre,
      driverPhone:        driverPhone      ?? this.driverPhone,
      driverEmail:        driverEmail      ?? this.driverEmail,
      fuelType:           fuelType         ?? this.fuelType,
      batteryCapacityKwh: batteryCapacityKwh ?? this.batteryCapacityKwh,
      cngCapacityKg:      cngCapacityKg    ?? this.cngCapacityKg,
      createdAt:          createdAt        ?? this.createdAt,
      updatedAt:          updatedAt        ?? this.updatedAt,
    );
  }

  @override
  String toString() => 'Vehicle($id, $name, $make $model $year)';

  @override
  bool operator ==(Object other) => other is Vehicle && other.id == id;

  @override
  int get hashCode => id.hashCode;
}
