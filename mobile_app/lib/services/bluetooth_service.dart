import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart' as fbp;
import 'package:flutter_bluetooth_serial/flutter_bluetooth_serial.dart' as classic;
import '../bluetooth/bt_connection_state.dart';

enum ConnectionType { none, ble, classic }

class BluetoothService {
  static final BluetoothService _instance = BluetoothService._internal();
  factory BluetoothService() => _instance;
  BluetoothService._internal();

  // BLE state
  fbp.BluetoothDevice?         _bleDevice;
  fbp.BluetoothCharacteristic? _bleWriteCharacteristic;

  // Classic state
  classic.BluetoothConnection? _classicConnection;
  classic.BluetoothDevice?     _classicDevice;

  ConnectionType _connectionType = ConnectionType.none;

  final _connectionController = StreamController<BtConnectionState>.broadcast();
  final _dataController       = StreamController<String>.broadcast();

  Stream<BtConnectionState> get connectionStateStream => _connectionController.stream;
  Stream<String>            get dataStream             => _dataController.stream;

  // ── Scan state ──────────────────────────────────────────────────────────────
  final _combinedResultsController = StreamController<List<dynamic>>.broadcast();
  Stream<List<dynamic>> get combinedScanResults => _combinedResultsController.stream;

  List<fbp.ScanResult>                    _bleResults     = [];
  List<classic.BluetoothDiscoveryResult>  _classicResults = [];
  List<classic.BluetoothDevice>           _bondedDevices  = [];

  // ── Accessors ───────────────────────────────────────────────────────────────
  fbp.BluetoothDevice?    get bleDevice     => _bleDevice;
  classic.BluetoothDevice? get classicDevice => _classicDevice;
  ConnectionType          get connectionType => _connectionType;

  dynamic get connectedDevice {
    if (_connectionType == ConnectionType.ble)     return _bleDevice;
    if (_connectionType == ConnectionType.classic) return _classicDevice;
    return null;
  }

  String? get connectedDeviceName {
    if (_connectionType == ConnectionType.ble)     return _bleDevice?.platformName;
    if (_connectionType == ConnectionType.classic) return _classicDevice?.name;
    return null;
  }

  // ── Scan result deduplication ───────────────────────────────────────────────
  /// Normalised key: uppercase trimmed name (address is not reliable across
  /// BLE and Classic for the same physical hardware).
  String _nameKey(String? name) => (name ?? '').toUpperCase().trim();

  /// Merges bonded, Classic-discovered and BLE-discovered results.
  /// The same physical OBD adapter can appear as BOTH Classic BT and BLE
  /// (dual-mode devices). We deduplicate by device name and prefer the Classic
  /// entry so OBD-II ELM327 adapters are connected via the correct SPP channel.
  void _updateCombinedResults() {
    final seen    = <String>{};
    final combined = <dynamic>[];

    // Priority 1 — bonded Classic devices (already paired, most reliable)
    for (final device in _bondedDevices) {
      final key = _nameKey(device.name);
      if (key.isNotEmpty && seen.add(key)) combined.add(device);
    }

    // Priority 2 — Classic-discovered (not yet bonded)
    for (final result in _classicResults) {
      final key = _nameKey(result.device.name);
      if (key.isNotEmpty && seen.add(key)) combined.add(result.device);
    }

    // Priority 3 — BLE devices (only if name not already covered by Classic)
    for (final result in _bleResults) {
      final key = _nameKey(result.device.platformName);
      if (key.isNotEmpty && seen.add(key)) combined.add(result.device);
    }

    _combinedResultsController.add(combined);
  }

  // ── Scanning ────────────────────────────────────────────────────────────────
  Future<void> startScan() async {
    _bleResults     = [];
    _classicResults = [];

    // 1. Bonded devices (Classic) — available immediately without discovery
    try {
      _bondedDevices =
          await classic.FlutterBluetoothSerial.instance.getBondedDevices();
    } catch (e) {
      debugPrint('Error getting bonded devices: $e');
      _bondedDevices = [];
    }
    _updateCombinedResults();

    // 2. BLE scan
    try {
      await fbp.FlutterBluePlus.stopScan();
      fbp.FlutterBluePlus.scanResults.listen((results) {
        _bleResults = results;
        _updateCombinedResults();
      });
      await fbp.FlutterBluePlus.startScan(
        timeout: const Duration(seconds: 15),
        androidUsesFineLocation: true,
      );
    } catch (e) {
      debugPrint('BLE scan error: $e');
    }

    // 3. Classic discovery
    try {
      classic.FlutterBluetoothSerial.instance.startDiscovery().listen((result) {
        final index = _classicResults
            .indexWhere((r) => r.device.address == result.device.address);
        if (index != -1) {
          _classicResults[index] = result;
        } else {
          _classicResults.add(result);
        }
        _updateCombinedResults();
      });
    } catch (e) {
      debugPrint('Classic discovery error: $e');
    }
  }

  Future<void> stopScan() async {
    try { await fbp.FlutterBluePlus.stopScan(); } catch (_) {}
    try { await classic.FlutterBluetoothSerial.instance.cancelDiscovery(); } catch (_) {}
  }

