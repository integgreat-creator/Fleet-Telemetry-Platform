import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/providers/invite_provider.dart';

/// Driver-only login screen.
/// Drivers sign in with email + password credentials given by the fleet manager,
/// OR scan a QR invite to join a fleet without an account.
class LoginScreen extends StatefulWidget {
  const LoginScreen({Key? key}) : super(key: key);

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _identifierController = TextEditingController(); // email or phone
  final _passwordController   = TextEditingController();
  final _formKey              = GlobalKey<FormState>();
  bool  _obscurePassword      = true;
  bool  _usePhone             = false;   // MOB-3: toggle email/phone

  @override
  void dispose() {
    _identifierController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    if (!_formKey.currentState!.validate()) return;
    final auth  = context.read<AuthProvider>();
    final value = _identifierController.text.trim();
    if (_usePhone) {
      await auth.signInWithPhone(value, _passwordController.text);
    } else {
      await auth.signIn(value, _passwordController.text);
    }
    // Navigation is handled by the Consumer in main.dart
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Form(
              key: _formKey,
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.directions_car, size: 72, color: Colors.blue),
                  const SizedBox(height: 16),
                  Text(
                    'VehicleSense',
                    style: Theme.of(context)
                        .textTheme
                        .headlineMedium
                        ?.copyWith(fontWeight: FontWeight.bold, color: Colors.blue),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Driver Sign In',
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: Colors.grey),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 40),

