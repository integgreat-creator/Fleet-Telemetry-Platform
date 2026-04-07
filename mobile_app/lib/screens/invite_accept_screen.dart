import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:vehicle_telemetry/providers/invite_provider.dart';

class InviteAcceptScreen extends StatefulWidget {
  final String token;
  const InviteAcceptScreen({Key? key, required this.token}) : super(key: key);

  @override
  State<InviteAcceptScreen> createState() => _InviteAcceptScreenState();
}

class _InviteAcceptScreenState extends State<InviteAcceptScreen> {
  // Invite details fetched from server
  String? _fleetName;
  String? _vehicleName;
  bool _loadingInvite = true;
  String? _loadError;

  bool _submitting = false;

  String get _supabaseUrl => dotenv.env['SUPABASE_URL'] ?? '';
  String get _anonKey     => dotenv.env['SUPABASE_ANON_KEY'] ?? '';

  @override
  void initState() {
    super.initState();
    _fetchInviteDetails();
  }

  Future<void> _fetchInviteDetails() async {
    try {
      final uri = Uri.parse(
        '$_supabaseUrl/functions/v1/invite-api?action=get&token=${widget.token}',
      );
      final res = await http.get(uri, headers: {
        'apikey':        _anonKey,
        'Authorization': 'Bearer $_anonKey',
      });

      final body = jsonDecode(res.body) as Map<String, dynamic>;

      if (res.statusCode != 200) {
        setState(() {
          _loadError     = body['error'] as String? ?? 'Invalid or expired invite';
          _loadingInvite = false;
        });
        return;
      }

      setState(() {
        _fleetName     = body['fleet_name'] as String?;
        _vehicleName   = body['vehicle_name'] as String?;
        _loadingInvite = false;
      });
    } catch (e) {
      setState(() {
        _loadError     = 'Could not reach server. Check your internet connection.';
        _loadingInvite = false;
      });
    }
  }

