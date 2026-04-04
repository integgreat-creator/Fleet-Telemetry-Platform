import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_blue_plus/flutter_blue_plus.dart' as fbp;
import 'package:flutter_bluetooth_serial/flutter_bluetooth_serial.dart' as classic;
import '../bluetooth/bt_connection_state.dart';

enum ConnectionType { none, ble, classic }

class BluetoothService {
  static final BluetoothService _instance = BluetoothService._internal();
  factory BluetoothService() => _instance;
  BluetoothService._internal();

  // BLE state
  fbp.BluetoothDevice? _bleDevice;
  fbp.BluetoothCharacteristic? _bleWriteCharacteristic;

  // Classic state
  classic.BluetoothConnection? _classicConnection;
  classic.BluetoothDevice? _classicDevice;

  ConnectionType _connectionType = ConnectionType.none;

  final _connectionController = StreamController<BtConnectionState>.broadcast();
  final _dataController = StreamController<String>.broadcast();

  Stream<BtConnectionState> get connectionStateStream => _connectionController.stream;
  Stream<String> get dataStream => _dataController.stream;
  
  // Combined scan results
  final _combinedResultsController = StreamController<List<dynamic>>.broadcast();
  Stream<List<dynamic>> get combinedScanResults => _combinedResultsController.stream;

  List<fbp.ScanResult> _bleResults = [];
  List<classic.BluetoothDiscoveryResult> _classicResults = [];
  List<classic.BluetoothDevice> _bondedDevices = [];

  fbp.BluetoothDevice? get bleDevice => _bleDevice;
  classic.BluetoothDevice? get classicDevice => _classicDevice;
  ConnectionType get connectionType => _connectionType;

  dynamic get connectedDevice {
    if (_connectionType == ConnectionType.ble) return _bleDevice;
    if (_connectionType == ConnectionType.classic) return _classicDevice;
    return null;
  }

  String? get connectedDeviceName {
    if (_connectionType == ConnectionType.ble) return _bleDevice?.platformName;
    if (_connectionType == ConnectionType.classic) return _classicDevice?.name;
    return null;
  }

  void _updateCombinedResults() {
    final List<dynamic> combined = [];
    combined.addAll(_bondedDevices); // Classic bonded
    combined.addAll(_classicResults.map((r) => r.device)); // Classic discovered
    combined.addAll(_bleResults.map((r) => r.device)); // BLE
    _combinedResultsController.add(combined);
  }

  Future<void> startScan() async {
    // 1. Bonded devices (Classic)
    try {
      _bondedDevices = await classic.FlutterBluetoothSerial.instance.getBondedDevices();
    } catch (e) {
      print('Error getting bonded devices: $e');
    }

    // 2. BLE Scan
    await fbp.FlutterBluePlus.stopScan();
    fbp.FlutterBluePlus.scanResults.listen((results) {
      _bleResults = results;
      _updateCombinedResults();
    });
    
    await fbp.FlutterBluePlus.startScan(
      timeout: const Duration(seconds: 15),
      androidUsesFineLocation: true,
    );

    // 3. Classic Discovery
    classic.FlutterBluetoothSerial.instance.startDiscovery().listen((result) {
      final index = _classicResults.indexWhere((r) => r.device.address == result.device.address);
      if (index != -1) {
        _classicResults[index] = result;
      } else {
        _classicResults.add(result);
      }
      _updateCombinedResults();
    });

    _updateCombinedResults();
  }

  Future<void> stopScan() async {
    await fbp.FlutterBluePlus.stopScan();
    await classic.FlutterBluetoothSerial.instance.cancelDiscovery();
  }

  // 🔗 Connect BLE
  Future<bool> connectBle(fbp.BluetoothDevice device) async {
    try {
      _connectionController.add(BtConnectionState.connecting);
      await device.connect(autoConnect: false);
      _bleDevice = device;
      _connectionType = ConnectionType.ble;

      device.connectionState.listen((state) {
        if (state == fbp.BluetoothConnectionState.disconnected) {
          _cleanup();
        }
      });

      List<fbp.BluetoothService> services = await device.discoverServices();
      for (var service in services) {
        for (var characteristic in service.characteristics) {
          if (characteristic.properties.write || characteristic.properties.writeWithoutResponse) {
            _bleWriteCharacteristic = characteristic;
          }
          if (characteristic.properties.notify || characteristic.properties.indicate) {
            await characteristic.setNotifyValue(true);
            characteristic.lastValueStream.listen((data) {
              if (data.isNotEmpty) {
                final decoded = utf8.decode(data, allowMalformed: true);
                _dataController.add(decoded);
              }
            });
          }
        }
      }

      if (_bleWriteCharacteristic != null) {
        _connectionController.add(BtConnectionState.connected);
        return true;
      } else {
        await device.disconnect();
        _cleanup();
        return false;
      }
    } catch (e) {
      print('BLE Connection Error: $e');
      _cleanup();
      return false;
    }
  }

  // 🔗 Connect Classic
  Future<bool> connectClassic(classic.BluetoothDevice device) async {
    try {
      _connectionController.add(BtConnectionState.connecting);
      _classicConnection = await classic.BluetoothConnection.toAddress(device.address);
      _classicDevice = device;
      _connectionType = ConnectionType.classic;

      _classicConnection!.input?.listen((Uint8List data) {
        final decoded = utf8.decode(data, allowMalformed: true);
        _dataController.add(decoded);
      }).onDone(() {
        _cleanup();
      });

      _connectionController.add(BtConnectionState.connected);
      return true;
    } catch (e) {
      print('Classic Connection Error: $e');
      _cleanup();
      return false;
    }
  }

  Future<void> sendCommand(String command) async {
    final fullCommand = "$command\r";
    if (_connectionType == ConnectionType.ble && _bleWriteCharacteristic != null) {
      await _bleWriteCharacteristic!.write(utf8.encode(fullCommand), withoutResponse: false);
    } else if (_connectionType == ConnectionType.classic && _classicConnection != null) {
      _classicConnection!.output.add(utf8.encode(fullCommand));
      await _classicConnection!.output.allSent;
    }
  }

  Future<void> disconnect() async {
    if (_connectionType == ConnectionType.ble) {
      await _bleDevice?.disconnect();
    } else if (_connectionType == ConnectionType.classic) {
      await _classicConnection?.close();
    }
    _cleanup();
  }

  void _cleanup() {
    _bleDevice = null;
    _bleWriteCharacteristic = null;
    _classicConnection = null;
    _classicDevice = null;
    _connectionType = ConnectionType.none;
    _connectionController.add(BtConnectionState.disconnected);
  }
}
