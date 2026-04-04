import 'package:flutter/material.dart';
import 'package:vehicle_telemetry/services/bluetooth_service.dart';
import 'package:vehicle_telemetry/bluetooth/bt_connection_state.dart';

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
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: _getStatusColor(),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            _getStatusIcon(),
            color: Colors.white,
            size: 16,
          ),
          const SizedBox(width: 8),
          Text(
            _getStatusText(),
            style: const TextStyle(
              color: Colors.white,
              fontSize: 14,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  Color _getStatusColor() {
    switch (connectionState) {
      case BtConnectionState.connected:
        return Colors.green;
      case BtConnectionState.connecting:
        return Colors.orange;
      case BtConnectionState.disconnected:
        return Colors.grey;
      case BtConnectionState.error:
        return Colors.red;
    }
  }

  IconData _getStatusIcon() {
    switch (connectionState) {
      case BtConnectionState.connected:
        return Icons.bluetooth_connected;
      case BtConnectionState.connecting:
        return Icons.bluetooth_searching;
      case BtConnectionState.disconnected:
        return Icons.bluetooth_disabled;
      case BtConnectionState.error:
        return Icons.error_outline;
    }
  }

  String _getStatusText() {
    switch (connectionState) {
      case BtConnectionState.connected:
        return deviceName ?? 'Connected';
      case BtConnectionState.connecting:
        return 'Connecting...';
      case BtConnectionState.disconnected:
        return 'Disconnected';
      case BtConnectionState.error:
        return 'Connection Error';
    }
  }
}
