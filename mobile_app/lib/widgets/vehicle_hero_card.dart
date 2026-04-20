import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/models/vehicle.dart';

class VehicleHeroCard extends StatelessWidget {
  final Vehicle? vehicle;
  final bool isConnected;
  final int activeCount;
  final int totalCount;

  const VehicleHeroCard({
    super.key,
    required this.vehicle,
    required this.isConnected,
    required this.activeCount,
    required this.totalCount,
  });

  @override
  Widget build(BuildContext context) {
    final name = vehicle?.name ?? 'No vehicle selected';
    final vin  = vehicle?.vin.isNotEmpty == true ? vehicle!.vin : 'VIN not available';

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: isConnected
              ? AppColors.accentBlue.withOpacity(0.4)
              : AppColors.bgCardAlt,
          width: 1,
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.iconBg,
              shape: BoxShape.circle,
            ),
            child: Icon(
              Icons.directions_car_rounded,
              color: isConnected ? AppColors.accentBlue : AppColors.textSecondary,
              size: 24,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: const TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  vin,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: isConnected
                      ? AppColors.accentBlue.withOpacity(0.15)
                      : AppColors.bgCardAlt,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  isConnected ? 'OBD Connected' : 'Disconnected',
                  style: TextStyle(
                    color: isConnected ? AppColors.accentBlue : AppColors.textSecondary,
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                '$activeCount / $totalCount sensors',
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
