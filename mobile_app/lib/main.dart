import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:vehicle_telemetry/config/app_colors.dart';
import 'package:vehicle_telemetry/config/supabase_config.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/connectivity_provider.dart';
import 'package:vehicle_telemetry/providers/invite_provider.dart';
import 'package:vehicle_telemetry/providers/sensor_provider.dart';
import 'package:vehicle_telemetry/providers/subscription_provider.dart';
import 'package:vehicle_telemetry/providers/vehicle_provider.dart';
import 'package:vehicle_telemetry/screens/home_screen.dart';
import 'package:vehicle_telemetry/screens/invite_accept_screen.dart';
import 'package:vehicle_telemetry/screens/login_screen.dart';
import 'package:vehicle_telemetry/services/notification_service.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await dotenv.load(fileName: '.env');

  await SupabaseConfig.initialize();

  final notificationService = NotificationService();
  await notificationService.initialize();
  await notificationService.requestPermissions();

  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Force the status bar icons to be light (white) on the dark background
    SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
    ));

    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthProvider()),
        ChangeNotifierProvider(create: (_) => VehicleProvider()),
        ChangeNotifierProvider(create: (_) => SensorProvider()),
        ChangeNotifierProvider(create: (_) => InviteProvider()),
        ChangeNotifierProvider(create: (_) => ConnectivityProvider()),
        ChangeNotifierProvider(create: (_) => SubscriptionProvider()),
      ],
      child: MaterialApp(
        title: 'FTPGo',
        debugShowCheckedModeBanner: false,

        // ── Dark-navy brand theme (always dark) ─────────────────
        theme: _buildTheme(),
        darkTheme: _buildTheme(),
        themeMode: ThemeMode.dark,

        home: const _AppHome(),
      ),
    );
  }

  static ThemeData _buildTheme() {
    return ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,

      // Colour scheme seeded from the brand blue
      colorScheme: ColorScheme.fromSeed(
        seedColor: AppColors.accentBlue,
        brightness: Brightness.dark,
        surface: AppColors.bgCard,
        onSurface: AppColors.textPrimary,
        primary: AppColors.accentBlue,
        onPrimary: AppColors.textPrimary,
      ),

      scaffoldBackgroundColor: AppColors.bgPrimary,

      // AppBar
      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
        scrolledUnderElevation: 0,
        backgroundColor: AppColors.bgSurface,
        foregroundColor: AppColors.textPrimary,
        titleTextStyle: TextStyle(
          color: AppColors.textPrimary,
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.3,
        ),
        iconTheme: IconThemeData(color: AppColors.textPrimary),
      ),

      // Cards
      cardTheme: CardThemeData(
        elevation: 0,
        color: AppColors.bgCard,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
        ),
        margin: EdgeInsets.zero,
      ),

      // List tiles
      listTileTheme: const ListTileThemeData(
        tileColor: Colors.transparent,
        textColor: AppColors.textPrimary,
        iconColor: AppColors.accentBlue,
      ),

      // Divider
      dividerColor: AppColors.divider,
      dividerTheme: const DividerThemeData(
        color: AppColors.divider,
        space: 1,
        thickness: 1,
      ),

      // Input fields
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.bgCardAlt,
        labelStyle: const TextStyle(color: AppColors.textSecondary),
        hintStyle: const TextStyle(color: AppColors.textLabel),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: AppColors.divider),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: AppColors.divider),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: AppColors.accentBlue, width: 1.5),
        ),
      ),

      // Elevated buttons
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          elevation: 0,
          backgroundColor: AppColors.accentBlue,
          foregroundColor: AppColors.textPrimary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
          ),
        ),
      ),

      // Bottom navigation bar
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AppColors.bgSurface,
        selectedItemColor: AppColors.accentBlue,
        unselectedItemColor: AppColors.textLabel,
        elevation: 0,
        type: BottomNavigationBarType.fixed,
        selectedLabelStyle: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
        unselectedLabelStyle: TextStyle(fontSize: 11),
      ),

      // Dialogs
      dialogTheme: DialogThemeData(
        backgroundColor: AppColors.bgCardAlt,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),

      // Popup menus
      popupMenuTheme: const PopupMenuThemeData(
        color: AppColors.bgCardAlt,
        textStyle: TextStyle(color: AppColors.textPrimary),
      ),

      // Snackbar
      snackBarTheme: SnackBarThemeData(
        backgroundColor: AppColors.bgCardAlt,
        contentTextStyle: const TextStyle(color: AppColors.textPrimary),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}

/// Root widget that owns the app_links deep-link subscription.
/// Lives below [MultiProvider] so it can access all providers via context.
class _AppHome extends StatefulWidget {
  const _AppHome({Key? key}) : super(key: key);

  @override
  State<_AppHome> createState() => _AppHomeState();
}

class _AppHomeState extends State<_AppHome> {
  late final AppLinks _appLinks;

  @override
  void initState() {
    super.initState();
    _initDeepLinks();
  }

  Future<void> _initDeepLinks() async {
    _appLinks = AppLinks();

    // Cold-start: app opened directly from the vehiclesense:// link
    try {
      final initialUri = await _appLinks.getInitialLink();
      if (initialUri != null) _handleDeepLink(initialUri);
    } catch (_) {
      // No initial link — normal launch
    }

    // Warm/hot start: link tapped while app is running
    _appLinks.uriLinkStream.listen(
      _handleDeepLink,
      onError: (_) {},
    );
  }

  /// Parses `vehiclesense://join?token=<token>` and stores the token
  /// in [InviteProvider] so the router redirects to [InviteAcceptScreen].
  void _handleDeepLink(Uri uri) {
    if (uri.scheme == 'vehiclesense' && uri.host == 'join') {
      final token = uri.queryParameters['token'];
      if (token != null && token.isNotEmpty) {
        context.read<InviteProvider>().setPendingToken(token);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Consumer2<AuthProvider, InviteProvider>(
      builder: (context, auth, invite, _) {
        // Highest priority: a pending invite token → accept screen
        // (works whether or not the driver is signed in)
        if (invite.hasPendingInvite) {
          return InviteAcceptScreen(token: invite.pendingToken!);
        }

        // Authenticated driver / fleet manager → main app
        if (auth.isAuthenticated) {
          return const HomeScreen();
        }

        // Not authenticated → login
        return const LoginScreen();
      },
    );
  }
}
