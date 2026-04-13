import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/services/subscription_service.dart';

/// Bottom sheet shown when a vehicle limit or feature gate is hit.
///
/// Usage:
/// ```dart
/// final result = await SubscriptionService.instance.checkVehicleLimit(fleetId);
/// if (!result.allowed) {
///   UpgradeBottomSheet.show(context: context, result: result, isManager: !authProvider.isDriver);
///   return;
/// }
/// ```
class UpgradeBottomSheet extends StatelessWidget {
  final VehicleLimitResult result;
  final String             planDisplayName;
  final bool               isManager;
  final VoidCallback?      onUpgrade;

  const UpgradeBottomSheet({
    Key? key,
    required this.result,
    required this.planDisplayName,
    required this.isManager,
    this.onUpgrade,
  }) : super(key: key);

  // ── Static helper ───────────────────────────────────────────────────────────

  static Future<void> show({
    required BuildContext     context,
    required VehicleLimitResult result,
    String                    planDisplayName = '',
    bool                      isManager = false,
    VoidCallback?             onUpgrade,
  }) {
    return showModalBottomSheet(
      context:           context,
      backgroundColor:   const Color(0xFF141E33),
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => UpgradeBottomSheet(
        result:          result,
        planDisplayName: planDisplayName,
        isManager:       isManager,
        onUpgrade:       onUpgrade,
      ),
    );
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final used  = result.used  ?? 0;
    final limit = result.limit ?? 0;
    final pct   = (limit > 0) ? (used / limit).clamp(0.0, 1.0) : 1.0;
    final planName = planDisplayName.isNotEmpty
        ? planDisplayName
        : (result.plan != null
            ? _capitalize(result.plan!)
            : 'current');

    return Padding(
      padding: EdgeInsets.fromLTRB(
        24, 20, 24, MediaQuery.of(context).viewInsets.bottom + 32,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // ── Drag handle ────────────────────────────────────────────────────
          Container(
            width: 36, height: 4,
            margin: const EdgeInsets.only(bottom: 20),
            decoration: BoxDecoration(
              color: const Color(0xFF2D3F60),
              borderRadius: BorderRadius.circular(2),
            ),
          ),

          // ── Lock icon ──────────────────────────────────────────────────────
          Container(
            width: 64, height: 64,
            decoration: BoxDecoration(
              color:        const Color(0xFF1A2D4D),
              borderRadius: BorderRadius.circular(16),
              border:       Border.all(color: const Color(0xFF2D3F60)),
            ),
            child: const Icon(Icons.lock_rounded, color: Color(0xFF64748B), size: 30),
          ),
          const SizedBox(height: 16),

          // ── Title ──────────────────────────────────────────────────────────
          Text(
            'Vehicle limit reached',
            style: const TextStyle(
              color:       AppColors.textPrimary,
              fontSize:    20,
              fontWeight:  FontWeight.bold,
            ),
          ),
          const SizedBox(height: 6),

          // ── Subtitle ───────────────────────────────────────────────────────
          Text(
            isManager
                ? 'Your fleet has reached the $planName plan limit of '
                  '${limit < 0 ? 'unlimited' : limit} vehicle${limit == 1 ? '' : 's'}. '
                  'Upgrade to add more.'
                : 'Your fleet\'s $planName plan has reached its vehicle limit. '
                  'Contact your fleet manager to upgrade.',
            style: const TextStyle(
              color:     AppColors.textSecondary,
              fontSize:  14,
              height:    1.5,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),

          // ── Usage bar ──────────────────────────────────────────────────────
          if (limit > 0) ...[
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Vehicles',
                  style: TextStyle(
                    color: AppColors.textLabel, fontSize: 12,
                  ),
                ),
                Text(
                  '$used / $limit',
                  style: TextStyle(
                    color:      pct >= 1.0 ? AppColors.statusError : AppColors.textSecondary,
                    fontSize:   12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value:           pct,
                minHeight:       8,
                backgroundColor: const Color(0xFF1A2D4D),
                valueColor: AlwaysStoppedAnimation<Color>(
                  pct >= 1.0 ? AppColors.statusError : AppColors.accentBlue,
                ),
              ),
            ),
            const SizedBox(height: 24),
          ],

          // ── Plan badge ─────────────────────────────────────────────────────
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color:        const Color(0xFF1A2D4D),
              borderRadius: BorderRadius.circular(20),
              border:       Border.all(color: const Color(0xFF2D3F60)),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.workspace_premium_rounded,
                    size: 14, color: Color(0xFF64748B)),
                const SizedBox(width: 6),
                Text(
                  '$planName plan',
                  style: const TextStyle(
                    color:      AppColors.textSecondary,
                    fontSize:   12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // ── CTA ────────────────────────────────────────────────────────────
          if (isManager && onUpgrade != null)
            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: () {
                  Navigator.pop(context);
                  onUpgrade!();
                },
                icon:  const Icon(Icons.arrow_upward_rounded, size: 18),
                label: const Text(
                  'View Plans',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
                ),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.accentBlue,
                  foregroundColor: AppColors.textPrimary,
                  padding:         const EdgeInsets.symmetric(vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              ),
            ),

          // ── Close ──────────────────────────────────────────────────────────
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(
                'Close',
                style: TextStyle(
                  color:    AppColors.textSecondary,
                  fontSize: 14,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}
