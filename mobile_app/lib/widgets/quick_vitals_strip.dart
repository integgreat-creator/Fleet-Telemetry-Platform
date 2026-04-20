import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

class QuickVitalsStrip extends StatelessWidget {
  final Map<SensorType, SensorData> sensorData;

  const QuickVitalsStrip({super.key, required this.sensorData});

  static const _vitals = [
    SensorType.speed,
    SensorType.rpm,
    SensorType.coolantTemp,
    SensorType.fuelLevel,
  ];

  @override
  Widget build(BuildContext context) {
    if (sensorData.isEmpty) return const SizedBox.shrink();

    final items = _vitals
        .where((t) => sensorData.containsKey(t))
        .map((t) => sensorData[t]!)
        .toList();

    if (items.isEmpty) return const SizedBox.shrink();

    return Container(
      height: 56,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        children: items.map((sd) {
          return Expanded(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 3),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.bgCard,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '${sd.value.toStringAsFixed(1)} ${sd.unit}',
                    style: const TextStyle(
                      color: AppColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    sd.name,
                    style: const TextStyle(
                      color: AppColors.textSecondary,
                      fontSize: 10,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}
