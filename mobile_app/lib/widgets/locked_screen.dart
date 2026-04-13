import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';

/// Shown inside the [IndexedStack] when a feature is not available on the
/// fleet's current plan. Driver-facing only — no upgrade CTA, no pricing.
class LockedScreen extends StatelessWidget {
  /// Human-readable name of the feature, e.g. "Activity History".
  final String featureName;

  const LockedScreen({Key? key, required this.featureName}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // ── Lock icon ───────────────────────────────────────────────────
            Container(
              width:  80,
              height: 80,
              decoration: BoxDecoration(
                color:        AppColors.bgCard,
                borderRadius: BorderRadius.circular(20),
                border:       Border.all(color: AppColors.divider),
              ),
              child: const Icon(
                Icons.lock_rounded,
                size:  36,
                color: AppColors.textLabel,
              ),
            ),
            const SizedBox(height: 20),

            // ── Feature name ────────────────────────────────────────────────
            Text(
              featureName,
              style: const TextStyle(
                color:      AppColors.textPrimary,
                fontSize:   18,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),

            // ── Message ─────────────────────────────────────────────────────
            Text(
              'This feature is not available on your fleet\'s current plan.\n'
              'Contact your fleet manager to enable it.',
              style: const TextStyle(
                color:   AppColors.textSecondary,
                fontSize: 14,
                height:   1.55,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
