import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/activity_screen.dart';
import 'package:vehicle_telemetry/screens/login_screen.dart';
import 'package:vehicle_telemetry/screens/maintenance_screen.dart';
import 'package:vehicle_telemetry/screens/vehicle_list_screen.dart';
import 'package:vehicle_telemetry/services/notification_service.dart';

/// Profile / settings tab.
/// Shows driver email + role, current vehicle, notification toggles, app version
/// and a logout button.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _alertsEnabled = true;
  static const String _appVersion = '1.0.0';

  @override
  void initState() {
    super.initState();
    _loadPrefs();
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getBool('threshold_alerts_enabled') ?? true;
    // Sync the in-memory flag so it's correct from the first sensor reading
    NotificationService().alertsEnabled = saved;
    if (mounted) setState(() => _alertsEnabled = saved);
  }

  Future<void> _toggleAlerts(bool value) async {
    setState(() => _alertsEnabled = value);
    // 1. Persist preference
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('threshold_alerts_enabled', value);
    // 2. Apply immediately to the running notification service
    NotificationService().alertsEnabled = value;
    // 3. Cancel any queued notifications if the user turned alerts off
    if (!value) await NotificationService().cancelAll();
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Consumer2<AuthProvider, VehicleProvider>(
      builder: (context, auth, vp, _) {
        final email   = auth.user?.email ?? '—';
        final role    = auth.isDriver ? 'Driver' : 'Fleet Manager';
        final vehicle = vp.selectedVehicle;

        return SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 12),

              // ── PROFILE ──────────────────────────────────────────────────
              _SectionLabel('PROFILE'),
              _ProfileTile(email: email, role: role),

              const SizedBox(height: 20),

              // ── VEHICLE ──────────────────────────────────────────────────
              _SectionLabel('VEHICLE'),
              _IconTile(
                icon: Icons.directions_car_rounded,
                title: vehicle?.name ?? 'No vehicle selected',
                subtitle: vehicle != null && vehicle.vin.isNotEmpty
                    ? vehicle.vin
                    : 'VIN not available',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const VehicleListScreen()),
                ),
                showChevron: true,
              ),

              const SizedBox(height: 20),

              // ── NOTIFICATIONS ─────────────────────────────────────────────
              _SectionLabel('NOTIFICATIONS'),
              _SwitchTile(
                icon: Icons.notifications_outlined,
                title: 'Threshold Alerts',
                subtitle: 'Notify when sensor values exceed thresholds',
                value: _alertsEnabled,
                onChanged: _toggleAlerts,
              ),

              const SizedBox(height: 20),

              // ── MORE ──────────────────────────────────────────────────────
              _SectionLabel('MORE'),
              _IconTile(
                icon: Icons.bar_chart_rounded,
                title: 'Activity',
                subtitle: 'Sensor history for the last 7 days',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const ActivityScreen()),
                ),
                showChevron: true,
              ),
              const SizedBox(height: 8),
              _IconTile(
                icon: Icons.build_rounded,
                title: 'Maintenance',
                subtitle: 'Scheduled services and upcoming checks',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const MaintenanceScreen()),
                ),
                showChevron: true,
              ),

              const SizedBox(height: 20),

              // ── ABOUT ─────────────────────────────────────────────────────
              _SectionLabel('ABOUT'),
              _IconTile(
                icon: Icons.info_outline_rounded,
                title: 'App Version',
                trailing: Text(
                  _appVersion,
                  style: const TextStyle(
                    color: AppColors.textSecondary,
                    fontSize: 14,
                  ),
                ),
              ),

              const SizedBox(height: 36),

              // ── LOGOUT ────────────────────────────────────────────────────
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: _LogoutButton(onLogout: () => _confirmLogout(context, auth)),
              ),

              const SizedBox(height: 40),
            ],
          ),
        );
      },
    );
  }

  // ── Logout confirm dialog ─────────────────────────────────────────────────

  Future<void> _confirmLogout(BuildContext context, AuthProvider auth) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.bgCardAlt,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text(
          'Logout',
          style: TextStyle(color: AppColors.textPrimary, fontWeight: FontWeight.bold),
        ),
        content: const Text(
          'Are you sure you want to logout?',
          style: TextStyle(color: AppColors.textSecondary),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textSecondary)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: AppColors.statusError),
            child: const Text('Logout', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );

    if (confirmed == true && context.mounted) {
      await auth.signOut();
      if (context.mounted) {
        Navigator.of(context).pushAndRemoveUntil(
          MaterialPageRoute(builder: (_) => const LoginScreen()),
          (route) => false,
        );
      }
    }
  }
}

// ── Reusable section widgets ─────────────────────────────────────────────────

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
      child: Text(
        text,
        style: const TextStyle(
          color: AppColors.textLabel,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.4,
        ),
      ),
    );
  }
}

/// A profile tile with a circular avatar.
class _ProfileTile extends StatelessWidget {
  final String email;
  final String role;
  const _ProfileTile({required this.email, required this.role});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Container(
          width: 44,
          height: 44,
          decoration: const BoxDecoration(
            color: AppColors.iconBg,
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.person_rounded,
            color: AppColors.accentBlue,
            size: 24,
          ),
        ),
        title: Text(
          email,
          style: const TextStyle(
            color: AppColors.textPrimary,
            fontSize: 15,
            fontWeight: FontWeight.w500,
          ),
        ),
        subtitle: Text(
          role,
          style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
        ),
      ),
    );
  }
}

/// A generic icon + title + subtitle tile with optional trailing widget.
class _IconTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool showChevron;

  const _IconTile({
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.showChevron = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
      ),
      child: ListTile(
        onTap: onTap,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AppColors.iconBg,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: AppColors.accentBlue, size: 20),
        ),
        title: Text(
          title,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 15),
        ),
        subtitle: subtitle != null
            ? Text(
                subtitle!,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 13,
                ),
              )
            : null,
        trailing: trailing ??
            (showChevron
                ? const Icon(
                    Icons.chevron_right,
                    color: AppColors.textSecondary,
                  )
                : null),
      ),
    );
  }
}

/// Toggle tile for notification settings.
class _SwitchTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  const _SwitchTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: AppColors.bgCard,
        borderRadius: BorderRadius.circular(14),
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AppColors.iconBg,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: AppColors.accentBlue, size: 20),
        ),
        title: Text(
          title,
          style: const TextStyle(color: AppColors.textPrimary, fontSize: 15),
        ),
        subtitle: Text(
          subtitle,
          style: const TextStyle(color: AppColors.textSecondary, fontSize: 13),
        ),
        trailing: Switch(
          value: value,
          onChanged: onChanged,
          activeColor: AppColors.accentBlue,
          inactiveThumbColor: AppColors.textSecondary,
          inactiveTrackColor: AppColors.bgCardAlt,
        ),
      ),
    );
  }
}

/// Full-width red-outlined logout button.
class _LogoutButton extends StatelessWidget {
  final VoidCallback onLogout;
  const _LogoutButton({required this.onLogout});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: onLogout,
        icon: const Icon(Icons.logout_rounded, color: AppColors.statusError),
        label: const Text(
          'Logout',
          style: TextStyle(
            color: AppColors.statusError,
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
        ),
        style: OutlinedButton.styleFrom(
          side: const BorderSide(color: AppColors.statusError, width: 1.5),
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
        ),
      ),
    );
  }
}
