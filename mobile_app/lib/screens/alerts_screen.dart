import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';

/// Alerts tab — shows recent threshold-breach alerts for the selected vehicle.
class AlertsScreen extends StatefulWidget {
  const AlertsScreen({super.key});

  @override
  State<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends State<AlertsScreen> {
  List<Map<String, dynamic>> _alerts = [];
  bool _loading = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _fetchAlerts();
  }

  Future<void> _fetchAlerts() async {
    final vehicleId =
        context.read<VehicleProvider>().selectedVehicle?.id;
    if (vehicleId == null) return;

    setState(() {
      _loading = true;
      _error   = null;
    });

    try {
      final response = await Supabase.instance.client
          .from('alerts')
          .select()
          .eq('vehicle_id', vehicleId)
          .order('created_at', ascending: false)
          .limit(50);

      if (mounted) {
        setState(() {
          _alerts  = List<Map<String, dynamic>>.from(response as List);
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error   = e.toString();
          _loading = false;
        });
      }
    }
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Consumer<VehicleProvider>(
      builder: (context, vp, _) {
        if (vp.selectedVehicle == null) {
          return _EmptyState(
            icon: Icons.notifications_off_outlined,
            title: 'No vehicle connected',
            subtitle: 'Connect an OBD adapter to see alerts for your vehicle.',
          );
        }

        if (_loading) {
          return const Center(
            child: CircularProgressIndicator(color: AppColors.accentBlue),
          );
        }

        if (_error != null) {
          return _EmptyState(
            icon: Icons.error_outline,
            title: 'Could not load alerts',
            subtitle: _error!,
            actionLabel: 'Retry',
            onAction: _fetchAlerts,
          );
        }

        if (_alerts.isEmpty) {
          return _EmptyState(
            icon: Icons.check_circle_outline,
            title: 'No alerts',
            subtitle: 'All sensor values are within safe thresholds.',
            actionLabel: 'Refresh',
            onAction: _fetchAlerts,
            iconColor: AppColors.statusConnected,
          );
        }

        return RefreshIndicator(
          color: AppColors.accentBlue,
          backgroundColor: AppColors.bgCard,
          onRefresh: _fetchAlerts,
          child: ListView.separated(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            itemCount: _alerts.length,
            separatorBuilder: (_, __) => const SizedBox(height: 8),
            itemBuilder: (context, i) => _AlertTile(alert: _alerts[i]),
          ),
        );
      },
    );
  }
}

// ── Alert tile ────────────────────────────────────────────────────────────────

class _AlertTile extends StatelessWidget {
  final Map<String, dynamic> alert;
  const _AlertTile({required this.alert});

  @override
  Widget build(BuildContext context) {
    final severity  = alert['severity'] as String? ?? 'warning';
    final message   = alert['message']  as String? ?? 'Unknown alert';
    final sensorType= alert['sensor_type'] as String? ?? '';
    final rawTs     = alert['created_at'] as String?;
    final ts        = rawTs != null ? DateTime.tryParse(rawTs) : null;

    final (color, icon) = switch (severity) {
      'critical' => (AppColors.statusError,      Icons.warning_rounded),
      'info'     => (AppColors.accentBlue,        Icons.info_rounded),
      _          => (AppColors.statusConnecting,  Icons.warning_amber_rounded),
    };

    return Container(
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(0.25), width: 1),
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: color, size: 20),
        ),
        title: Text(
          message,
          style: const TextStyle(
            color: AppColors.textPrimary,
            fontSize: 14,
            fontWeight: FontWeight.w500,
          ),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Row(
            children: [
              if (sensorType.isNotEmpty) ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: color.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    sensorType,
                    style: TextStyle(
                      color: color,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              if (ts != null)
                Text(
                  _formatTs(ts),
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 12,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatTs(DateTime ts) {
    final now  = DateTime.now();
    final diff = now.difference(ts);
    if (diff.inMinutes < 1)  return 'Just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours   < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}

// ── Empty / error state ────────────────────────────────────────────────────────

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String   title;
  final String   subtitle;
  final String?  actionLabel;
  final VoidCallback? onAction;
  final Color    iconColor;

  const _EmptyState({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.actionLabel,
    this.onAction,
    this.iconColor = AppColors.textSecondary,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: iconColor.withOpacity(0.10),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 34, color: iconColor),
            ),
            const SizedBox(height: 20),
            Text(
              title,
              style: const TextStyle(
                color: AppColors.textPrimary,
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              subtitle,
              style: const TextStyle(
                color: AppColors.textSecondary,
                fontSize: 14,
                height: 1.5,
              ),
              textAlign: TextAlign.center,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 24),
              OutlinedButton(
                onPressed: onAction,
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: AppColors.accentBlue),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 28, vertical: 12,
                  ),
                ),
                child: Text(
                  actionLabel!,
                  style: const TextStyle(color: AppColors.accentBlue),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