  Future<void> _acceptInvite() async {
    setState(() => _submitting = true);

    try {
      final uri = Uri.parse('$_supabaseUrl/functions/v1/invite-api');
      final res = await http.post(
        uri,
        headers: {
          'Content-Type':  'application/json',
          'apikey':        _anonKey,
          'Authorization': 'Bearer $_anonKey',
        },
        body: jsonEncode({
          'action': 'accept',
          'token':  widget.token,
        }),
      );

      final body = jsonDecode(res.body) as Map<String, dynamic>;

      if (res.statusCode != 200) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(body['error'] as String? ?? 'Failed to join fleet'),
            backgroundColor: Colors.red[700],
            behavior: SnackBarBehavior.floating,
          ));
        }
        setState(() => _submitting = false);
        return;
      }

      final fleetId      = body['fleet_id']   as String?;
      final sessionData  = body['session']    as Map<String, dynamic>?;
      final accessToken  = sessionData?['access_token']  as String?;
      final refreshToken = sessionData?['refresh_token'] as String?;

      // Persist fleet_id
      final prefs = await SharedPreferences.getInstance();
      if (fleetId != null) {
        await prefs.setString('fleet_id', fleetId);
      }

      // Set Supabase session from returned tokens
      if (accessToken != null && refreshToken != null) {
        await Supabase.instance.client.auth.setSession(accessToken);
        // Persist the refresh token separately so the session survives app restarts
        final prefs2 = await SharedPreferences.getInstance();
        await prefs2.setString('refresh_token', refreshToken);
      }

      if (!mounted) return;

      // Clear the pending invite token
      context.read<InviteProvider>().clearToken();

      // Navigate to HomeScreen
      Navigator.pushReplacementNamed(context, '/home');
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Unexpected error: $e'),
          backgroundColor: Colors.red[700],
          behavior: SnackBarBehavior.floating,
        ));
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF12121F),
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A2E),
        elevation: 0,
        title: const Text(
          'Join Fleet',
          style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
        ),
        leading: BackButton(
          color: Colors.white,
          onPressed: () {
            context.read<InviteProvider>().clearToken();
            Navigator.of(context).pop();
          },
        ),
      ),
      body: SafeArea(
        child: _loadingInvite
            ? const Center(
                child: CircularProgressIndicator(
                  color: Color(0xFF00BFA5),
                ),
              )
            : _loadError != null
                ? _buildError()
                : _buildContent(),
      ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 80,
              height: 80,
              decoration: BoxDecoration(
                color: Colors.red.withOpacity(0.15),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.error_outline, size: 44, color: Colors.red),
            ),
            const SizedBox(height: 20),
            Text(
              _loadError!,
              style: const TextStyle(color: Colors.red, fontSize: 15),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 28),
            OutlinedButton.icon(
              onPressed: () {
                context.read<InviteProvider>().clearToken();
                Navigator.of(context).pop();
              },
              icon: const Icon(Icons.arrow_back, color: Colors.white70),
              label: const Text(
                'Go Back',
                style: TextStyle(color: Colors.white70),
              ),
              style: OutlinedButton.styleFrom(
                side: const BorderSide(color: Colors.white24),
                padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContent() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 16),

          // VehicleSense branding header
          Center(
            child: Column(
              children: [
                Container(
                  width: 72,
                  height: 72,
                  decoration: BoxDecoration(
                    color: const Color(0xFF00BFA5).withOpacity(0.15),
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: const Color(0xFF00BFA5).withOpacity(0.4),
                      width: 2,
                    ),
                  ),
                  child: const Icon(
                    Icons.directions_car,
                    size: 36,
                    color: Color(0xFF00BFA5),
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'VehicleSense',
                  style: TextStyle(
                    color: Color(0xFF00BFA5),
                    fontSize: 22,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 0.5,
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 32),

          // Invite card
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: const Color(0xFF1E1E2E),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: const Color(0xFF00BFA5).withOpacity(0.3),
              ),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF00BFA5).withOpacity(0.08),
                  blurRadius: 16,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(
                      Icons.mail_outline,
                      color: Color(0xFF00BFA5),
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    const Text(
                      "Fleet Invitation",
                      style: TextStyle(
                        color: Color(0xFF00BFA5),
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _inviteRow(
                  icon: Icons.business,
                  label: 'Fleet',
                  value: _fleetName ?? '—',
                ),
                const SizedBox(height: 10),
                _inviteRow(
                  icon: Icons.directions_car_outlined,
                  label: 'Assigned Vehicle',
                  value: _vehicleName ?? '—',
                ),
              ],
            ),
          ),

          const SizedBox(height: 24),

          // Info text
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.04),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Icon(Icons.info_outline, color: Colors.grey[500], size: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Accepting this invitation will add you to the fleet and grant access to telemetry features.',
                    style: TextStyle(
                      color: Colors.grey[400],
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 32),

          // Accept button
          ElevatedButton(
            onPressed: _submitting ? null : _acceptInvite,
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF00BFA5),
              disabledBackgroundColor: const Color(0xFF00BFA5).withOpacity(0.4),
              padding: const EdgeInsets.symmetric(vertical: 16),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              elevation: 0,
            ),
            child: _submitting
                ? const SizedBox(
                    height: 22,
                    width: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : const Text(
                    'Accept & Join Fleet',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: Colors.white,
                      letterSpacing: 0.3,
                    ),
                  ),
          ),

          const SizedBox(height: 12),

          // Decline / go back
          TextButton(
            onPressed: _submitting
                ? null
                : () {
                    context.read<InviteProvider>().clearToken();
                    Navigator.of(context).pop();
                  },
            child: Text(
              'Decline',
              style: TextStyle(color: Colors.grey[500], fontSize: 14),
            ),
          ),
        ],
      ),
    );
  }

  Widget _inviteRow({
    required IconData icon,
    required String label,
    required String value,
  }) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: Colors.grey[500], size: 18),
        const SizedBox(width: 10),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: TextStyle(
                color: Colors.grey[500],
                fontSize: 11,
                fontWeight: FontWeight.w500,
                letterSpacing: 0.5,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              value,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ],
    );
  }
}
