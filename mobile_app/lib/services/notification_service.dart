import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:vehicle_telemetry/models/sensor_data.dart';

class NotificationService {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;
  NotificationService._internal();

  final FlutterLocalNotificationsPlugin _notifications = FlutterLocalNotificationsPlugin();
  bool _initialized = false;

  /// Mirrors the "Threshold Alerts" toggle in the Profile tab.
  /// When false, [showThresholdAlert] is a no-op.
  bool alertsEnabled = true;

  Future<void> initialize() async {
    if (_initialized) return;

    const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosSettings = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );

    const initSettings = InitializationSettings(
      android: androidSettings,
      iOS: iosSettings,
    );

    await _notifications.initialize(
      initSettings,
      onDidReceiveNotificationResponse: _onNotificationTapped,
    );

    _initialized = true;
  }

  Future<bool> requestPermissions() async {
    final androidPlugin = _notifications.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();

    if (androidPlugin != null) {
      final granted = await androidPlugin.requestNotificationsPermission();
      return granted ?? false;
    }

    final iosPlugin = _notifications.resolvePlatformSpecificImplementation<
        IOSFlutterLocalNotificationsPlugin>();

    if (iosPlugin != null) {
      final granted = await iosPlugin.requestPermissions(
        alert: true,
        badge: true,
        sound: true,
      );
      return granted ?? false;
    }

    return true;
  }

  Future<void> showThresholdAlert(SensorData sensorData, String vehicleName) async {
    // Respect the user's toggle in the Profile tab
    if (!alertsEnabled) return;
    const androidDetails = AndroidNotificationDetails(
      'threshold_alerts',
      'Threshold Alerts',
      channelDescription: 'Alerts when sensor thresholds are exceeded',
      importance: Importance.high,
      priority: Priority.high,
      showWhen: true,
    );

    const iosDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
    );

    const notificationDetails = NotificationDetails(
      android: androidDetails,
      iOS: iosDetails,
    );

    await _notifications.show(
      sensorData.type.index,
      '⚠️ ${sensorData.name} Alert',
      '${sensorData.name} is ${sensorData.value.toStringAsFixed(1)} ${sensorData.unit} on $vehicleName',
      notificationDetails,
    );
  }

  Future<void> showConnectionAlert(String title, String message) async {
    const androidDetails = AndroidNotificationDetails(
      'connection_alerts',
      'Connection Alerts',
      channelDescription: 'Bluetooth connection status alerts',
      importance: Importance.defaultImportance,
      priority: Priority.defaultPriority,
    );

    const iosDetails = DarwinNotificationDetails();

    const notificationDetails = NotificationDetails(
      android: androidDetails,
      iOS: iosDetails,
    );

    await _notifications.show(
      999,
      title,
      message,
      notificationDetails,
    );
  }

  void _onNotificationTapped(NotificationResponse response) {
    print('Notification tapped: ${response.payload}');
  }

  Future<void> cancelAll() async {
    await _notifications.cancelAll();
  }

  Future<void> cancel(int id) async {
    await _notifications.cancel(id);
  }
}