                  // Email / Phone toggle row
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text(
                        _usePhone ? 'Use email instead' : 'Use phone instead',
                        style: TextStyle(
                          color: Colors.blue.shade300,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Switch(
                        value: _usePhone,
                        onChanged: (v) {
                          setState(() {
                            _usePhone = v;
                            _identifierController.clear();
                          });
                          context.read<AuthProvider>().clearError();
                        },
                        activeColor: Colors.blue,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),

                  // Email or Phone field
                  TextFormField(
                    controller: _identifierController,
                    decoration: InputDecoration(
                      labelText:  _usePhone ? 'Phone Number' : 'Email',
                      prefixIcon: Icon(
                        _usePhone ? Icons.phone : Icons.email,
                      ),
                      hintText: _usePhone ? '+91 98765 43210' : null,
                    ),
                    keyboardType: _usePhone
                        ? TextInputType.phone
                        : TextInputType.emailAddress,
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) {
                        return _usePhone
                            ? 'Phone number is required'
                            : 'Email is required';
                      }
                      if (!_usePhone && !v.contains('@')) {
                        return 'Enter a valid email';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 16),

                  // Password
                  TextFormField(
                    controller: _passwordController,
                    decoration: InputDecoration(
                      labelText:  'Password',
                      prefixIcon: const Icon(Icons.lock),
                      suffixIcon: IconButton(
                        icon: Icon(_obscurePassword
                            ? Icons.visibility_off
                            : Icons.visibility),
                        onPressed: () =>
                            setState(() => _obscurePassword = !_obscurePassword),
                      ),
                    ),
                    obscureText: _obscurePassword,
                    validator: (v) {
                      if (v == null || v.isEmpty) return 'Password is required';
                      if (v.length < 6) return 'Password must be at least 6 characters';
                      return null;
                    },
                  ),
                  const SizedBox(height: 24),

                  // Error message
                  Consumer<AuthProvider>(
                    builder: (context, auth, _) {
                      if (auth.errorMessage == null) return const SizedBox.shrink();
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Text(
                          auth.errorMessage!,
                          style: const TextStyle(color: Colors.red, fontSize: 13),
                          textAlign: TextAlign.center,
                        ),
                      );
                    },
                  ),

                  // Sign In button
                  Consumer<AuthProvider>(
                    builder: (context, auth, _) => ElevatedButton(
                      onPressed: auth.isLoading ? null : _signIn,
                      style: ElevatedButton.styleFrom(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      child: auth.isLoading
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text(
                              'Sign In',
                              style: TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.bold),
                            ),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Divider
                  Row(
                    children: [
                      const Expanded(child: Divider()),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Text('or',
                            style: TextStyle(color: Colors.grey.shade500)),
                      ),
                      const Expanded(child: Divider()),
                    ],
                  ),
                  const SizedBox(height: 16),

                  // QR Invite button
                  OutlinedButton.icon(
                    onPressed: () => _scanQr(context),
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('Scan QR Code'),
                    style: OutlinedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                  ),

                  const SizedBox(height: 32),
                  Text(
                    'Credentials are provided by your fleet manager.\nDrivers cannot self-register.',
                    style: TextStyle(
                      color: Colors.grey.shade500,
                      fontSize: 12,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _scanQr(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFF1A1A2E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (sheetCtx) => _QrScannerSheet(
        onTokenDetected: (raw) {
          Navigator.of(sheetCtx).pop();
          // vehiclesense://auth?token=<one-time-token>  → exchange for email + auto-login
          // vehiclesense://join?token=<invite-token>    → existing QR invite flow
          // vehiclesense://auth?data=<base64>           → legacy format
          if (raw.startsWith('vehiclesense://auth?token=')) {
            final token = raw.substring('vehiclesense://auth?token='.length);
            _exchangeOneTimeToken(context, token);
          } else {
            context.read<InviteProvider>().setPendingToken(raw);
          }
        },
        onManualEntry: () {
          Navigator.of(sheetCtx).pop();
          _showManualTokenDialog(context);
        },
      ),
    );
  }

  /// Exchanges a one-time token from the welcome email QR for an email address,
  /// then auto-fills the email field so the driver just needs to enter password.
  Future<void> _exchangeOneTimeToken(BuildContext context, String token) async {
    try {
      final supabaseUrl  = const String.fromEnvironment('SUPABASE_URL',
          defaultValue: '');
      final anonKey      = const String.fromEnvironment('SUPABASE_ANON_KEY',
          defaultValue: '');

      // Read from dotenv via the existing supabase config
      final client = Supabase.instance.client;
      final res = await client.functions.invoke(
        'driver-management',
        body: {'action': 'exchange_token', 'token': token},
      );

      final email = res.data?['email'] as String?;
      if (email != null && email.isNotEmpty && mounted) {
        setState(() {
          _usePhone = false;
          _identifierController.text = email;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Email pre-filled from QR — enter your password to sign in'),
            backgroundColor: const Color(0xFF00BFA5),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not read QR code — enter your credentials manually'),
            backgroundColor: Colors.red,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  void _showManualTokenDialog(BuildContext context) async {
    final controller = TextEditingController();
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Enter Invite Token'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'Ask your fleet manager to share the invite link. '
              'Or paste the token from the link here.',
              style: TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              decoration: const InputDecoration(
                hintText: 'Paste token here',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () {
              final token = controller.text.trim();
              if (token.isNotEmpty) {
                Navigator.pop(ctx);
                context.read<InviteProvider>().setPendingToken(token);
              }
            },
            child: const Text('Join'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// QR Scanner bottom-sheet widget
// ---------------------------------------------------------------------------

class _QrScannerSheet extends StatefulWidget {
  final void Function(String token) onTokenDetected;
  final VoidCallback onManualEntry;

  const _QrScannerSheet({
    required this.onTokenDetected,
    required this.onManualEntry,
  });

  @override
  State<_QrScannerSheet> createState() => _QrScannerSheetState();
}

class _QrScannerSheetState extends State<_QrScannerSheet> {
  final MobileScannerController _scannerController = MobileScannerController();
  bool _scanned = false;
  bool _permissionDenied = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_scanned) return;

    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;

      String? token;

      // Pattern 1: vehiclesense://join?token=<token>
      if (raw.startsWith('vehiclesense://join?token=')) {
        token = raw.substring('vehiclesense://join?token='.length);
      }
      // Pattern 2: vehiclesense://auth?data=<base64url>
      else if (raw.startsWith('vehiclesense://auth?data=')) {
        token = raw.substring('vehiclesense://auth?data='.length);
      }

      if (token != null && token.isNotEmpty) {
        _scanned = true;
        widget.onTokenDetected(token);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final screenHeight = MediaQuery.of(context).size.height;

    return SizedBox(
      height: screenHeight * 0.85,
      child: Column(
        children: [
          // Handle bar
          Container(
            margin: const EdgeInsets.only(top: 10, bottom: 16),
            width: 40,
            height: 4,
            decoration: BoxDecoration(
              color: Colors.white24,
              borderRadius: BorderRadius.circular(2),
            ),
          ),

          // Title
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 24),
            child: Row(
              children: [
                Icon(Icons.qr_code_scanner, color: Color(0xFF00BFA5), size: 22),
                SizedBox(width: 10),
                Text(
                  'Scan QR Code',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              'Scan the QR code from your welcome email to pre-fill your login, or scan a fleet invite QR.',
              style: TextStyle(color: Colors.grey[400], fontSize: 13),
            ),
          ),
          const SizedBox(height: 16),

          // Scanner viewport
          Expanded(
            child: _permissionDenied
                ? _buildPermissionDenied()
                : ClipRRect(
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(12),
                      bottom: Radius.circular(12),
                    ),
                    child: Stack(
                      children: [
                        MobileScanner(
                          controller: _scannerController,
                          onDetect: _onDetect,
                          errorBuilder: (context, error, child) {
                            // Camera permission denied or unavailable
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              if (mounted) {
                                setState(() => _permissionDenied = true);
                              }
                            });
                            return const SizedBox.shrink();
                          },
                        ),
                        // Scan-frame overlay
                        Center(
                          child: Container(
                            width: 220,
                            height: 220,
                            decoration: BoxDecoration(
                              border: Border.all(
                                color: const Color(0xFF00BFA5),
                                width: 2.5,
                              ),
                              borderRadius: BorderRadius.circular(16),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
          ),

          const SizedBox(height: 16),

          // Manual entry fallback
          TextButton.icon(
            onPressed: widget.onManualEntry,
            icon: Icon(Icons.keyboard, color: Colors.grey[400], size: 18),
            label: Text(
              'Enter token manually',
              style: TextStyle(color: Colors.grey[400], fontSize: 14),
            ),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }

  Widget _buildPermissionDenied() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.no_photography_outlined, size: 56, color: Colors.grey[600]),
          const SizedBox(height: 16),
          Text(
            'Camera permission is required to scan QR codes.',
            style: TextStyle(color: Colors.grey[400], fontSize: 14),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 20),
          ElevatedButton.icon(
            onPressed: () async {
              await _scannerController.start();
              if (mounted) setState(() => _permissionDenied = false);
            },
            icon: const Icon(Icons.camera_alt),
            label: const Text('Grant Permission'),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF00BFA5),
            ),
          ),
        ],
      ),
    );
  }
}