  // ── BLE connection ──────────────────────────────────────────────────────────
  Future<bool> connectBle(fbp.BluetoothDevice device) async {
    try {
      _connectionController.add(BtConnectionState.connecting);
      await device.connect(autoConnect: false, timeout: const Duration(seconds: 15));
      _bleDevice      = device;
      _connectionType = ConnectionType.ble;

      device.connectionState.listen((state) {
        if (state == fbp.BluetoothConnectionState.disconnected) {
          _cleanupDisconnected();
        }
      });

      final services = await device.discoverServices();
      for (final service in services) {
        for (final characteristic in service.characteristics) {
          if (characteristic.properties.write ||
              characteristic.properties.writeWithoutResponse) {
            _bleWriteCharacteristic = characteristic;
          }
          if (characteristic.properties.notify ||
              characteristic.properties.indicate) {
            await characteristic.setNotifyValue(true);
            characteristic.lastValueStream.listen((data) {
              if (data.isNotEmpty) {
                _dataController.add(utf8.decode(data, allowMalformed: true));
              }
            });
          }
        }
      }

      if (_bleWriteCharacteristic != null) {
        _connectionController.add(BtConnectionState.connected);
        return true;
      }

      // No writable characteristic — not a compatible OBD-II BLE device
      await device.disconnect();
      _cleanupError();
      return false;
    } catch (e) {
      debugPrint('BLE connection error: $e');
      _cleanupError();
      return false;
    }
  }

  // ── Classic Bluetooth connection ─────────────────────────────────────────────
  /// Connects to a Classic BT (SPP/RFCOMM) OBD-II adapter.
  ///
  /// Most ELM327 adapters use Classic BT and **must be paired (bonded) first**.
  /// If the device is not yet bonded this method triggers the Android pairing
  /// dialog before attempting the RFCOMM connection.
  Future<bool> connectClassic(classic.BluetoothDevice device) async {
    try {
      _connectionController.add(BtConnectionState.connecting);

      // ── Step 1: Bond (pair) if not already done ───────────────────────────
      if (device.isBonded != true) {
        debugPrint('Classic BT: device not bonded — requesting bond…');
        final bondResult = await classic.FlutterBluetoothSerial.instance
            .bondDeviceAtAddress(device.address)
            .timeout(
              const Duration(seconds: 30),
              onTimeout: () {
                debugPrint('Classic BT: bonding timed out');
                return null;
              },
            );

        if (bondResult != true) {
          debugPrint('Classic BT: bonding failed or was rejected');
          _cleanupError();
          return false;
        }
        debugPrint('Classic BT: bonding succeeded');
      }

      // ── Step 2: RFCOMM / SPP connection ──────────────────────────────────
      _classicConnection = await classic.BluetoothConnection.toAddress(
        device.address,
      ).timeout(
        const Duration(seconds: 15),
        onTimeout: () {
          throw TimeoutException('Classic BT connection timed out after 15s');
        },
      );

      _classicDevice  = device;
      _connectionType = ConnectionType.classic;

      // Listen for incoming OBD data
      _classicConnection!.input?.listen(
        (Uint8List data) {
          _dataController.add(utf8.decode(data, allowMalformed: true));
        },
        onDone: _cleanupDisconnected,
        onError: (_) => _cleanupDisconnected(),
      );

      _connectionController.add(BtConnectionState.connected);
      return true;
    } on TimeoutException catch (e) {
      debugPrint('Classic BT timeout: $e');
      _cleanupError();
      return false;
    } catch (e) {
      debugPrint('Classic BT connection error: $e');
      _cleanupError();
      return false;
    }
  }

  // ── Send OBD command ────────────────────────────────────────────────────────
  Future<void> sendCommand(String command) async {
    final bytes = utf8.encode('$command\r');
    if (_connectionType == ConnectionType.ble &&
        _bleWriteCharacteristic != null) {
      await _bleWriteCharacteristic!.write(bytes, withoutResponse: false);
    } else if (_connectionType == ConnectionType.classic &&
        _classicConnection != null) {
      _classicConnection!.output.add(bytes);
      await _classicConnection!.output.allSent;
    }
  }

  // ── Disconnect ──────────────────────────────────────────────────────────────
  Future<void> disconnect() async {
    if (_connectionType == ConnectionType.ble) {
      try { await _bleDevice?.disconnect(); } catch (_) {}
    } else if (_connectionType == ConnectionType.classic) {
      try { await _classicConnection?.close(); } catch (_) {}
    }
    _cleanupDisconnected();
  }

  // ── Internal cleanup ────────────────────────────────────────────────────────

  /// Normal disconnect — emits disconnected state.
  void _cleanupDisconnected() {
    _reset();
    _connectionController.add(BtConnectionState.disconnected);
  }

  /// Failed connection attempt — emits error state so the UI shows "Try Again".
  void _cleanupError() {
    _reset();
    _connectionController.add(BtConnectionState.error);
  }

  void _reset() {
    _bleDevice               = null;
    _bleWriteCharacteristic  = null;
    _classicConnection       = null;
    _classicDevice           = null;
    _connectionType          = ConnectionType.none;
  }
}
