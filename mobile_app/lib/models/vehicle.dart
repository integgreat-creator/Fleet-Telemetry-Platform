class Vehicle {
  final String id;
  final String name;
  final String? vin;
  final String? make;
  final String? model;
  final int? year;
  final String userId;
  final DateTime createdAt;

  Vehicle({
    required this.id,
    required this.name,
    this.vin,
    this.make,
    this.model,
    this.year,
    required this.userId,
    required this.createdAt,
  });

  factory Vehicle.fromJson(Map<String, dynamic> json) {
    return Vehicle(
      id: json['id'] as String,
      name: json['name'] as String,
      vin: json['vin'] as String?,
      make: json['make'] as String?,
      model: json['model'] as String?,
      year: json['year'] as int?,
      userId: json['user_id'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'vin': vin,
      'make': make,
      'model': model,
      'year': year,
      'user_id': userId,
      'created_at': createdAt.toIso8601String(),
    };
  }

  Vehicle copyWith({
    String? id,
    String? name,
    String? vin,
    String? make,
    String? model,
    int? year,
    String? userId,
    DateTime? createdAt,
  }) {
    return Vehicle(
      id: id ?? this.id,
      name: name ?? this.name,
      vin: vin ?? this.vin,
      make: make ?? this.make,
      model: model ?? this.model,
      year: year ?? this.year,
      userId: userId ?? this.userId,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}
