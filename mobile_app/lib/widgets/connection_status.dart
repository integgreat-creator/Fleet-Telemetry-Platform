import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/bluetooth/bt_connection_state.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';

/// Prominent pill badge in the AppBar showing BT connection state.
/// Matches the dark-navy design: icon + label on a pill-shaped container.
class ConnectionStatusWidget extends StatelessWidget {
  final BtConnectionState connectionState;
  final String? deviceName;

  const ConnectionStatusWidget({
    Key? key,
    required this.connectionState,
    this.deviceName,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final color = _color();
    final icon  = _icon();
    final label = _label();

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.bgCardAlt,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: color.withOpacity(0.35),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Animated spinner for "Connecting", static icon otherwise
          connectionState == BtConnectionState.connecting
              ? SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: color,
                  ),
                )
              : Icon(icon, color: color, size: 15),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }

  Color _color() {
    switch (connectionState) {
      case BtConnectionState.connected:
        return AppColors.statusConnected;
      case BtConnectionState.connecting:
        return AppColors.statusConnecting;
      case BtConnectionState.disconnected:
        return AppColors.statusDisconnected;
      case BtConnectionState.error:
        return AppColors.statusError;
    }
  }

  IconData _icon() {
    switch (connectionState) {
      case BtConnectionState.connected:
        return Icons.bluetooth_connected_rounded;
      case BtConnectionState.connecting:
        return Icons.bluetooth_searching_rounded;
      case BtConnectionState.disconnected:
        return Icons.bluetooth_disabled_rounded;
      case BtConnectionState.error:
        return Icons.error_outline_rounded;
    }
  }

  String _label() {
    switch (connectionState) {
      case BtConnectionState.connected:
        // Show adapter name if short enough, else just "Connected"
        final name = deviceName;
        if (name != null && name.length <= 14) return name;
        return 'Connected';
      case BtConnectionState.connecting:
        return 'Connecting…';
      case BtConnectionState.disconnected:
        return 'Disconnected';
      case BtConnectionState.error:
        return 'Error';
    }
  }
}
