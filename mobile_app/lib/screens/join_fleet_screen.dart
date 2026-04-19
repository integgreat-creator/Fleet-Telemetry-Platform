import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:vehicle_telemetry/providers/auth_provider.dart';
import 'package:vehicle_telemetry/services/supabase_service.dart';
import 'package:vehicle_telemetry/theme/app_colors.dart';

class JoinFleetScreen extends StatefulWidget {
  const JoinFleetScreen({super.key});

  @override
  State<JoinFleetScreen> createState() => _JoinFleetScreenState();
}

class _JoinFleetScreenState extends State<JoinFleetScreen> {
  final _supabaseService = SupabaseService();
  final _codeController  = TextEditingController();
  final _nameController  = TextEditingController();
  final _emailController = TextEditingController();
  final _phoneController = TextEditingController();
  final _formKey         = GlobalKey<FormState>();

  // Looked-up fleet after code validation
  Map<String, String>? _fleet;

  bool _lookingUp = false;
  bool _joining   = false;
  String? _lookupError;
  String? _joinError;

  @override
  void dispose() {
    _codeController.dispose();
    _nameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _lookupCode() async {
    final code = _codeController.text.trim();
    if (code.length != 6) {
      setState(() => _lookupError = 'Enter the full 6-character code');
      return;
    }
    setState(() { _lookingUp = true; _lookupError = null; _fleet = null; });
    final result = await _supabaseService.getFleetByJoinCode(code);
    setState(() {
      _lookingUp = false;
      if (result == null) {
        _lookupError = 'Invalid join code — check with your fleet manager';
      } else {
        _fleet = result;
      }
    });
  }

  Future<void> _joinFleet() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_fleet == null) return;

    setState(() { _joining = true; _joinError = null; });

    final ok = await _supabaseService.selfJoinFleet(
      fleetId: _fleet!['id']!,
      name:    _nameController.text.trim(),
      email:   _emailController.text.trim(),
      phone:   _phoneController.text.trim(),
    );

    if (!mounted) return;

    if (!ok) {
      setState(() {
        _joining    = false;
        _joinError  = 'Could not join fleet. You may already be a member, or the code has expired.';
      });
      return;
    }

    // Reload driver account so AuthProvider.isDriver becomes true
    await context.read<AuthProvider>().reloadDriverAccount();
    setState(() => _joining = false);
    // main.dart Consumer will now route to HomeScreen automatically
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0A0A0F),
      appBar: AppBar(
        backgroundColor: const Color(0xFF0A0A0F),
        title: const Text('Join a Fleet'),
        actions: [
          TextButton(
            onPressed: () => context.read<AuthProvider>().signOut(),
            child: const Text('Sign out', style: TextStyle(color: kMuted)),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── Header ────────────────────────────────────────────────────
            const SizedBox(height: 8),
            const Text(
              'Enter your fleet join code',
              style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            const Text(
              'Ask your fleet manager for the 6-character code shown in their Admin → Settings tab.',
              style: TextStyle(color: kMuted, fontSize: 14, height: 1.5),
            ),
            const SizedBox(height: 32),

            // ── Code input ────────────────────────────────────────────────
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                    controller: _codeController,
                    textCapitalization: TextCapitalization.characters,
                    maxLength: 6,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 6,
                    ),
                    decoration: InputDecoration(
                      hintText: 'XXXXXX',
                      hintStyle: TextStyle(color: Colors.white.withOpacity(0.2), letterSpacing: 6, fontSize: 22),
                      filled: true,
                      fillColor: const Color(0xFF1A1A2E),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.white.withOpacity(0.1)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(color: Colors.white.withOpacity(0.1)),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: const BorderSide(color: kPrimary),
                      ),
                      counterText: '',
                    ),
                    onSubmitted: (_) => _lookupCode(),
                    onChanged: (_) => setState(() { _lookupError = null; _fleet = null; }),
                  ),
                ),
                const SizedBox(width: 12),
                SizedBox(
                  height: 58,
                  child: ElevatedButton(
                    onPressed: _lookingUp ? null : _lookupCode,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: kPrimary,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                    child: _lookingUp
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Text('Verify'),
                  ),
                ),
              ],
            ),

            if (_lookupError != null) ...[
              const SizedBox(height: 8),
              Text(_lookupError!, style: const TextStyle(color: kDanger, fontSize: 13)),
            ],

            // ── Fleet confirmed ───────────────────────────────────────────
            if (_fleet != null) ...[
              const SizedBox(height: 20),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFF0D2137),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: kPrimary.withOpacity(0.4)),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle, color: kSuccess, size: 20),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Fleet found', style: TextStyle(color: kMuted, fontSize: 12)),
                          Text(
                            _fleet!['name']!,
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 28),

              // ── Driver details form ─────────────────────────────────────
              const Text(
                'Your details',
                style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 16),
              Form(
                key: _formKey,
                child: Column(
                  children: [
                    _buildField(_nameController,  'Full Name',     Icons.person,  TextInputType.name),
                    const SizedBox(height: 12),
                    _buildField(_emailController, 'Email',         Icons.email,   TextInputType.emailAddress, isEmail: true),
                    const SizedBox(height: 12),
                    _buildField(_phoneController, 'Phone (optional)', Icons.phone, TextInputType.phone, required: false),
                  ],
                ),
              ),

              if (_joinError != null) ...[
                const SizedBox(height: 12),
                Text(_joinError!, style: const TextStyle(color: kDanger, fontSize: 13)),
              ],

              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _joining ? null : _joinFleet,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: kPrimary,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: _joining
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text('Join ${_fleet!['name']!}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildField(
    TextEditingController controller,
    String label,
    IconData icon,
    TextInputType keyboardType, {
    bool isEmail   = false,
    bool required  = true,
  }) {
    return TextFormField(
      controller:   controller,
      keyboardType: keyboardType,
      style: const TextStyle(color: Colors.white),
      decoration: InputDecoration(
        labelText:     label,
        labelStyle:    const TextStyle(color: kMuted),
        prefixIcon:    Icon(icon, color: kMuted, size: 20),
        filled:        true,
        fillColor:     const Color(0xFF1A1A2E),
        border:        OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Colors.white.withOpacity(0.1))),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: Colors.white.withOpacity(0.1))),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: kPrimary)),
        errorBorder:   OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: kDanger)),
      ),
      validator: (v) {
        if (!required) return null;
        if (v == null || v.trim().isEmpty) return 'Required';
        if (isEmail && !v.contains('@')) return 'Enter a valid email';
        return null;
      },
    );
  }
}
